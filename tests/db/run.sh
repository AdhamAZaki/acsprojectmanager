#!/usr/bin/env bash
# Database tests: builds a fresh test database on a Postgres server, applies
# supabase/setup.sql twice (it must be safe to re-run), adds the test data, and
# runs tests/db/security.test.sql.
#
# Uses the standard Postgres settings (PGHOST, PGPORT, PGUSER, PGPASSWORD).
# Example: PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DB=acs_test
export PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

echo "== fresh database"
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
"${PSQL[@]}" -d $DB -f tests/db/supabase-mock.sql

echo "== setup.sql (first run)"
"${PSQL[@]}" -d $DB -f supabase/setup.sql >/dev/null

# An old test account with a password that was once published in this repo:
# the second run of setup.sql must lock it.
"${PSQL[@]}" -d $DB -c "select public._create_login('legacy.test@advcontrolsys.com', 'Test@2026', 'Legacy Test', 'member')" >/dev/null

echo "== setup.sql (second run, must be safe to re-run)"
"${PSQL[@]}" -d $DB --single-transaction -f supabase/setup.sql >/dev/null

echo "== test data"
sed "s/v_password text := 'CHANGE-ME'/v_password text := 'Local-test-only-1'/" supabase/seed-test-data.sql \
  | "${PSQL[@]}" -d $DB >/dev/null
if sed "s/v_password     text    := 'CHANGE-ME'/v_password     text    := 'Local-test-only-1'/" supabase/import-team.example.sql \
  | "${PSQL[@]}" -d $DB >/dev/null 2>&1; then
  echo "FAIL: import template ran with the example names still in it"; exit 1
fi
echo "PASS: import template refuses to run with the example names"

echo "== checks"
PGOPTIONS='-c client_min_messages=notice' "${PSQL[@]}" -d $DB -f tests/db/security.test.sql 2>&1 \
  | sed -n 's/^.*NOTICE:  //p; /^psql:/p; /All database checks passed/p'
