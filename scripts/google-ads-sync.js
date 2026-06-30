/**
 * BotGuard – Google Ads IP Exclusion Sync Script
 *
 * Syncs your campaign's IP exclusions with BotGuard's CIDR Intelligence.
 * Uses GAQL to read existing exclusions, AdsApp.mutate() for removals,
 * and campaign.excludeIpAddress() for additions.
 *
 * Setup:
 *   1. Set CAMPAIGN_NAME, SERVER_URL, API_KEY below
 *   2. Paste into Google Ads > Tools > Scripts > New Script
 *   3. Click Preview to test, then schedule Hourly
 */

// ═══════════════════════════════════════════════════════════════════════
//  CONFIGURATION — edit these values
// ═══════════════════════════════════════════════════════════════════════

var CAMPAIGN_NAME = "YOUR_DISPLAY_CAMPAIGN_NAME";
var SERVER_URL    = "https://yourdomain.com";
var API_KEY       = "your-gads-sync-key-here";

// ═══════════════════════════════════════════════════════════════════════

function main() {
  // 1. Find the campaign
  var campaignIterator = AdsApp.campaigns()
      .withCondition("Name = '" + CAMPAIGN_NAME + "'")
      .get();

  if (!campaignIterator.hasNext()) {
    Logger.log("ERROR: Campaign '" + CAMPAIGN_NAME + "' not found.");
    return;
  }
  var campaign = campaignIterator.next();
  var campaignId = campaign.getId();
  Logger.log("Campaign found: " + campaign.getName() + " (ID: " + campaignId + ")");

  // 2. Read current IP exclusions via GAQL
  var currentExclusions = [];
  var criterionMap = {};  // ip → criterionId (needed for removal)

  try {
    var query = "SELECT campaign_criterion.criterion_id, campaign_criterion.ip_block.ip_address " +
                "FROM campaign_criterion " +
                "WHERE campaign_criterion.type = 'IP_BLOCK' " +
                "AND campaign_criterion.negative = TRUE " +
                "AND campaign.id = " + campaignId;

    var results = AdsApp.search(query);

    while (results.hasNext()) {
      var row = results.next();
      var ip = row.campaignCriterion.ipBlock.ipAddress;
      var criterionId = row.campaignCriterion.criterionId;
      if (ip) {
        currentExclusions.push(ip);
        criterionMap[ip] = criterionId;
      }
    }
  } catch (e) {
    Logger.log("WARN: GAQL query failed: " + e.message);
    Logger.log("Proceeding with empty exclusion list (first-time sync).");
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
    Logger.log("Threats in DB: " + stats.threats_in_database +
               " | Final count: " + stats.final_count + "/" + stats.limit);
  }

  // 5. Execute REMOVALS first (free up slots before adding)
  //    Use AdsApp.mutate() with the criterion resource name
  if (toRemove.length > 0) {
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, "");
    var removeOps = [];

    for (var r = 0; r < toRemove.length; r++) {
      var cid = criterionMap[toRemove[r]];
      if (cid) {
        removeOps.push({
          "campaignCriterionOperation": {
            "remove": "customers/" + customerId + "/campaignCriteria/" + campaignId + "~" + cid
          }
        });
      }
    }

    if (removeOps.length > 0) {
      // Process in batches of 50 (API limit)
      var removed = 0;
      for (var batch = 0; batch < removeOps.length; batch += 50) {
        var chunk = removeOps.slice(batch, batch + 50);
        try {
          var mutateResult = AdsApp.mutate(chunk);
          for (var mr = 0; mr < mutateResult.length; mr++) {
            if (mutateResult[mr].isSuccessful()) removed++;
          }
        } catch (e) {
          Logger.log("WARN: Batch removal failed: " + e.message);
        }
      }
      Logger.log("Removed " + removed + " stale exclusions.");
    }
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
