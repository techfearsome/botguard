const express = require('express');
const router = express.Router();

const { Click, Conversion } = require('../models');
const logger = require('../lib/logger');

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/**
 * GET /px/conv?cid=<click_id>&value=<n>&event=<name>
 * Returns 1x1 GIF after recording the conversion.
 */
router.get('/conv', async (req, res) => {
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  try {
    const clickId = req.query.cid || req.cookies?.bg_cid;
    if (!clickId) {
      logger.warn('conversion_no_click_id', { ip: req.ip });
      return res.send(PIXEL);
    }

    const click = await Click.findOne({ click_id: clickId }).lean();
    if (!click) {
      logger.warn('conversion_click_not_found', { click_id: clickId });
      return res.send(PIXEL);
    }

    await Conversion.create({
      workspace_id: click.workspace_id,
      campaign_id: click.campaign_id,
      click_id: clickId,
      ts: new Date(),
      value: Number(req.query.value) || 0,
      currency: req.query.currency || 'USD',
      event_name: req.query.event || 'lead',
      source: 'pixel',
      raw_payload: { query: req.query },
    });

    logger.info('conversion_recorded', { click_id: clickId, source: 'pixel' });
  } catch (err) {
    logger.error('pixel_error', { err: err.message });
  }

  res.send(PIXEL);
});

module.exports = router;
