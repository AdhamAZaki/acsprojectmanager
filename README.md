# ACS Project Tracker (acsprojectmanager)

A weekly project-update and minutes-of-meeting tool for the ACS PLC / AVEVA development team.

Each engineer signs in with a **username and password**, sees the projects assigned to them, and records:

- what they did this week
- what they plan to do next week
- blockers or support needed, status, and % progress

Everything is stored in a free **Supabase** database (Postgres). Admins get a weekly report, ready to use as the minutes of the meeting (with copy-as-text and print-to-PDF), and they manage projects, the team and assignments.

![My week](docs/screenshots/3-my-week.png)

## Architecture

```
 Browser (GitHub Pages)                         Supabase (free plan)
 ┌────────────────────────┐   HTTPS    ┌───────────────────────────────────────┐
 │ frontend/  HTML/CSS/JS │ ─────────▶ │ Auth: usernames + hashed passwords     │
 │  supabase-js           │            │ Postgres: profiles, projects,          │
 │                        │            │   assignments, weekly_updates, meetings│
 └────────────────────────┘            │ Row Level Security = who can do what   │
                                       └───────────────────────────────────────┘
```

- **No server of our own**: the website talks to Supabase directly. Every request takes a fraction of a second.
- **Security is enforced in the database** (`supabase/setup.sql`):
  - **Members** see and edit only their own updates, on projects assigned to them.
  - **Admins** manage projects, the team, assignments and meetings.
  - **Signed-out visitors** see nothing.
- **Login**: Supabase Auth with email + password. People type a short username, and `@advcontrolsys.com` is added automatically. Admins create accounts and reset passwords from the **Team** page.
- **The data is easy to view and edit** in Supabase's Table Editor, and can be exported to CSV.

## Repository layout

| Path | What it is |
|---|---|
| `frontend/` | Static site deployed to GitHub Pages |
| `frontend/js/config.js` | Supabase Project URL + publishable key (both public by design) |
| `frontend/js/api.js` | Data layer: one-request loading + local cache for instant start |
| `frontend/sw.js`, `manifest.webmanifest` | Installable app (Add to Home screen) and offline app shell |
| `supabase/setup.sql` | Creates the tables, security rules, admin functions and test data. Paste into the SQL Editor. |
| `docs/SETUP.md` | Setup guide, test logins, and how to go live |
| `.github/workflows/pages.yml` | Auto-deploys `frontend/` on every push to `main` |
| `.github/workflows/keep-alive.yml` | Daily ping so the free Supabase project never pauses |

## Getting started

Follow **[docs/SETUP.md](docs/SETUP.md)**:

1. Paste `supabase/setup.sql` into Supabase's SQL Editor and click **Run**
2. Turn off public sign-up in Supabase Auth settings
3. Sign in at https://adhamazaki.github.io/acsprojectmanager/
