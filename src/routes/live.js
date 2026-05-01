/**
 * Live presence routes.
 *
 * /lv/heartbeat - visitor's browser pings every 10s while on the page
 * /lv/leave     - visitor's browser sends on page unload (fire-and-forget)
 *
 * Both endpoints are deliberately tiny. They take JSON or text/plain body
 * (sendBeacon quirk), validate the click_id, and update in-memory state.
 *
 * The SSE stream is mounted under /admin (auth-gated) - see admin/index.js.
 */

const express = require('express');
const router = express.Router();
const { live } = require('../lib/livePresence');

const MAX_CLICKID_LEN = 64;

function readClickId(req) {
  const id = req.body && req.body.click_id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CLICKID_LEN) return null;
  // Reject anything that doesn't look like a click_id (alphanumeric + _-)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

router.post('/heartbeat', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('CDN-Cache-Control', 'no-store');
  const clickId = readClickId(req);
  if (!clickId) return res.status(400).json({ ok: false, error: 'invalid_click_id' });

  // Heartbeat only succeeds if the visitor was already registered via /go.
  // This protects against random clients spamming heartbeats for click_ids
  // they made up.
  const ok = live.heartbeat(clickId);
  return res.json({ ok: !!ok });
});

router.post('/leave', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('CDN-Cache-Control', 'no-store');
  const clickId = readClickId(req);
  if (!clickId) return res.status(400).json({ ok: false, error: 'invalid_click_id' });

  live.left(clickId);
  return res.json({ ok: true });
});

module.exports = router;
