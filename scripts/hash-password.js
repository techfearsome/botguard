#!/usr/bin/env node
// Hash a password for use in ADMIN_PASSWORD_HASH.
// Usage:
//   npm run hash-password               (prompts interactively)
//   npm run hash-password -- mypass     (one-shot)

const { hashPassword } = require('../src/middleware/auth');

const argPassword = process.argv[2];

if (argPassword) {
  console.log('\nGenerated hash:\n');
  console.log(hashPassword(argPassword));
  console.log('\nSet this in your environment as ADMIN_PASSWORD_HASH.\n');
  process.exit(0);
}

// Interactive prompt
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Hide input
rl._writeToOutput = function () {};

process.stdout.write('Password: ');
rl.question('', (password) => {
  process.stdout.write('\n');
  if (!password || password.length < 4) {
    console.error('Password must be at least 4 characters.');
    process.exit(1);
  }
  console.log('\nGenerated hash:\n');
  console.log(hashPassword(password));
  console.log('\nSet this in your environment as ADMIN_PASSWORD_HASH.\n');
  rl.close();
});
