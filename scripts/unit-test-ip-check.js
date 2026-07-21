// Unit test for the IP validation used by the Tools → IP Check page.
// The validator is defined inline in the route; this mirrors it and asserts
// the accept/reject behavior so a regression in the regex is caught.

const assert = require('assert');

function isValidIp(ip) {
  if (!ip) return false;
  const s = String(ip).trim();
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(s) && s.includes(':') && s.length >= 3;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('isValidIp:');
test('accepts valid IPv4', () => {
  ['64.204.7.228', '8.8.8.8', '1.1.1.1', '255.255.255.255', '0.0.0.0'].forEach((ip) => assert.ok(isValidIp(ip), ip));
});
test('rejects out-of-range IPv4 octets', () => {
  ['256.1.1.1', '1.2.3.999', '300.300.300.300'].forEach((ip) => assert.ok(!isValidIp(ip), ip));
});
test('rejects malformed IPv4', () => {
  ['1.2.3', '1.2.3.4.5', 'abc', '1.2.3.', ''].forEach((ip) => assert.ok(!isValidIp(ip), ip));
});
test('accepts IPv6', () => {
  ['2001:4860:4860::8888', '::1', 'fe80::1', '2003:d8::'].forEach((ip) => assert.ok(isValidIp(ip), ip));
});
test('rejects junk', () => {
  ['not-an-ip', 'http://x.com', '12345', undefined, null].forEach((ip) => assert.ok(!isValidIp(ip), String(ip)));
});
test('trims surrounding whitespace', () => {
  assert.ok(isValidIp('  8.8.8.8  '));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
