# Database migrations

Every change to the database is a file in this folder, run in name order.
`supabase/setup.sql` is built from them (`npm run build:setup`), so there is
always one file to paste into the Supabase SQL Editor.

## Rules

1. **Name:** `YYYYMMDDHHMMSS_short_name.sql`, e.g. `20261103090000_task_due_dates.sql`.
   The timestamp format also works with the Supabase CLI.
2. **Safe to run again.** Every file runs on every deploy, on databases that
   already have it. Use `create ... if not exists`, `create or replace`,
   `drop ... if exists` before `create policy` / `create trigger`,
   `add column if not exists`, and guard data changes so a second run does nothing.
3. **Never edit a file after it is merged to `main`.** Add a new one instead.
4. **Never delete data** without a clear note in the file and in the pull request.
5. After adding or changing a file, run `npm run build:setup` and commit
   `supabase/setup.sql` too. CI fails if you forget.
6. Add a check for the change to `tests/db/security.test.sql` when it touches
   who can see or change what.

## How changes reach the live database

- **Automatically:** if the repository secret `SUPABASE_DB_URL` is set, every
  deploy from `main` runs `setup.sql` against the live database first (in one
  transaction, so a failure changes nothing), then publishes the website. See
  `docs/SETUP.md`, "Automatic database updates".
- **By hand:** paste `supabase/setup.sql` into the SQL Editor and click Run.
