import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const jsFiles = ['js/app.js', 'js/firebase.js', 'js/storage.js'];
let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax error in ${file}\n${result.stderr || result.stdout}`);
  } else {
    console.log(`OK: syntax ${file}`);
  }
}
for (const file of ['package.json', 'package-lock.json', 'firebase.json', 'database.rules.json']) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    console.log(`OK: JSON ${file}`);
  } catch (error) {
    failed = true;
    console.error(`Invalid JSON ${file}: ${error.message}`);
  }
}
if (failed) process.exit(1);
console.log('Static checks passed. This does not replace browser/Firebase integration tests.');
