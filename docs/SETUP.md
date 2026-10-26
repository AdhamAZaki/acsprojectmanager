# Setup guide (Supabase)

The site is at **https://adhamazaki.github.io/acsprojectmanager/**. The data lives in a free **Supabase** project.

> **This repository is public.** Never commit passwords, the real team list, or anything else private. The scripts below are templates: fill in the real values in the Supabase SQL Editor (or in a `*.local.sql` file, which git ignores).

---

## 1. Create the database (one time, about 2 minutes)

1. In Supabase, open your project → **SQL Editor** → **New query**.
2. Open <https://raw.githubusercontent.com/AdhamAZaki/acsprojectmanager/main/supabase/setup.sql>, select all (Ctrl+A) and copy (Ctrl+C).
3. Paste it into the SQL Editor and click **Run**. You should see `ACS Project Tracker setup complete`.

It is safe to run again: it creates what is missing and never deletes data. Run it again whenever it changes (or set up automatic updates, step 6). It creates no people or projects (see steps 3 and 4).

`setup.sql` is generated from the files in `supabase/migrations/`; don't edit it by hand.

## 2. Turn off public sign-up (important)

**Authentication → Sign In / Providers → "Allow new users to sign up" → OFF.**

As a second safety net, every new account starts **inactive** (it can't see anything) unless an admin created it from the app's **Team** page. The only exception is the very first account in an empty database, which becomes an active admin.

If you add someone in **Authentication → Users → Add user** instead of the app, open **Manage → Team**, tap them, and tick **Active**.

## 3. Import the real team and projects

`supabase/import-team.example.sql` creates an account for each person, sets their PLC / Dev team, creates the projects and assigns people to them. The file only holds example rows, so the real names stay out of this public repository.

1. Open <https://raw.githubusercontent.com/AdhamAZaki/acsprojectmanager/main/supabase/import-team.example.sql> and copy it into the SQL Editor.
2. Replace the example people (username, full name, role, team) and projects with the real ones. The script refuses to run while the examples are still there.
3. Change `v_password := 'CHANGE-ME'` to a temporary password. Leave `v_remove_dummy := true` to delete any test data.
4. Click **Run**. A table of every project and its team is shown at the end.
5. Tell each engineer their username (e.g. `firstname_lastname`) and the temporary password. They should change it right away: **avatar → Change password**.

Usernames follow the company email format (`firstname_lastname@advcontrolsys.com`). If someone's address differs, edit their line, or change it later in **Authentication → Users**.

To keep your filled-in copy for next time, save it as `supabase/import-team.local.sql` on your computer. Git ignores `*.local.sql` files, so it is never pushed.

## 4. Optional: test data

`supabase/seed-test-data.sql` adds 4 test logins (`admin.test`, `ahmed.test`, `mona.test`, `omar.test`), 5 dummy projects and a few tasks for this week and next week. It only runs on a database with no projects yet.

Set `v_password` at the top to a password of your choice (it is used for all 4 logins), then run it. Remove the test data later with the import script (`v_remove_dummy := true`).

## 5. Connect the website

`frontend/js/config.js` holds the **Project URL** and the **Publishable key**. Both are designed to be public; the data is protected by the database's security rules.

## 6. Optional: automatic database updates

When the repository secret `SUPABASE_DB_URL` is set, every deploy from `main` first runs `supabase/setup.sql` against the live database, then publishes the website. It runs in one transaction, so if anything fails the database is left as it was and the website is not published. Without the secret, the deploy skips this step and shows a note; paste `setup.sql` by hand instead.

To set it up:

1. In Supabase, click **Connect** (top of the project page) → **Session pooler**, and copy the URI. It looks like
   `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Use the *session pooler*: GitHub's servers can't reach the direct connection address.
2. Put your database password in place of `[YOUR-PASSWORD]`. If the password contains symbols like `@`, `#` or `/`, either reset it to letters and numbers (**Project Settings → Database → Reset database password**) or URL-encode them.
3. In GitHub: **Settings → Environments → New environment**, name it `database`.
   - Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.
   - Under **Environment secrets**, add a secret named `SUPABASE_DB_URL` with the URI as its value.

The secret gives full access to the database. Keeping it in the `database` environment, limited to `main`, means a workflow on any other branch can't read it.

## Old test accounts (security fix)

Earlier versions of `setup.sql` created `*.test` accounts with passwords written in this repository. Running the latest `setup.sql` finds any test account still using one of those passwords, gives it a random password, signs it out everywhere, and deactivates it.

To check that no test accounts are left, run this in the SQL Editor (it should return no rows, or only inactive ones):

```sql
select email, role, active from public.profiles where email like '%.test@%';
```

### Locked out?

If `admin.test` was your only admin, the script keeps it active but changes its password, so you can't sign in with it any more. Create your own admin account in the SQL Editor (it runs with full rights there):

```sql
select public._create_login('firstname_lastname@advcontrolsys.com', 'a-strong-password', 'Your Name', 'admin');
```

Then sign in with it, and delete the `*.test` users in **Authentication → Users**.

## How the app works (v3 "Weekly Tasks")

- **My tasks:** two tabs, *This week* and *Next week*. Type a task, pick the project, tap Add. Tap a task to add sub-tasks, people, a Blocked note, or move it to the other week. Unfinished tasks from earlier weeks stay in *This week* until they are done.
- **Projects:** everyone sees every project. *My projects* first; *Other projects* have a **Join** button (instant, no admin needed). A project page shows everyone's tasks grouped by the person assigned (or the creator, if nobody is assigned), and **Leave**.
- **Meeting:** built from tasks, one card per project listing each assigned person's tasks (Done, In progress, Next week), with blocked items at the top. A task goes in the PLC or Dev column of the people assigned to it. **Copy as email** gives the *Weekly Progress Check & Action Plan* table, ready to paste into Zoho Mail.
- **Saved minutes:** the Meeting tab changes as tasks change. After the meeting, an admin taps **Save minutes** to keep a fixed copy of that week. Saved weeks open on the saved copy (with **Show live tasks** to compare); unsaved past weeks say they are rebuilt from today's tasks.
- **Past minutes:** everyone can open **Past minutes** on the Meeting tab to see every saved week and jump to one.
- **No update yet (admins):** the Meeting tab lists active people who are on an open project but haven't added or changed any of their tasks this week (or planned anything for it). **Copy reminder** copies a short message naming them, ready to paste into the team chat.
- **Plan next week:** from Thursday, anyone with nothing planned for next week sees a nudge on *My tasks* to add it. **Later** hides it for that week on that device.
- **Manage (admins):** projects, team (set each person's **PLC / Dev** team, which decides their column in the meeting, and whether they are **Active**), and 3rd parties.
- **Live updates:** when a teammate changes a task you see it within a second ("Updated by a teammate"). Two people editing the same task at once don't overwrite each other: each save only changes the fields that person changed.
- **New week:** an app left open moves on to the new week by itself on Monday.
- **App updates:** every deploy gets a new version number automatically; installed apps update themselves the next time they are opened or left.

### How usernames work
A username like `ahmed` signs in as `ahmed@advcontrolsys.com`. The domain is set by `EMAIL_DOMAIN` in `config.js`. When adding a member you can also type a full email address, for someone outside the company domain.

## The old `weekly_updates` table
The first versions of the app stored weekly updates in `weekly_updates`. The app no longer uses it, but it is kept so no old data is lost. To check whether it has anything in it, run `select count(*) from weekly_updates;`. If you want it gone, export it first (Table Editor → ⋯ → Export to CSV), then add a migration that drops it.

## Viewing and editing the data
- **Supabase → Table Editor** shows every table like a spreadsheet: you can filter, sort and edit cells, and export to CSV from the **⋯** menu.
- Tasks store people by id. To see names, run this in the SQL Editor:
  ```sql
  select t.week, pr.name as project, t.title, t.status, t.block_note, p.name as created_by
  from tasks t join projects pr on pr.id = t.project_id left join profiles p on p.id = t.created_by
  order by t.week desc, pr.name;
  ```

## Security model
Every rule is enforced inside the database, not just in the website:
- **Members** see every project and the team list, and can join or leave projects themselves.
- They see and edit the **tasks** on projects they are on, plus tasks they created or are assigned to. They can't change who created a task, or move a task into a project they are not on.
- **Admins** see everything, and manage projects, the team, assignments and 3rd parties.
- **Signed-out visitors** can't read anything.
- **New accounts start inactive** unless an admin created them from the app.
- **Deactivated members** (Active unticked) are refused at sign-in, and all their access stops.
- The last active admin can't be demoted or deactivated.

## Keeping the free project awake
Free Supabase projects pause after 7 days without activity. The **Keep Supabase awake** GitHub Action pings the database every day. GitHub switches off scheduled actions after 60 days without commits, so the action also switches itself back on every run. If a run fails, GitHub emails the repository owner. If the project ever does pause, click **Restore project** in the Supabase dashboard.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Wrong username or password" | Check the user exists (Team page or Authentication → Users), the username spelling, and the password. |
| "Your account is not active" | An admin must tick **Active** for that member on the Team page. |
| "Cannot reach the server" | Check `SUPABASE_URL` in `config.js`, and that the project isn't paused. |
| "You are not allowed to do that" | The action needs admin rights, or the project isn't assigned to you. |
