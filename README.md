# ACS Project Tracker (acsprojectmanager)

A weekly task tool for the ACS teams: **Automation** (PLC / AVEVA) and **BMS**. It replaces typing up the weekly meeting by hand. Each department has its own weekly board, saved minutes and meeting email, in one shared database.

Each engineer signs in with a **username and password** and:

- sees every project of their **department** on one board, **this week and next week side by side** (the weekly meeting), and **joins** projects in one tap; a switch at the top shows the other department's board
- adds **tasks** (with sub-tasks) to **any project** for **last, this or next week**; unfinished tasks roll over automatically
- does everything on **one page**: switch between *My tasks*, *My projects* and *All projects*, tick and edit tasks right on the board
- marks a task **Blocked** with a short note, and can assign teammates or 3rd parties (people without an account)

Projects are **shared by every team** (PLC, AVEVA, BMS, UI/UX, Dev): each team adds its own tasks to the same project, and a project shows the teams on it. Everything is on **one Tasks page**: tabs for **Mine** and **Team** (admins and department admins), views **List · Board · By person · Table · Projects**, KPI cards (open, blocked, done, carried over, no update) that filter when tapped, and filters for week, project, status, team and person. The menu (left on a computer, bottom bar on a phone) jumps to Mine, Team or Projects; **Manage** (admins and department admins) has People, Projects, Departments & teams and 3rd parties. The look follows the ACS *Dashboard Facelift* design, in light and dark.

**Employees see only their own tasks** (the database enforces it); admins see everything and department admins manage their own people's tasks on any project. **+ Add task** is on every page (a round button on a phone); admins and department admins can add a task *for* one of their people. On the Team page, pick a department to **Copy as email** (the *Weekly Progress Check & Action Plan* table, one column per team) or **save the minutes** so that week's record never changes (all saved weeks are under **Past minutes**). Before the meeting, managers see who has **no update yet** and can copy a reminder; from Thursday, everyone gets a nudge to **plan next week**. Changes from teammates appear **live**. Everything is stored in a free **Supabase** database (Postgres).

| My tasks (phone) | Task (phone) | Team (phone) | Team (computer) |
|---|---|---|---|
| ![My week on a phone](docs/screenshots/2-board.png) | ![Task sheet on a phone](docs/screenshots/2b-task-sheet.png) | ![Meeting on a phone](docs/screenshots/3-by-person.png) | ![Meeting on a computer](docs/screenshots/4-board-wide.png) |

*(Screenshots use made-up demo data.)*

## Architecture

```
 Browser (GitHub Pages)                         Supabase (free plan)
 ┌────────────────────────┐   HTTPS    ┌────────────────────────────────────────┐
 │ frontend/  HTML/CSS/JS │ ─────────▶ │ Auth: usernames + hashed passwords      │
 │  supabase-js           │            │ Postgres: profiles, projects,           │
 │  no build step         │ ◀───────── │   assignments, tasks, contacts,         │
 └────────────────────────┘  live      │   meetings (saved minutes), departments │
                             updates   │ Row Level Security = who can do what    │
                                       └────────────────────────────────────────┘
```

- **No server of our own**: the website talks to Supabase directly. Everything the app needs loads in one request, and the last data is kept on the device so the app opens instantly.
- **Security is enforced in the database** (`supabase/migrations/`):
  - **Members** see every project and can join one. They see and edit the tasks on their projects, and tasks assigned to them. They can't change who created a task or move one into a project they're not on.
  - **Admins** manage projects, the team, assignments, 3rd parties and saved minutes, in every department.
  - **Dept admins** do the same for their own department only (they can't touch another department or create admins).
  - **Departments** (Automation, BMS) share the database: people and projects each belong to one, every department's board is visible to everyone, and saved minutes are kept per department and week.
  - **Signed-out visitors** see nothing.
  - **New accounts start inactive** unless an admin created them from the app, so a stray sign-up can't see anything.
- **No lost edits**: a save only changes the fields that person changed, and if a teammate saved the same task first, the change is applied on top of theirs.
- **Login**: Supabase Auth with email + password. People type a short username, and `@advcontrolsys.com` is added automatically. Admins create accounts and reset passwords from the **Team** page.
- **The data is easy to view and edit** in Supabase's Table Editor, and can be exported to CSV.

## Repository layout

| Path | What it is |
|---|---|
| `frontend/` | The app: static site deployed to GitHub Pages |
| `frontend/js/config.js` | Supabase Project URL + publishable key (both public by design) |
| `frontend/js/api.js` | Data layer: one-request loading, local cache, conflict-safe saving |
| `frontend/js/app.js` | The Tasks page (Mine / Team, views, filters, minutes) and Manage |
| `frontend/sw.js`, `manifest.webmanifest` | Installable app (Add to Home screen), offline app shell, self-updating |
| `supabase/migrations/` | Every database change, in order ([rules](supabase/migrations/README.md)) |
| `supabase/setup.sql` | All migrations in one file, generated. Paste into the SQL Editor, or let the deploy run it |
| `supabase/import-team.example.sql` | Template for importing the real team and projects (fill it in outside git) |
| `supabase/seed-test-data.sql` | Optional test logins and dummy projects, with a password you choose |
| `tests/db/` | Database tests: security rules and functions, on plain Postgres |
| `tests/e2e/` | Browser tests: the real app in Chromium against a fake Supabase; also makes the screenshots |
| `docs/SETUP.md` | Setup guide, going live, automatic database updates |
| `.github/workflows/ci.yml` | Checks on every branch push: code checks, database tests, browser tests |
| `.github/workflows/pages.yml` | On every push to `main`: checks → database update → publish the website |
| `.github/workflows/keep-alive.yml` | Daily ping so the free Supabase project never pauses |

## Getting started

Follow **[docs/SETUP.md](docs/SETUP.md)**:

1. Paste `supabase/setup.sql` into Supabase's SQL Editor and click **Run**
2. Turn off public sign-up in Supabase Auth settings
3. Add the team with the import template (or test data with `seed-test-data.sql`)
4. Sign in at https://adhamazaki.github.io/acsprojectmanager/
5. Optional: add the `SUPABASE_DB_URL` secret so database changes deploy automatically

This repository is public: never commit passwords or the real team list.

## Development

The app has no build step: edit the files in `frontend/` and open `frontend/index.html` through any local web server. The tools below are only for checks.

```bash
npm ci                                   # ESLint + Playwright (versions pinned)
npx playwright install chromium          # once, for the browser tests
npm test                                 # code checks + setup.sql up to date + browser tests
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db   # database tests (needs a Postgres server)
npm run screenshots                      # refresh docs/screenshots
```

**Changing the database:** add a new file to `supabase/migrations/` (see the [rules](supabase/migrations/README.md)), run `npm run build:setup`, and add a check to `tests/db/security.test.sql` if it changes who can see or do what.

**Every push** to a branch runs the checks on GitHub. On `main`, nothing is published unless they pass.
