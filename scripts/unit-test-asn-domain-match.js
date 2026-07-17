// Unit test: ASN blacklist term rules also match against the ASN's domain
// (e.g. "iproyal.com"), so IPLocate-sourced enrichment reliably triggers
// term rules even when the org-name string differs from ProxyCheck's.

const assert = require('assert');
const path = require('path');

// Stub the models module BEFORE asnLookup requires AsnBlacklist.
const modelsPath = path.resolve(__dirname, '../src/models');
let stubTermRules = [];
const stubModels = {
  AsnBlacklist: {
    find: () => ({ lean: async () => stubTermRules }),
    updateOne: async () => ({}),
    updateMany: async () => ({}),
  },
};
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true, exports: stubModels,
};

const { lookupAsn } = require(path.resolve(__dirname, '../src/lib/asnLookup'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  console.log('ASN term rules — domain matching:');

  // Seed a term rule targeting "iproyal" on the asn_org field.
  stubTermRules = [{
    term: 'iproyal', term_field: 'asn_org', severity: 'high',
    score_weight: 40, category: 'residential_proxy', override: 'mark_proxy', active: true,
  }];

  await test('domain "iproyal.com" matches an asn_org term rule for "iproyal"', async () => {
    // Org name deliberately does NOT contain "iproyal" (mimics IPLocate's
    // asn.name "Karolio IT paslaugos"); the domain carries the signal.
    const r = await lookupAsn(211415, null, {
      provider: 'Karolio IT paslaugos, UAB',
      asnOrg: 'Karolio IT paslaugos, UAB',
      domain: 'iproyal.com',
    });
    assert.strictEqual(r.match, true, 'should match via the domain');
    assert.strictEqual(r.match_kind, 'term');
  });

  await test('no domain, non-matching org → no match (control)', async () => {
    const r = await lookupAsn(999999, null, {
      provider: 'Karolio IT paslaugos, UAB',
      asnOrg: 'Karolio IT paslaugos, UAB',
      domain: '',
    });
    assert.strictEqual(r.match, false);
  });

  await test('org name still matches when it contains the term (back-compat)', async () => {
    const r = await lookupAsn(888888, null, {
      provider: 'IPRoyal LLC', asnOrg: 'IPRoyal LLC', domain: '',
    });
    assert.strictEqual(r.match, true, 'org-name matching must still work');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
