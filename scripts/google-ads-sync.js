/**
 * BotGuard – Google Ads IP Exclusion Sync Script
 *
 * This script syncs your Google Ads campaign's IP exclusions with BotGuard's
 * CIDR Intelligence database. Drop it into Google Ads Script editor and
 * schedule it to run hourly.
 *
 * How it works:
 *   1. Reads all current IP exclusions from your campaign
 *   2. POSTs them to your BotGuard server
 *   3. BotGuard compares against its intelligence, computes optimal add/remove
 *   4. Script applies the instructions (removals first, then additions)
 *
 * Setup:
 *   1. Set CAMPAIGN_NAME to your display campaign name (exact match)
 *   2. Set SERVER_URL to your BotGuard domain
 *   3. Set API_KEY to match GADS_SYNC_KEY in your BotGuard .env
 *   4. Paste into Google Ads > Tools > Scripts > New Script
 *   5. Schedule: Hourly
 *
 * Google Ads limit: 500 IP exclusions per campaign.
 * BotGuard handles FIFO rotation automatically — when at the limit, it
 * removes lowest-score/stale entries to make room for higher-priority threats.
 */

// ═══════════════════════════════════════════════════════════════════════
//  CONFIGURATION — edit these values
// ═══════════════════════════════════════════════════════════════════════

var CAMPAIGN_NAME = "YOUR_DISPLAY_CAMPAIGN_NAME";
var SERVER_URL    = "https://yourdomain.com";           // your BotGuard URL (no trailing slash)
var API_KEY       = "your-gads-sync-key-here";          // matches GADS_SYNC_KEY in .env

// ═══════════════════════════════════════════════════════════════════════

function main() {
  // 1. Find the campaign
  var campaignIterator = AdsApp.campaigns()
      .withCondition("Name = '" + CAMPAIGN_NAME + "'")
      .get();

  if (!campaignIterator.hasNext()) {
    Logger.log("ERROR: Campaign '" + CAMPAIGN_NAME + "' not found. Check the name.");
    return;
  }
  var campaign = campaignIterator.next();
  Logger.log("Campaign found: " + campaign.getName());

  // 2. Collect current IP exclusions
  var currentExclusions = [];
  var exclusionsIterator = campaign.ipExclusions().get();

  while (exclusionsIterator.hasNext()) {
    var exclusion = exclusionsIterator.next();
    currentExclusions.push(exclusion.getIpAddress());
  }

  Logger.log("Current exclusions: " + currentExclusions.length);

  // 3. POST to BotGuard for optimization
  var payload = {
    campaignName: CAMPAIGN_NAME,
    existingExclusions: currentExclusions
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response;
  try {
    response = UrlFetchApp.fetch(SERVER_URL + "/api/optimize-exclusions", options);
  } catch (e) {
    Logger.log("ERROR: Failed to reach server: " + e.message);
    return;
  }

  if (response.getResponseCode() !== 200) {
    Logger.log("ERROR: Server returned " + response.getResponseCode() + ": " + response.getContentText());
    return;
  }

  // 4. Parse the response
  var instructions = JSON.parse(response.getContentText());
  var toAdd = instructions.add || [];
  var toRemove = instructions.remove || [];
  var stats = instructions.stats || {};

  Logger.log("Server response — Add: " + toAdd.length + " | Remove: " + toRemove.length);
  if (stats.threats_in_database) {
    Logger.log("Threats in database: " + stats.threats_in_database + " | Final count: " + stats.final_count + "/" + stats.limit);
  }

  // 5. Execute REMOVALS first (free up slots before adding)
  if (toRemove.length > 0) {
    var removalSet = {};
    for (var r = 0; r < toRemove.length; r++) {
      removalSet[toRemove[r]] = true;
    }

    // Re-fetch live exclusion objects for removal
    var refreshIterator = campaign.ipExclusions().get();
    var removed = 0;
    while (refreshIterator.hasNext()) {
      var liveExclusion = refreshIterator.next();
      if (removalSet[liveExclusion.getIpAddress()]) {
        liveExclusion.remove();
        removed++;
      }
    }
    Logger.log("Removed " + removed + " stale exclusions.");
  }

  // 6. Execute ADDITIONS
  var added = 0;
  for (var a = 0; a < toAdd.length; a++) {
    try {
      campaign.excludeIpAddress(toAdd[a]);
      added++;
    } catch (e) {
      Logger.log("WARN: Failed to add " + toAdd[a] + ": " + e.message);
    }
  }
  Logger.log("Added " + added + " new exclusions.");

  Logger.log("Sync complete. Campaign now has ~" +
    (currentExclusions.length - toRemove.length + added) + " exclusions.");
}
