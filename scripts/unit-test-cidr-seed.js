// Unit tests for cidrSeed.js
//
// Coverage: normalisation of every format we've seen in real uploads
// (Google Ads exclusion lists, Comprehensive Firewall CSV, BotGuard exports).

const assert = require('assert');
const path = require('path');
const { normaliseCidr, parseText, getIpVersion } = require(
  path.resolve(__dirname, '../src/lib/cidrSeed')
);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('normaliseCidr - IPv4:');

test('Wildcard 1.2.3.* normalises to 1.2.3.0/24', () => {
  assert.strictEqual(normaliseCidr('1.2.3.*'), '1.2.3.0/24');
});

test('Wildcard 192.168.1.* with whitespace', () => {
  assert.strictEqual(normaliseCidr('  192.168.1.*  '), '192.168.1.0/24');
});

test('Bare IPv4 /24 stays /24', () => {
  assert.strictEqual(normaliseCidr('1.2.3.0/24'), '1.2.3.0/24');
});

test('Bare IPv4 /32 reduces to /24', () => {
  assert.strictEqual(normaliseCidr('1.2.3.45/32'), '1.2.3.0/24');
});

test('Plain IPv4 address gets /24', () => {
  assert.strictEqual(normaliseCidr('192.168.1.100'), '192.168.1.0/24');
});

test('Invalid octet rejected', () => {
  assert.strictEqual(normaliseCidr('1.2.3.500'), null);
});

test('Wrong number of octets rejected', () => {
  assert.strictEqual(normaliseCidr('1.2.3'), null);
});

console.log('\nnormaliseCidr - IPv6:');

test('Bare IPv6 /32 stays as compact form', () => {
  assert.strictEqual(normaliseCidr('2600:387::/32'), '2600:387::/32');
});

test('Full-zero IPv6 /32 compresses', () => {
  assert.strictEqual(
    normaliseCidr('2600:0387:0000:0000:0000:0000:0000:0000/32'),
    '2600:387::/32'
  );
});

test('IPv6 /48 widens to /32', () => {
  assert.strictEqual(normaliseCidr('2600:387:abcd::/48'), '2600:387::/32');
});

test('Full IPv6 address widens to /32', () => {
  assert.strictEqual(
    normaliseCidr('2600:387:abcd:1234:5678:9abc:def0:1234'),
    '2600:387::/32'
  );
});

console.log('\nnormaliseCidr - comments and noise:');

test('Comment line returns null', () => {
  assert.strictEqual(normaliseCidr('# this is a comment'), null);
});

test('Semicolon comment returns null', () => {
  assert.strictEqual(normaliseCidr('; another comment'), null);
});

test('Empty line returns null', () => {
  assert.strictEqual(normaliseCidr(''), null);
  assert.strictEqual(normaliseCidr('   '), null);
});

test('Inline comment stripped', () => {
  assert.strictEqual(normaliseCidr('1.2.3.* # known bad'), '1.2.3.0/24');
});

test('Garbage input rejected', () => {
  assert.strictEqual(normaliseCidr('hello world'), null);
  assert.strictEqual(normaliseCidr('not-an-ip'), null);
});

test('Non-string input rejected', () => {
  assert.strictEqual(normaliseCidr(null), null);
  assert.strictEqual(normaliseCidr(undefined), null);
  assert.strictEqual(normaliseCidr(42), null);
});

console.log('\nparseText - plain list format:');

test('Plain list with mixed formats parses all valid lines', () => {
  const text = `
# Header comment
1.2.3.*
4.5.6.0/24
2600:387::/32
# another comment
6.7.8.*
`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 4);
  assert.ok(result.valid.includes('1.2.3.0/24'));
  assert.ok(result.valid.includes('4.5.6.0/24'));
  assert.ok(result.valid.includes('2600:387::/32'));
  assert.ok(result.valid.includes('6.7.8.0/24'));
});

test('Invalid lines reported separately', () => {
  const text = `1.2.3.*
garbage
not.an.ip.here
4.5.6.*`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 2);
  assert.strictEqual(result.invalid.length, 2);
  assert.ok(result.invalid.includes('garbage'));
});

test('Duplicates deduplicated', () => {
  const text = `1.2.3.*
1.2.3.0/24
1.2.3.45/32`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 1);
});

console.log('\nparseText - CSV format (real upload shape):');

test('Auto-detects CIDR column in CSV with header', () => {
  const text = `IP_Block,Network_Name,Category,Status
1.2.3.*,Verizon,Carrier,Active
4.5.6.0/24,AT&T,Carrier,Active
2600:387::/32,Comcast,Carrier,Active`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 3);
});

test('CSV with CIDR in second column auto-detected', () => {
  const text = `id,cidr,name
1,1.2.3.*,foo
2,4.5.6.*,bar
3,7.8.9.*,baz`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 3);
});

test('CSV with quoted CIDRs', () => {
  const text = `"1.2.3.*","Verizon"
"4.5.6.0/24","AT&T"`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 2);
});

console.log('\nReal upload shapes:');

test('Google Ads campaign exclusion format', () => {
  const text = `10.8.0.*
100.23.89.*
2401:4900:0:0:0:0:0:0/32
2600:1000:0:0:0:0:0:0/32`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 4);
  assert.ok(result.valid.includes('2401:4900::/32'),
    `expected 2401:4900::/32 in ${result.valid}`);
});

test('BotGuard own export format with header comments', () => {
  const text = `# BotGuard CIDR Intelligence Export
# Generated: 2026-05-13T08:00:00Z
# Entries: 3

# ── CRITICAL (80+) ──
1.2.3.*  # Verizon score=85
2600:387::/32  # AT&T score=92
4.5.6.0/24  # T-Mobile score=78`;
  const result = parseText(text);
  assert.strictEqual(result.valid.length, 3);
});

console.log('\ngetIpVersion:');

test('IPv4 detection', () => {
  assert.strictEqual(getIpVersion('1.2.3.0/24'), 'v4');
});

test('IPv6 detection', () => {
  assert.strictEqual(getIpVersion('2600:387::/32'), 'v6');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
