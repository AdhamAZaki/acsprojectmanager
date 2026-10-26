#!/usr/bin/env node
// Builds supabase/setup.sql by joining every file in supabase/migrations, in order.
// Usage: node scripts/build-setup.js          (write the file)
//        node scripts/build-setup.js --check  (fail if it is out of date; used by CI)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'supabase', 'migrations');
const out = path.join(root, 'supabase', 'setup.sql');

const files = fs.readdirSync(dir).filter(f => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();
const odd = fs.readdirSync(dir).filter(f => f.endsWith('.sql') && files.indexOf(f) === -1);
if (odd.length) {
  console.error('Migration file names must look like 20261026120000_short_name.sql: ' + odd.join(', '));
  process.exit(1);
}

const header = `-- =====================================================================
-- ACS Project Tracker: Supabase database setup
--
-- GENERATED from supabase/migrations by scripts/build-setup.js. Do not edit
-- this file: add a new migration and run \`npm run build:setup\`.
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it creates what is missing and never deletes data.
-- It adds no people or projects: use supabase/import-team.example.sql for the
-- real team, or supabase/seed-test-data.sql for test data.
-- =====================================================================
`;
const parts = files.map(f => `\n-- ##### ${f} #####\n\n` + fs.readFileSync(path.join(dir, f), 'utf8').trimEnd() + '\n');
const text = header + parts.join('') + "\nselect 'ACS Project Tracker setup complete' as result;\n";

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error('supabase/setup.sql is out of date. Run: npm run build:setup');
    process.exit(1);
  }
  console.log('supabase/setup.sql is up to date (' + files.length + ' migrations).');
} else {
  fs.writeFileSync(out, text);
  console.log('Wrote supabase/setup.sql from ' + files.length + ' migrations.');
}
