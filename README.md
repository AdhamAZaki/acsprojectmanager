# ACS Project Tracker (acsprojectmanager)

A weekly task tool for the ACS teams: **Automation** (PLC / AVEVA) and **BMS**. It replaces typing up the weekly meeting by hand. Each department has its own weekly board, saved minutes and meeting email, in one shared database.

Each engineer signs in with a **username and password** and works on **one page**:

- **Filter:** one search box. Type to find a task, or pick a week, status, person, team or project; each filter picked shows as a tag in the box.
- **View:** **List · Board · Table** only change the shape. **Group by** project, person, team, status or week, **Sort**, and **Show empty groups** work the same in all three. Groups keep a fixed order, so nothing jumps when a task changes.
- **Shortcuts:** one-tap filters with counts: My tasks, Open, Blocked, Done, Carried over, No update, and the teams.
- **Tasks:** type under any group to add a task to it, or use **+ Task**. A task opens in a panel on the right (full screen on a phone): status (To do, Doing, Blocked with a reason, Done), project, week, people and 3rd parties (people without an account), and sub-tasks that are edited in place. Unfinished tasks roll over to the next week automatically.

Projects are **shared by every team** (PLC, AVEVA, BMS, UI/UX, Dev): each team adds its own tasks to the same project, and a project shows the teams on it. Tapping a project's name opens it in the same panel: who is on it, Join / Leave, its notes and its last 8 weeks.

The page is the same for everyone; what a person may not do is hidden. **Employees see only their own tasks** (the database enforces it). Admins see everything, and department admins manage their own people's tasks on any project; they also get **+ Project**, **Meeting** and **Manage**. Under **Meeting**, pick a department in the Team filter to **Copy as email** (the *Weekly Progress Check & Action Plan* table, one column per team) or **save the minutes** so that week's record never changes (all saved weeks are under **Past minutes**). Before the meeting, **No update** shows who has added nothing yet, with a reminder to copy; from Thursday, everyone gets a nudge to **plan next week**. **Manage** is a window over the page: People (add a person, reset a password, switch off sign-in), Projects, Departments & teams and 3rd parties. Changes from teammates appear **live**. The look follows the ACS *Dashboard Facelift* design, in light and dark. Everything is stored in a free **Supabase** database (Postgres).

| My tasks (phone) | A task (phone) | Everyone, as a board (phone) | Everyone, with a task open (computer) |
|---|---|---|---|
| ![My tasks on a phone](docs/screenshots/2-board.png) | ![A task on a phone](docs/screenshots/2b-task-sheet.png) | ![The board on a phone](docs/screenshots/3-by-person.png) | ![The page on a computer](docs/screenshots/4-board-wide.png) |

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
- **Login**: Supabase Auth with email + password. People type a short username, and `@advcontrolsys.com` is added automatically. Admins create accounts and reset passwords in **Manage › People**.
- **The data is easy to view and edit** in Supabase's Table Editor, and can be exported to CSV.

## Repository layout

| Path | What it is |
|---|---|
| `frontend/` | The app: static site deployed to GitHub Pages |
| `frontend/js/config.js` | Supabase Project URL + publishable key (both public by design) |
| `frontend/js/api.js` | Data layer: one-request loading, local cache, conflict-safe saving |
| `frontend/js/app.js` | The one page (search and filter, List / Board / Table, the task and project panel, minutes) and Manage |
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
npm run preview                          # try the app on made-up data, no database: http://localhost:4173
```

**Changing the database:** add a new file to `supabase/migrations/` (see the [rules](supabase/migrations/README.md)), run `npm run build:setup`, and add a check to `tests/db/security.test.sql` if it changes who can see or do what.

**Every push** to a branch runs the checks on GitHub. On `main`, nothing is published unless they pass.
