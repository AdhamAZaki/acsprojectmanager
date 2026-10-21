# Setup guide

You need a Google account that will own the Sheet, and admin rights on this GitHub repo.
The site will be at **https://adhamazaki.github.io/acsprojectmanager/**.

---

## 1. Google Sheet

Create a Google Sheet. A test one with dummy data already exists: **ACS Project Tracker → ACS Project Tracker - Data (TEST)** in Google Drive.
It needs these tabs, each with headers in row 1. The `setup()` function in step 2 creates any that are missing.

| Tab | Columns |
|---|---|
| **Projects** | ProjectID, Name, Type (PLC / AVEVA / Other), Client, Manager, Status (Active / On Hold / Completed / Closed), StartDate, EndDate, Notes |
| **Team** | Username, Password, Name, Role (Admin / Member), Active (checkbox) |
| **Assignments** | ProjectID, Username, with one row per person per project |
| **WeeklyUpdates** | Written by the app. Don't edit by hand. |
| **Meetings** | Written by the app. Don't edit by hand. |

### Users and passwords

- Add a row to **Team** for each person, with a username and a starting password, and tick **Active**.
- On a person's **first login**, the app replaces their password with a scrambled version (a salted hash, starting with `$h1$`) that can't be turned back into the password. After that, nobody can read it from the Sheet.
- **To reset a password,** type a new plain password into the cell. People can also change their own password in the app with **Change password**.
- **To block someone,** untick **Active**.
- An account locks for 15 minutes after 5 wrong passwords.
- **Keep the Sheet shared with admins only.** Team members don't need access to it; they only use the website.

## 2. Backend (Apps Script)

1. In the Sheet, open **Extensions → Apps Script**.
2. Open <https://raw.githubusercontent.com/AdhamAZaki/acsprojectmanager/main/backend/ALL-IN-ONE.gs>, select all (Ctrl+A) and copy (Ctrl+C).
   In Apps Script, click `Code.gs`, select all, delete, paste (Ctrl+V), then save (Ctrl+S).
   (`ALL-IN-ONE.gs` is all of `backend/*.gs` combined. Regenerate it with `tools/bundle-backend.sh` after editing those files.)
3. Choose the `setup` function in the toolbar and press **Run**. Approve the permission prompt (Advanced → Go to project). This adds dropdowns and checkboxes and creates the session secret. It never deletes data.
4. Click **Deploy → New deployment → Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

> "Anyone" only means the URL is reachable. Every request apart from sign-in needs a valid session, which is only issued to an Active Team member with the right password.

> When you change backend code later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

## 3. Frontend + GitHub Pages

1. Put the `/exec` URL into `frontend/js/config.js` as `APPS_SCRIPT_URL`, then commit and push to `main`.
2. On GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to **Actions → Deploy frontend to GitHub Pages → Run workflow** (or just push). The site goes live at the URL above.

## 4. Weekly use

- **Engineers** sign in, open **My week**, and fill in each assigned project. They can save each project separately or use **Save all**.
- **Admins** open **Weekly report** in the meeting. It shows every update grouped by project and who is missing. From there you can **Copy as text**, **Print / PDF**, or **Record meeting** to save decisions and action items under **Meetings**.
- **Projects**, **team members** and **assignments** can be managed in the app (Projects / Team tabs) or straight in the Sheet.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot reach the server" | Check `APPS_SCRIPT_URL` and that the deployment access is **Anyone**. |
| "Wrong username or password" | Check the Team row: username spelling, password, and that **Active** is ticked. |
| "Too many failed attempts" | Wait 15 minutes, or reset the password in the Sheet. |
| Backend change has no effect | Deploy a **new version** of the existing deployment. |
