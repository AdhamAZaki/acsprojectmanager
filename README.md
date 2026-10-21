# ACS Project Tracker (acsprojectmanager)

A weekly project-update and minutes-of-meeting tool for the ACS PLC / AVEVA development team.

Each engineer signs in with a **username and password** (managed in the Google Sheet), sees the projects assigned to them, and records:

- what they did this week
- what they plan to do next week
- blockers or support needed, status, and % progress

Everything is stored in a **Google Sheet** on Google Drive. Admins get a weekly report, ready to use as the minutes of the meeting (with copy-as-text and print-to-PDF), and they manage projects, the team and assignments.

![My week](docs/screenshots/3-my-week.png)

## Architecture

```
 Browser (GitHub Pages)                Google Apps Script (web app)          Google Sheet
 ┌────────────────────────┐   HTTPS    ┌─────────────────────────────┐        ┌──────────────┐
 │ frontend/  HTML/CSS/JS │ ─────────▶ │ backend/  doPost API        │ ─────▶ │ Projects     │
 │                        │            │  • checks username/password │        │ Team         │
 │  username + password   │            │  • issues signed session    │        │ Assignments  │
 └────────────────────────┘            │  • enforces roles           │        │ WeeklyUpdates│
                                       └─────────────────────────────┘        │ Meetings     │
                                                                              └──────────────┘
```

- **Login**: usernames and passwords are kept in the **Team** tab. A plain password typed in by an admin is replaced by a salted hash on that person's first login. Accounts lock for 15 minutes after 5 failed attempts.
- **Roles**: `Member` can edit only their own updates on projects assigned to them. `Admin` can also manage projects, team and assignments, and sees the weekly report.
- **No secrets in this repo**: the session-signing secret is generated in Apps Script and kept in Script Properties.

## Repository layout

| Path | What it is |
|---|---|
| `frontend/` | Static site deployed to GitHub Pages |
| `frontend/js/config.js` | The only file you edit: the backend URL |
| `backend/` | Google Apps Script source (copy into the Sheet's Apps Script project, or push with `clasp`) |
| `docs/SETUP.md` | Step-by-step setup guide |
| `.github/workflows/pages.yml` | Auto-deploys `frontend/` on every push to `main` |

## Getting started

Follow **[docs/SETUP.md](docs/SETUP.md)** (about 10 minutes):

1. Create the Google Sheet (or use the TEST one) and add users to the **Team** tab
2. Paste the Apps Script backend into the Sheet, run `setup()`, and deploy it as a web app
3. Put the web app URL in `frontend/js/config.js` and turn on GitHub Pages
