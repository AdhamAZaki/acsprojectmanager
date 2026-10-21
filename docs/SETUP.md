# Setup guide

You need: a Google account that will own the Sheet, a Zoho admin (or any ACS Zoho user) to register the app, and admin rights on this GitHub repo.

Your Pages URL will be `https://adhamazaki.github.io/acsprojectmanager/`. It's written below as **PAGES_URL**.

---

## 1. Google Sheet + backend

1. In Google Drive, create a new **Google Sheet** called `ACS Project Tracker`.
   (If you have an existing .xlsx, open it, choose **File → Save as Google Sheets**, and use the copy.)
2. In the Sheet, open **Extensions → Apps Script**.
3. Recreate the files from `backend/` in this repo:
   - Replace the contents of `Code.gs` with `backend/Code.gs`.
   - Add the script files `Auth`, `Sheets`, `Actions` and `Setup` (with **+ → Script**) and paste in the matching files.
   - Under **Project Settings**, tick **Show "appsscript.json" manifest file in editor**, then replace its contents with `backend/appsscript.json`. Change `timeZone` if you're not in Cairo time.
4. In `Setup.gs`, set `FIRST_ADMIN_EMAIL` to **your Zoho email**.
5. Choose the `setup` function in the toolbar and press **Run**. Approve the permission prompt. The Sheet now has these tabs: Projects, Team, Assignments, WeeklyUpdates, Meetings.
6. **Optional**: under **Project Settings → Script Properties**, add:
   | Property | Value | When |
   |---|---|---|
   | `ZOHO_ACCOUNTS_URL` | e.g. `https://accounts.zoho.eu` | Only if your Zoho account isn't on `accounts.zoho.com` (check the address bar when you log in to Zoho) |
   | `ALLOWED_DOMAIN` | `advcontrolsys.com` | This is the default; change it only if needed |
   `SESSION_SECRET` is created automatically. Never share it.
7. Click **Deploy → New deployment → Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

> "Anyone" only means the URL is reachable. Every request apart from sign-in needs a valid session, which is only issued to Active team members.

> When you change backend code later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

## 2. Zoho sign-in

1. Go to <https://api-console.zoho.com> (use the `.eu`, `.in` etc. version if that's your data centre) and sign in with your ACS account.
2. Click **Add Client → Client-based Applications**.
3. Fill in:
   - **Client Name:** ACS Project Tracker
   - **Homepage URL:** PAGES_URL
   - **Authorized Redirect URIs:** PAGES_URL, exactly, including the trailing `/`
   - **JavaScript Domain:** `https://<github-user>.github.io`
4. Click **Create** and copy the **Client ID**.

## 3. Frontend config + GitHub Pages

1. Edit `frontend/js/config.js`:
   ```js
   APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfy.../exec',
   ZOHO_CLIENT_ID: '1000.XXXXXXXX',
   ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',   // same data centre as above
   ```
   Commit and push to `main`.
2. On GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Deploy frontend to GitHub Pages**, and click **Run workflow** (or just push). The site goes live at PAGES_URL.

## 4. First use

1. Open PAGES_URL and click **Sign in with Zoho** using the admin email you set in step 1.4.
2. Under **Team**, add each engineer with their Zoho email.
3. Under **Projects**, add the PLC / AVEVA projects and tick the engineers assigned to each one.
   (You can also paste rows straight into the Projects / Team / Assignments tabs of the Sheet.)
4. Share PAGES_URL with the team. Each person signs in and fills in **My week**.
5. In the weekly meeting, an admin opens **Weekly report**. Use **Record meeting** to save decisions and action items under **Meetings**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Zoho says "Invalid Redirect Uri" | The redirect URI in the Zoho console must match the page URL exactly, including the trailing `/`. Or set `REDIRECT_URI` in `config.js`. |
| "Zoho sign-in could not be verified" | `ZOHO_ACCOUNTS_URL` in Script Properties and in `config.js` must both use your data centre. |
| "not on the team list" | Add the email to the **Team** tab with **Active** ticked. |
| "Cannot reach the server" | Check `APPS_SCRIPT_URL`, and confirm the deployment's access is **Anyone**. |
| Backend change has no effect | Deploy a **new version** of the existing deployment. |
