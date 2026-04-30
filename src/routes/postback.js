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

module.exports = router;
