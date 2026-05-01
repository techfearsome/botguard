const express = require('express');
const router = express.Router();

const { Click, Conversion } = require('../models');
const logger = require('../lib/logger');

/**
 * GET/POST /cb/postback
 *
 * Server-to-server conversion postback. Use this from your CRM, payment processor,
 * or affiliate network to attribute conversions reliably (no ad-blockers, no cookie loss).
 *
 * Required: cid (click_id)
 * Optional: value, currency, event, txn_id
 */
async function handlePostback(req, res) {
  // Postbacks should never be cached - each one represents a unique conversion event
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('CDN-Cache-Control', 'no-store');

  const data = { ...(req.query || {}), ...(req.body || {}) };

  const clickId = data.cid || data.click_id;
  if (!clickId) {
    return res.status(400).json({ ok: false, error: 'missing_click_id' });
  }

  try {
    const click = await Click.findOne({ click_id: clickId }).lean();
    if (!click) {
      return res.status(404).json({ ok: false, error: 'click_not_found' });
    }

    const conv = await Conversion.create({
      workspace_id: click.workspace_id,
      campaign_id: click.campaign_id,
      click_id: clickId,
      ts: new Date(),
      value: Number(data.value) || 0,
      currency: data.currency || 'USD',
      event_name: data.event || 'lead',
      source: 'postback',
      raw_payload: data,
    });

    logger.info('conversion_recorded', { click_id: clickId, source: 'postback', value: conv.value });
    return res.json({ ok: true, conversion_id: conv._id.toString() });
  } catch (err) {
    logger.error('postback_error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

router.get('/postback', handlePostback);
router.post('/postback', handlePostback);

/**
 * POST /cb/auto-conv
 *
 * Auto-conversion endpoint hit by the in-page injection script when a visitor clicks
 * a button matching one of the configured terms. Per-session deduplication is enforced
 * BOTH client-side (the script checks the cookie before sending) AND here server-side
 * (defense in depth: a malicious page or shared device shouldn't fire 100 conversions).
 *
 * Body: { click_id, event_name, term, text, element, page_url, ts }
 */
const AUTO_CONV_SESSION_COOKIE = 'bg_conv';
const AUTO_CONV_SESSION_DAYS = 30;

router.post('/auto-conv', async (req, res) => {
  // Always no-cache
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('CDN-Cache-Control', 'no-store');

  const data = req.body || {};
  const clickId = data.click_id;

  // Strict input validation - this endpoint is exposed to anyone
  if (!clickId || typeof clickId !== 'string' || clickId.length > 64) {
    return res.status(400).json({ ok: false, error: 'invalid_click_id' });
  }

  // Server-side session dedup: if the visitor's browser already sent us a
  // bg_conv cookie, treat as duplicate. This protects against:
  //   - Malicious clients clearing the cookie and re-sending
  //   - Race condition between cookie set + click event firing twice
  //
  // EXCEPTION: when the request originates from a page with ?bg_debug=1 in the
  // URL, we skip this dedup so QA can test repeatedly without clearing cookies.
  // We check the Referer header — bg_debug=1 cannot be spoofed in the body
  // because we don't read it from the body.
  var debugMode = false;
  try {
    var ref = req.get('referer') || '';
    debugMode = ref.indexOf('bg_debug=1') !== -1;
  } catch (e) {}

  if (!debugMode && req.cookies && req.cookies[AUTO_CONV_SESSION_COOKIE]) {
    return res.json({ ok: true, dedup: true });
  }

  try {
    // Find the click record. There's a race: /go is fire-and-forget on click writes,
    // so the beacon could arrive in this endpoint before the Mongo write completes.
    // Retry up to 3 times with short backoff to handle this gracefully.
    let click = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      click = await Click.findOne({ click_id: clickId }).lean();
      if (click) break;
      // Small wait before retry - covers most race windows under typical load
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!click) {
      // After retries, still no click. Could be:
      //   - genuinely unknown click_id (probing/bot)
      //   - extreme MongoDB latency (>150ms write)
      //   - cookie was carried over from an old, deleted click
      // Don't 404 - that would let attackers probe valid click IDs
      logger.warn('auto_conv_click_not_found', { click_id: clickId });
      if (debugMode) {
        return res.json({
          ok: true,
          ignored: true,
          debug: {
            reason: 'click_not_found',
            click_id_searched: clickId,
            tip: 'No Click record exists with this click_id. Possible causes: (1) the click_id cookie is from an old session whose click record was deleted, (2) MongoDB write latency >150ms, (3) the click_id is being tampered with. Check that visiting /go/<your-slug> creates a click row in /admin/clicks before the auto-conv beacon fires.',
          },
        });
      }
      return res.json({ ok: true, ignored: true, reason: 'click_not_found' });
    }

    // Sanitize text fields - we'll display these in admin pages
    const term = sanitizeShort(data.term);
    const text = sanitizeShort(data.text, 200);
    const element = sanitizeShort(data.element, 200);
    const href = sanitizeShort(data.href, 200);
    const pageUrl = sanitizeShort(data.page_url, 500);
    const eventName = sanitizeShort(data.event_name) || 'auto_click';

    const conv = await Conversion.create({
      workspace_id: click.workspace_id,
      campaign_id: click.campaign_id,
      click_id: clickId,
      ts: new Date(),
      source: 'auto',
      event_name: eventName,
      auto_detected: true,
      matched_term: term,
      matched_text: text,
      matched_element: element,
      matched_href: href,
      page_url: pageUrl,
      raw_payload: data,
    });

    // Update denormalized counters on the click record. Capture the result so
    // we can log whether the update actually matched - if matchedCount is 0,
    // something is wrong (click_id race, dropped index, etc.).
    const updateResult = await Click.updateOne(
      { click_id: clickId },
      {
        $inc: { conversion_count: 1, auto_conversion_count: 1 },
        $set: { last_conversion_at: new Date() },
      }
    );

    // Set dedup cookie - matches the client-side cookie name
    res.cookie(AUTO_CONV_SESSION_COOKIE, '1', {
      maxAge: AUTO_CONV_SESSION_DAYS * 86400 * 1000,
      sameSite: 'lax',
      secure: req.secure,
      httpOnly: false,
    });

    logger.info('auto_conversion_recorded', {
      click_id: clickId, term, event_name: eventName,
      // Critical observability: if matched=0, the conversion was created but the
      // click record's denormalized counter wasn't incremented - the dashboard
      // and click log will show CONV: – even though the conversion exists.
      matched: updateResult.matchedCount,
      modified: updateResult.modifiedCount,
    });

    // In debug mode, return verbose response so it can be inspected in DevTools.
    // This includes the updated counter values - useful for confirming whether
    // the click record was actually updated.
    if (debugMode) {
      const updatedClick = await Click.findOne({ click_id: clickId })
        .select('conversion_count auto_conversion_count last_conversion_at click_id workspace_id')
        .lean();
      return res.json({
        ok: true,
        conversion_id: conv._id.toString(),
        debug: {
          conversion_created: true,
          click_record_match: updateResult.matchedCount,
          click_record_modified: updateResult.modifiedCount,
          updated_counters: updatedClick ? {
            conversion_count: updatedClick.conversion_count,
            auto_conversion_count: updatedClick.auto_conversion_count,
            last_conversion_at: updatedClick.last_conversion_at,
          } : null,
          tip: updateResult.matchedCount === 0
            ? 'CRITICAL: Click record was NOT found by updateOne despite findOne succeeding. This is unexpected.'
            : 'Click record successfully updated. Refresh /admin/conversions to see this conversion.',
        },
      });
    }

    return res.json({ ok: true, conversion_id: conv._id.toString() });
  } catch (err) {
    logger.error('auto_conv_error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

function sanitizeShort(s, max = 100) {
  if (typeof s !== 'string') return null;
  // Strip control characters and clamp length
  return s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max).trim() || null;
}

module.exports = router;
