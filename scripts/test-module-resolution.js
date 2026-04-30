// Test that every JS file in src/ can be required without throwing module-resolution errors.
// This catches Linux-specific path issues that don't surface on macOS/Windows.

const path = require('path');
const fs = require('fs');

function findJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJsFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const srcDir = path.join(__dirname, '..', 'src');
const files = findJsFiles(srcDir);

let ok = 0, fail = 0;
const errors = [];

for (const f of files) {
  // Skip server.js because it tries to connect to Mongo on require
  if (f.endsWith('server.js')) {
    console.log(`  SKIP   ${path.relative(srcDir, f)} (would start server)`);
    continue;
  }
  try {
    require(f);
    console.log(`  OK     ${path.relative(srcDir, f)}`);
    ok++;
  } catch (err) {
    console.log(`  FAIL   ${path.relative(srcDir, f)}\n         ${err.message}`);
    errors.push({ file: f, message: err.message });
    fail++;
  }
}

console.log(`\n${ok} loaded, ${fail} failed`);
if (fail > 0) {
  console.log('\nErrors:');
  for (const e of errors) console.log(`  ${path.relative(srcDir, e.file)}: ${e.message}`);
}
process.exit(fail > 0 ? 1 : 0);
