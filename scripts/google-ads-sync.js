/**
 * BotGuard – Google Ads IP Exclusion Sync Script
 *
 * Syncs your campaign's IP exclusions with BotGuard's CIDR Intelligence.
 * Uses GAQL to read existing exclusions and AdsApp.mutate() for all changes.
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
  var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, "");

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
                "AND campaign.id = " + campaignId;

    var results = AdsApp.search(query);

    while (results.hasNext()) {
      var row = results.next();
      var ip = row.campaignCriterion.ipBlock.ipAddress;
      var cId = row.campaignCriterion.criterionId;
      if (ip) {
        currentExclusions.push(ip);
        criterionMap[ip] = cId;
      }
    }
  } catch (e) {
    Logger.log("WARN: GAQL query issue: " + e.message);
    Logger.log("Proceeding with empty exclusion list.");
  }

  Logger.log("Current exclusions in Google Ads: " + currentExclusions.length);

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

  var instructions = JSON.parse(response.getContentText());
  var toAdd = instructions.add || [];
  var toRemove = instructions.remove || [];
  var stats = instructions.stats || {};

  Logger.log("Server: Add " + toAdd.length + " | Remove " + toRemove.length);
  if (stats.final_count) {
    Logger.log("DB threats: " + stats.threats_in_database + " | Final: " + stats.final_count + "/" + stats.limit);
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    Logger.log("Nothing to change. Campaign is in sync.");
    return;
  }

  // 4. Build all mutations in one batch
  var operations = [];
  var campaignResource = "customers/" + customerId + "/campaigns/" + campaignId;

  // REMOVALS — use resource name with criterion ID
  for (var r = 0; r < toRemove.length; r++) {
    var removeCid = criterionMap[toRemove[r]];
    if (removeCid) {
      operations.push({
        "campaignCriterionOperation": {
          "remove": "customers/" + customerId + "/campaignCriteria/" + campaignId + "~" + removeCid
        }
      });
    } else {
      Logger.log("WARN: Cannot remove '" + toRemove[r] + "' — criterion ID not found.");
    }
  }

  // ADDITIONS — create negative IP_BLOCK criterion
  for (var a = 0; a < toAdd.length; a++) {
    operations.push({
      "campaignCriterionOperation": {
        "create": {
          "campaign": campaignResource,
          "negative": true,
          "ipBlock": {
            "ipAddress": toAdd[a]
          }
        }
      }
    });
  }

  Logger.log("Sending " + operations.length + " mutations (" +
    toRemove.length + " removals + " + toAdd.length + " additions)...");

  // 5. Execute mutations in batches of 100
  var totalSuccess = 0;
  var totalFailed = 0;

  for (var batch = 0; batch < operations.length; batch += 100) {
    var chunk = operations.slice(batch, Math.min(batch + 100, operations.length));
    try {
      var mutateResults = AdsApp.mutate(chunk);
      for (var m = 0; m < mutateResults.length; m++) {
        if (mutateResults[m].isSuccessful()) {
          totalSuccess++;
        } else {
          totalFailed++;
          var err = mutateResults[m].getError();
          if (err) Logger.log("FAIL: " + err);
        }
      }
    } catch (e) {
      Logger.log("ERROR: Batch mutation failed: " + e.message);
      totalFailed += chunk.length;
    }
  }

  Logger.log("Results: " + totalSuccess + " succeeded, " + totalFailed + " failed.");
  Logger.log("Campaign now has ~" +
    (currentExclusions.length - toRemove.length + toAdd.length) + " exclusions.");
}
