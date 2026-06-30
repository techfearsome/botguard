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

var CAMPAIGN_NAME = "YOUR_DISPLAY_CAMPAIGN_NAME";
var SERVER_URL    = "https://yourdomain.com";
var API_KEY       = "your-gads-sync-key-here";

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
  var campaignResource = "customers/" + customerId + "/campaigns/" + campaignId;
  Logger.log("Campaign: " + campaign.getName() + " (ID: " + campaignId + ")");

  // 2. Read current IP exclusions via GAQL
  var currentExclusions = [];
  var criterionMap = {};

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
    Logger.log("WARN: GAQL query: " + e.message);
  }

  Logger.log("Current exclusions: " + currentExclusions.length);

  // 3. POST to BotGuard
  var payload = {
    campaignName: CAMPAIGN_NAME,
    existingExclusions: currentExclusions
  };

  var response;
  try {
    response = UrlFetchApp.fetch(SERVER_URL + "/api/optimize-exclusions", {
      method: "post",
      contentType: "application/json",
      headers: { "x-api-key": API_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("ERROR: Server unreachable: " + e.message);
    return;
  }

  if (response.getResponseCode() !== 200) {
    Logger.log("ERROR: " + response.getResponseCode() + ": " + response.getContentText());
    return;
  }

  var instructions = JSON.parse(response.getContentText());
  var toAdd = instructions.add || [];
  var toRemove = instructions.remove || [];
  var stats = instructions.stats || {};

  Logger.log("Server: +" + toAdd.length + " / -" + toRemove.length +
    " | DB: " + (stats.threats_in_database || "?") +
    " | Final: " + (stats.final_count || "?") + "/" + (stats.limit || 500));

  if (toAdd.length === 0 && toRemove.length === 0) {
    Logger.log("In sync. Nothing to change.");
    return;
  }

  // 4. Execute REMOVALS first
  var removed = 0;
  for (var r = 0; r < toRemove.length; r++) {
    var removeCid = criterionMap[toRemove[r]];
    if (!removeCid) continue;
    try {
      var removeResult = AdsApp.mutate([{
        "campaignCriterionOperation": {
          "remove": "customers/" + customerId + "/campaignCriteria/" + campaignId + "~" + removeCid
        }
      }]);
      if (removeResult[0].isSuccessful()) {
        removed++;
      } else {
        Logger.log("FAIL remove " + toRemove[r] + ": " + removeResult[0].getError());
      }
    } catch (e) {
      Logger.log("FAIL remove " + toRemove[r] + ": " + e.message);
    }
  }
  if (toRemove.length > 0) Logger.log("Removed: " + removed + "/" + toRemove.length);

  // 5. Execute ADDITIONS one by one
  //    (one-by-one so a single bad entry doesn't kill the whole batch)
  var added = 0;
  var failed = 0;
  for (var a = 0; a < toAdd.length; a++) {
    try {
      var addResult = AdsApp.mutate([{
        "campaignCriterionOperation": {
          "create": {
            "campaign": campaignResource,
            "negative": true,
            "ipBlock": {
              "ipAddress": toAdd[a]
            }
          }
        }
      }]);
      if (addResult[0].isSuccessful()) {
        added++;
      } else {
        failed++;
        Logger.log("FAIL add " + toAdd[a] + ": " + addResult[0].getError());
      }
    } catch (e) {
      failed++;
      Logger.log("FAIL add " + toAdd[a] + ": " + e.message);
    }
  }

  Logger.log("Added: " + added + "/" + toAdd.length +
    (failed > 0 ? " (" + failed + " failed)" : ""));
  Logger.log("Done. Campaign has ~" +
    (currentExclusions.length - removed + added) + " exclusions.");
}
