# Setup guide (Supabase)

The site is at **https://adhamazaki.github.io/acsprojectmanager/**. The data lives in a free **Supabase** project.

---

## 1. Create the database (one time, about 2 minutes)

1. In Supabase, open your project → **SQL Editor** → **New query**.
2. Open <https://raw.githubusercontent.com/AdhamAZaki/acsprojectmanager/main/supabase/setup.sql>, select all (Ctrl+A) and copy (Ctrl+C).
3. Paste it into the SQL Editor and click **Run**. You should see `ACS Project Tracker setup complete`.

It is safe to run again: it creates what is missing and never deletes data.

## 2. Turn off public sign-up (important)

**Authentication → Sign In / Providers → "Allow new users to sign up" → OFF.**
Only admins should create accounts. They do it from the app's **Team** page, or in **Authentication → Users → Add user**.

## 3. Connect the website

`frontend/js/config.js` holds the **Project URL** and the **Publishable key**. Both are designed to be public; the data is protected by the database's security rules.

## Test logins (created by the setup script)

| Username | Password | Role |
|---|---|---|
| `admin.test` | `Admin@2026` | Admin |
| `ahmed.test`, `mona.test`, `omar.test` | `Test@2026` | Member |

The setup script also adds 5 dummy projects, assignments, 3 sample updates (week 42) and 1 sample meeting.

## Importing the real team and projects

`supabase/import-acs-team.sql` creates the 15 projects from the *Projects List* sheet and an account for each of the 14 engineers plus `adham_zaki` (Admin). Each engineer is assigned to their projects exactly as in the sheet.

1. Open <https://raw.githubusercontent.com/AdhamAZaki/acsprojectmanager/main/supabase/import-acs-team.sql> and copy it.
2. In the SQL Editor, paste it, then change `v_password := 'CHANGE-ME'` to a temporary password. Leave `v_remove_dummy := true` to delete the test data.
3. Click **Run**. A table of every project and its team is shown at the end.
4. Tell each engineer their username (e.g. `ahmed_hamdy`) and the temporary password. They should change it right away: **avatar → Change password**.

Usernames follow the company email format (`firstname_lastname@advcontrolsys.com`). If someone's address differs, edit their line in the script, or change it later in **Authentication → Users**.

## How the app works (v3 "Weekly Tasks")

- **My tasks:** two tabs, *This week* and *Next week*. Type a task, pick the project, tap Add. Tap a task to add sub-tasks, people, a Blocked note, or move it to the other week. Unfinished tasks from earlier weeks stay in *This week* until they are done.
- **Projects:** everyone sees every project. *My projects* first; *Other projects* have a **Join** button (instant, no admin needed). A project page shows everyone's tasks grouped by person, and **Leave**.
- **Meeting:** built from tasks, one card per project with PLC team / Dev team columns (Done, In progress, Next week) and blocked items at the top. **Copy as email** gives the *Weekly Progress Check & Action Plan* table, ready to paste into Zoho Mail.
- **Manage (admins):** projects, team (set each person's **PLC / Dev** team, which decides their column in the meeting), and 3rd parties.
- **Live updates:** when a teammate changes a task you see it within a second ("Updated by a teammate").

## Going live with real data

The quickest way is the import above. To set things up by hand instead:

1. Logged in as `admin.test`, go to **Manage → Team → Member** and create **your own admin account**: set Role = Admin.
2. Sign in with your new account. Add the real engineers on **Team**, and the real projects (with assigned engineers) on **Projects**.
3. Remove the dummy data in **Supabase → Table Editor**:
   - **weekly_updates** and **meetings**: delete the dummy rows.
   - **projects**: delete the dummy projects. Their assignments and updates are removed with them.
   - **Authentication → Users**: delete the `*.test@advcontrolsys.com` users.

### How usernames work
A username like `ahmed` signs in as `ahmed@advcontrolsys.com`. The domain is set by `EMAIL_DOMAIN` in `config.js`. When adding a member you can also type a full email address, for someone outside the company domain.

## Viewing and editing the data
- **Supabase → Table Editor** shows every table like a spreadsheet: you can filter, sort and edit cells, and export to CSV from the **⋯** menu.
- `weekly_updates` and `assignments` store people by id. To see names, use the app's **Weekly report**, or run this in the SQL Editor:
  ```sql
  select w.week, p.name, pr.name as project, w.done, w.next, w.blockers, w.status, w.progress
  from weekly_updates w join profiles p on p.id = w.user_id join projects pr on pr.id = w.project_id
  order by w.week desc, pr.name;
  ```

## Security model
Every rule is enforced inside the database, not just in the website:
- **Members** see only their own projects and updates. They can only write updates for projects assigned to them.
- **Admins** see everything, and manage projects, assignments, the team and meetings.
- **Signed-out visitors** can't read anything.
- **Deactivated members** (Active unticked) are refused at sign-in, and all their access stops.
- The last active admin can't be demoted or deactivated.

## Keeping the free project awake
Free Supabase projects pause after 7 days without activity. The **Keep Supabase awake** GitHub Action pings the database every day. If the project ever does pause, click **Restore project** in the Supabase dashboard.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Wrong username or password" | Check the user exists (Team page or Authentication → Users), the username spelling, and the password. |
| "Your account is disabled" | An admin must tick **Active** for that member on the Team page. |
| "Cannot reach the server" | Check `SUPABASE_URL` in `config.js`, and that the project isn't paused. |
| "You are not allowed to do that" | The action needs admin rights, or the project isn't assigned to you. |
