// Browser tests: drive the real app (frontend/) in Chromium against an in-memory
// fake of Supabase (tests/e2e/fake-supabase.js). Run: npm run test:e2e
//
// Seed (fake-supabase.js): Adham (Admin, Automation), Mona (PLC), Omar (AVEVA = Automation Dev),
// Hany (BMS Dept admin), Laila (BMS), Tamer (BMS), Amira (GUI Dept admin, UI/UX), Gina (GUI Dev).
// PRJ-0001 Alpha Plant (Adham, Mona on it), PRJ-0002 Tower BMS Retrofit (Hany, Laila on it).
const { launch, serve, newApp, signIn } = require('./harness');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Reads the clipboard once it holds the copied text (writing it is asynchronous; a fixed wait was flaky on CI).
async function clipboard(page, marker) {
  let text = '';
  for (let i = 0; i < 30 && !text.includes(marker); i++) { await sleep(100); text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => ''); }
  return text;
}
const T1 = 'Commission the pump station panels';      // Adham's, Alpha Plant
const T2 = 'Wire the remote IO cabinet';              // Mona's, Alpha Plant
const GUI_T = 'GUI: AHU screens for the tower';       // Gina's, Tower BMS Retrofit
const BMS_T = 'Survey the AHU controllers on every floor';   // Laila's, Tower BMS Retrofit
const nav = page => page.$$eval('.appnav a', as => as.map(a => a.textContent.trim()).join(','));
const db = page => page.evaluate(() => window.__db.get());
const task = async (page, title) => (await db(page)).tasks.find(t => t.title === title);

// ---------- Sign in, My tasks, adding tasks ----------
async function myTasks(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.fill('input[name=username]', 'nobody');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#loginError:not([hidden])');
  ok((await page.textContent('#loginError')).includes('Wrong username or password'), 'unknown user gets a clear sign-in error');

  await signIn(page, url + '#/', 'adham');
  ok(await nav(page) === 'My tasks,Team,Projects,Manage', 'admin: My tasks, Team, Projects, Manage — each once');
  ok(await page.textContent('.page-title h2') === 'All teams', 'admin starts on Team, all teams');
  await page.click('.appnav a[href="#/my"]');
  await page.waitForSelector('.page-title >> text=My tasks');
  ok(await page.isVisible(`.pcard >> text=${T1}`), 'My tasks shows my own task');
  ok(!(await page.isVisible(`#view >> text=${T2}`)), 'My tasks shows only my own tasks (not Mona’s)');
  ok(await page.locator('.filters select').count() === 1 && await page.locator('#teamFilter, #whoFilter').count() === 0,
    'My tasks has one simple filter row: week, search, layout (no team / person filters)');

  // Add (the + Add task button opens the sheet; "For" starts on me)
  await page.click('#addTaskBtn');
  await page.waitForSelector('#qaForm');
  ok(await page.inputValue('#qaForm select[name=person]') === (await db(page)).users.adm.id, 'admin: the For box starts on me');
  ok(await page.getAttribute('[data-qp].on', 'data-qp') === 'PRJ-0001', 'add: my only project is picked');
  await page.fill('#qaForm textarea[name=title]', 'Test the duty and standby pump logic');
  await page.click('#qaForm button[type=submit]');
  await sleep(400);
  const added = await task(page, 'Test the duty and standby pump logic');
  ok(added && added.project_id === 'PRJ-0001' && added.status === 'To Do' && added.week === (await db(page)).W, 'new task saved to the project, this week');
  ok(await page.inputValue('#qaForm textarea[name=title]') === '', 'the sheet stays open and clears for the next task');
  await page.click('#qaForm [data-qw]:nth-child(2)');
  await page.fill('#qaForm textarea[name=title]', 'Prepare the FAT procedure document');
  await page.click('#qaForm button[type=submit]');
  await sleep(300);
  await page.fill('#qaForm textarea[name=title]', 'Book the site visit with the client');
  await page.click('#qaForm button[type=submit]');
  await sleep(400);
  const snap = await db(page);
  ok(snap.tasks.filter(t => /Prepare the FAT|Book the site visit/.test(t.title) && t.week > snap.W).length === 2, 'next week stays chosen for the following task');
  // For someone else (admin)
  await page.selectOption('#qaForm select[name=person]', snap.users.mona.id);
  await page.click('#qaForm [data-qw]:first-child');
  await page.fill('#qaForm textarea[name=title]', 'Mona: loop check the dosing skid');
  await page.click('#qaForm button[type=submit]');
  await sleep(400);
  const forMona = await task(page, 'Mona: loop check the dosing skid');
  ok(forMona && forMona.created_by === snap.users.mona.id && forMona.assignee_ids.join() === snap.users.mona.id, 'admin adds a task for someone else (it is theirs)');
  await page.click('#qaForm [data-close]');
  await page.waitForSelector('.pcard >> text=Prepare the FAT procedure document');
  ok(await page.isVisible('.wk-label >> text=Next week'), 'My tasks splits each project into This week and Next week');
  ok(!(await page.isVisible('#view >> text=Mona: loop check the dosing skid')), 'a task added for Mona is not in my list');

  // Edit a task in place: done, blocked with a reason, next week
  await page.click(`.t-body:has-text("${T1}")`);
  await page.waitForSelector('[data-block]');
  await page.click('.t-open [data-block]');
  await page.click('[data-reason$="Material"]');
  await sleep(300);
  let t1 = await task(page, T1);
  ok(t1.status === 'Blocked' && t1.block_note === 'Material', 'block a task with a one-tap reason');
  await page.click(`.t-check[data-done="${t1.id}"]`);
  await sleep(300);
  t1 = await task(page, T1);
  ok(t1.status === 'Done', 'tick a task done');
  // People on a task: one dropdown ("Name — Team"), name tags with ×
  await page.click(`[data-pfold="${t1.id}"] summary`);
  const opt = await page.$eval(`[data-asgsel="${t1.id}"]`, s => Array.from(s.options).map(o => o.textContent).find(x => /Mona/.test(x)));
  ok(/Mona PLC — PLC/.test(opt || ''), 'people dropdown shows “Name — Team” (' + opt + ')');
  const monaId = (await db(page)).users.mona.id;
  await page.selectOption(`[data-asgsel="${t1.id}"]`, monaId);
  await sleep(400);
  ok((await task(page, T1)).assignee_ids.indexOf(monaId) !== -1 && await page.isVisible(`.people-tags .person-chip:has-text("Mona PLC") .tchip`), 'add a person from the dropdown; they show as a name tag with their team');
  await page.click(`[data-unasg="${t1.id}:${monaId}"]`);
  await sleep(400);
  ok((await task(page, T1)).assignee_ids.indexOf(monaId) === -1, 'take a person off with ×');

  // Board layout: four columns; drag a task to Doing
  await page.click('[data-layout="board"]');
  await page.waitForSelector('.board4');
  ok(await page.locator('.bcol').count() === 4 && await page.isVisible('.bcol[data-col="Done"] >> text=' + T1), 'Board: To do · Doing · Blocked · Done');
  await page.dragAndDrop('.bcard:has-text("Test the duty and standby")', '.bcol[data-col="In Progress"]');
  await sleep(400);
  ok((await task(page, 'Test the duty and standby pump logic')).status === 'In Progress', 'drag a card to Doing changes its status');
  await page.selectOption('#myCol', 'week');
  await page.waitForSelector('.bcol .bcol-head >> text=next week');
  await page.dragAndDrop('.bcard[data-drag]:has-text("Test the duty and standby")', '.bcol[data-drop^="week|"]:has(.bcol-head:has-text("next week"))');
  await sleep(400);
  ok((await task(page, 'Test the duty and standby pump logic')).week > (await db(page)).W, 'Board columns by week: drag a card to next week');
  await page.selectOption('#myCol', 'status');
  await page.click('.bcard:has-text("Test the duty and standby")');
  await page.waitForSelector('#dialog[data-mode="task"] .t-open');
  ok(true, 'tap a card: the task opens in a sheet');
  await page.click('#dialog [data-close]');
  await page.click('[data-layout="project"]');
  ok(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
  await ctx.close();
}

// ---------- Employees see only their own tasks; Projects to find and join ----------
async function employee(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await signIn(page, url + '#/', 'gina');
  ok(await nav(page) === 'My tasks,Projects', 'employee: only My tasks and Projects');
  ok(await page.isVisible(`.pcard >> text=${GUI_T}`), 'employee: My tasks shows her task on a BMS project');
  const gid = (await db(page)).users.gina.id;
  const tasks = (await page.evaluate(() => JSON.parse(localStorage.getItem('acs-tracker-cache-v5')))).tasks;
  ok(tasks.length === 1 && tasks.every(t => t.createdBy === gid || t.assigneeIds.indexOf(gid) !== -1), 'employee receives only her own tasks from the database');
  await page.click('.appnav a[href="#/projects"]');
  await page.waitForSelector('.prow2');
  ok(await page.locator('.prow2').count() === 2, 'Projects lists every open project (shared by all teams)');
  ok(/BMS/.test(await page.textContent('.prow2:has-text("Tower BMS Retrofit") .tchips')), 'each project shows the teams on it');
  await page.click('.prow2:has-text("Alpha Plant") [data-join]');
  await page.waitForSelector('.prow2:has-text("Alpha Plant") .joined');
  const d1 = await db(page);
  ok(d1.assignments.some(a => a.project_id === 'PRJ-0001' && a.user_id === d1.users.gina.id), 'employee joins a project in one tap');
  await page.click('.prow2:has-text("Alpha Plant") [data-addto]');
  await page.waitForSelector('#qaForm');
  ok(await page.locator('#qaForm select[name=person]').count() === 0, 'employee adds tasks only for herself (no For box)');
  ok(await page.inputValue('#qaForm select[name=other]') === 'PRJ-0001' || await page.getAttribute('[data-qp].on', 'data-qp') === 'PRJ-0001', '+ Task on a project opens the sheet on that project');
  await page.click('#qaForm [data-close]');
  await page.click('.prow2-main:has-text("Tower BMS Retrofit")');
  await page.waitForSelector('.side-panel');
  const panel = await page.textContent('.side-panel');
  ok(panel.includes(GUI_T) && !panel.includes(BMS_T), 'project panel: an employee sees her own tasks there, not colleagues’');
  ok(/Laila/.test(panel), '...but sees who is on the project');
  ok(await page.locator('.side-panel #assignSel').count() === 0, 'employees cannot add people to a project');
  await page.keyboard.press('Escape');
  await page.goto(url + '#/team');
  await page.waitForSelector('.page-title');
  ok(await page.textContent('.page-title h2') === 'My tasks', 'employee cannot open Team (lands on My tasks)');
  await page.goto(url + '#/manage');
  await page.waitForSelector('.page-title');
  ok(await page.textContent('.page-title h2') === 'My tasks', 'employee cannot open Manage');
  await ctx.close();
}

// ---------- Team: the weekly meeting (department admin) ----------
async function teamPage(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, url + '#/', 'amira');
  ok(await nav(page) === 'My tasks,Team,Projects,Manage', 'department admin: My tasks, Team, Projects, Manage');
  ok(await page.textContent('.page-title h2') === 'GUI team' && await page.inputValue('#teamFilter') === 'dept:GUI', 'department admin starts on her department');
  ok(await page.isVisible(`.pcard:has-text("Tower BMS Retrofit") >> text=${GUI_T}`), 'GUI tasks on a BMS project show on the GUI team page');
  ok(!(await page.isVisible(`.pcard >> text=${BMS_T}`)) && await page.isVisible('.others >> text=Other teams on this project'), 'other teams’ tasks on the same project are one click away');
  await page.click('[data-others="PRJ-0002"]');
  ok(await page.isVisible(`.pcard >> text=${BMS_T}`), '...Show reveals them, grouped under their team');
  ok(await page.locator('.pcard:has-text("Tower BMS Retrofit") .tgroup-head').count() === 2, 'tasks are grouped by team (BMS, Dev)');
  // Filters
  await page.selectOption('#teamFilter', 'all');
  ok(await page.isVisible(`.pcard >> text=${T2}`), 'Team: All teams shows everyone');
  const people = await page.$$eval('#whoFilter option', os => os.map(o => o.textContent));
  ok(people.length > 5, 'Person filter lists the people in the team filter');
  await page.selectOption('#teamFilter', 'team:AUTO:Dev');
  ok(await page.$eval('#teamFilter', s => s.selectedOptions[0].textContent.trim()) === 'AVEVA', 'Automation’s Dev team is called AVEVA');
  await page.selectOption('#teamFilter', 'dept:GUI');
  // Layouts
  await page.click('[data-layout="person"]');
  await page.waitForSelector('.person-card');
  ok(await page.isVisible('.person-card >> text=Gina GUI Dev'), 'By person: each person and their tasks');
  await page.click('[data-layout="table"]');
  await page.waitForSelector('.ttable');
  ok(await page.locator('.ttable tbody tr').count() >= 1, 'Table: one row per task');
  await page.click('[data-sort="person"]');
  ok(await page.isVisible('.th-btn.on >> text=Person'), 'Table sorts by a column');
  await page.click('[data-layout="board"]');
  await page.waitForSelector('.board4');
  ok(await page.isVisible(`.bcol[data-col="To Do"] >> text=${GUI_T}`), 'Board: the team’s tasks by status');
  await page.selectOption('#teamCol', 'project');
  ok(await page.isVisible(`.bcol[data-col="PRJ-0002"] >> text=${GUI_T}`), 'Board columns by project');
  await page.selectOption('#teamCol', 'team');
  ok(await page.isVisible('.bcol .bcol-head >> text=Dev') && await page.locator('.bcol[data-drop]').count() === 0, 'Board columns by team (for looking; no dropping)');
  await page.selectOption('#teamCol', 'status');
  await page.click('[data-layout="project"]');
  // Add a task for one of her people; not for others
  await page.click('#addTaskBtn');
  await page.waitForSelector('#qaForm');
  const forList = await page.$$eval('#qaForm select[name=person] option', os => os.map(o => o.textContent));
  ok(forList.some(x => /Gina/.test(x)) && !forList.some(x => /Laila|Mona/.test(x)), 'department admin adds tasks for her own people only');
  await page.click('#qaForm [data-close]');
  // Minutes: copy as email and save (GUI)
  await page.click('#copyEmail');
  const mail = await clipboard(page, 'Weekly Progress Check');
  ok(mail.includes('Weekly Progress Check') && mail.includes(GUI_T) && !mail.includes(BMS_T), 'Copy as email: the GUI minutes, only GUI tasks');
  await page.click('#saveMins');
  await page.waitForSelector('#viewSaved');
  const m = (await db(page)).meetings.find(x => x.department_id === 'GUI');
  ok(m && m.snapshot && m.snapshot.teams.join() === 'UI/UX,Dev', 'Save minutes: GUI minutes saved with UI/UX | Dev columns');
  await page.click('#viewSaved');
  await page.waitForSelector('.saved-sheet');
  ok(await page.isVisible(`.saved-sheet >> text=${GUI_T}`), 'the saved copy shows what was saved');
  await page.click('.saved-sheet [data-close]');
  await page.selectOption('#teamFilter', 'all');
  ok(await page.locator('#saveMins').count() === 0 && await page.isVisible('.meet-actions >> text=Pick a department'), 'All teams: pick a department to email or save minutes');
  await ctx.close();
}

// ---------- No update, reminder ----------
async function noUpdate(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(url);
  await page.evaluate(() => {
    const d = window.__db.get();
    const t = d.tasks.find(x => x.assignee_ids.indexOf(d.users.mona.id) !== -1);
    const [y, w] = d.W.split('-W').map(Number);
    t.week = y + '-W' + String(w - 1).padStart(2, '0');
    t.updated_at = new Date(Date.now() - 10 * 86400000).toISOString();
    window.__db.save();
  });
  await signIn(page, url + '#/team', 'adham');
  await page.selectOption('#teamFilter', 'dept:AUTO');
  const q = await page.textContent('.quiet-names');
  ok(/2\s*no update/.test(q) && q.includes('Mona') && q.includes('Omar') && !q.includes('Adham'), 'no update this week: Mona and Omar (not the admin)');
  await page.click('.quiet-names summary');
  await page.click('#copyReminder');
  const text = await clipboard(page, 'Hi ');
  ok(/^Hi Mona, Omar — please add your tasks for week \d+/.test(text), 'reminder names them: "' + text.slice(0, 50) + '…"');
  await ctx.close();
}

// ---------- Manage ----------
async function manage(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await signIn(page, url + '#/manage', 'adham');
  await page.waitForSelector('.mtabs');
  ok((await page.$$eval('.mtabs button', b => b.map(x => x.textContent))).join() === 'People,Projects,Departments & teams,3rd parties', 'admin Manage: People, Projects, Departments & teams, 3rd parties');
  ok(await page.locator('.mtable tbody tr').count() === 8, 'People: everyone, in one table');
  const ids = (await db(page)).users;
  await page.selectOption(`[data-prole="${ids.omar.id}"]`, 'Dept admin');
  await sleep(400);
  ok((await db(page)).profiles.find(p => p.id === ids.omar.id).role === 'lead', 'change a role straight in the table');
  await page.click(`[data-pactive="${ids.tamer.id}"]`);
  await sleep(400);
  ok((await db(page)).profiles.find(p => p.id === ids.tamer.id).active === false, 'switch off “can sign in”');
  await page.selectOption(`[data-pteam="${ids.mona.id}"]`, 'AUTO:Dev');
  await sleep(400);
  ok((await db(page)).profiles.find(p => p.id === ids.mona.id).team === 'Dev', 'move someone to another team');
  await page.click('[data-tab="projects"]');
  await page.waitForSelector('[data-pstat="PRJ-0002"]');
  await page.selectOption('[data-pstat="PRJ-0002"]', 'Paused');
  await sleep(400);
  ok((await db(page)).projects.find(p => p.id === 'PRJ-0002').status === 'Paused', 'change a project’s status in the table');
  await page.click('#addProject');
  await page.fill('#dialog input[name=name]', 'Harbor Water Plant');
  await page.click('#dialog button[type=submit]');
  await sleep(400);
  ok((await db(page)).projects.some(p => p.name === 'Harbor Water Plant'), 'add a project (shared by every team)');
  const hw = (await db(page)).projects.find(p => p.name === 'Harbor Water Plant');
  await page.click(`[data-medit="${hw.id}"]`);
  page.once('dialog', d => d.accept());
  await page.click('#deleteProject');
  await sleep(400);
  ok(!(await db(page)).projects.some(p => p.id === hw.id) && !(await page.isVisible(`[data-medit="${hw.id}"]`)), 'admin deletes a project (Manage › Projects › Edit › Delete project)');
  await page.click('[data-tab="depts"]');
  ok(await page.isVisible('.dept-card >> text=AVEVA') && await page.isVisible('.dept-card >> text=Management'), 'Departments & teams lists every team');
  await ctx.close();

  const c2 = await newApp(browser);
  const p2 = await c2.newPage();
  await signIn(p2, url + '#/manage', 'amira');
  await p2.waitForSelector('.mtabs');
  ok((await p2.$$eval('.mtabs button', b => b.map(x => x.textContent))).join() === 'People,Projects,3rd parties', 'department admin Manage: People, Projects, 3rd parties');
  const names = await p2.$$eval('.mtable tbody .who strong', s => s.map(x => x.textContent));
  ok(names.length === 2 && names.every(n => /GUI/.test(n)), 'department admin manages only her department’s people');
  ok(!(await p2.$$eval('.mtable [data-prole] option', os => os.map(o => o.textContent))).includes('Admin'), 'department admin cannot make anyone Admin');
  await p2.click('[data-tab="projects"]');
  await p2.click('[data-medit="PRJ-0002"]');
  ok(await p2.locator('#deleteProject').count() === 0, 'department admins have no Delete project button');
  await p2.click('#dialog [data-cancel]');
  await c2.close();
}

// ---------- Project side panel ----------
async function sidePanel(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await signIn(page, url + '#/projects', 'hany');
  await page.waitForSelector('.prow2');
  await page.click('.prow2-main:has-text("Tower BMS Retrofit")');
  await page.waitForSelector('.side-panel .sp-title');
  ok(/Tower BMS Retrofit/.test(await page.textContent('.side-panel .sp-title')), 'click a project: it opens in a side panel');
  const text = await page.textContent('.side-panel');
  ok(text.includes(BMS_T) && text.includes(GUI_T), 'a department admin sees every team’s tasks on the project');
  ok(await page.isVisible('.side-panel .team-edit #assignSel'), 'team leader: “People on this project” with + Add a person, at the top of the panel');
  const monaId = (await db(page)).users.mona.id;
  await page.selectOption('.side-panel #assignSel', monaId);
  await sleep(400);
  ok((await db(page)).assignments.some(a => a.project_id === 'PRJ-0002' && a.user_id === monaId), 'team leader adds an employee from another department to the project');
  ok(await page.isVisible('.side-panel .sp-teams .tchip'), 'the panel shows the teams on the project');
  await page.keyboard.press('Escape');
  ok(!(await page.isVisible('.side-panel')), 'Esc closes the panel');
  await ctx.close();
}

// ---------- Phone ----------
async function phone(browser, url) {
  const ctx = await newApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, url + '#/', 'adham');
  const navBox = await page.locator('.appnav').boundingBox();
  ok(navBox && navBox.y > 700, 'phone: the menu is a bottom bar');
  const add = await page.locator('#addTaskBtn').boundingBox();
  ok(add && add.width <= 60 && add.y > 600, 'phone: + Add task is a round button above the bar');
  ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no sideways scrolling (Team)');
  await page.click('.appnav a[href="#/my"]');
  await page.click(`.t-body:has-text("${T1}")`);
  await page.waitForSelector('#dialog[data-mode="task"] .t-open');
  ok(true, 'phone: a task opens in a bottom sheet');
  await page.click('#dialog [data-close]');
  for (const id of ['projects', 'manage']) {
    await page.goto(url + '#/' + id); await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no sideways scrolling (' + id + ')');
  }
  await ctx.close();
}

// ---------- The week moves on by itself ----------
async function weekRollover(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-11-01T23:58:00') });   // Sunday night, week 44
  await signIn(page, url + '#/my', 'adham');
  const before = await page.$eval('#myWeek', s => Array.from(s.options).map(o => o.textContent).join('|'));
  await page.clock.runFor(5 * 60 * 1000);                                // Monday, week 45
  await page.waitForTimeout(500);
  const after = await page.$eval('#myWeek', s => Array.from(s.options).map(o => o.textContent).join('|'));
  ok(/This week · 44/.test(before) && /This week · 45/.test(after), 'the week moves on by itself while the app stays open');
  ok(await page.locator('.tag-carry').count() >= 1, 'unfinished tasks roll over into the new week');
  await ctx.close();
}

// ---------- Private tracker (its own database; one-way link to ACS) ----------
async function privateTracker(browser, url) {
  const ctx = await newApp(browser);
  await ctx.route(/private\/config\.js/, r => r.fulfill({ contentType: 'application/javascript', body: "window.PRIVATE_CONFIG = { URL: 'https://private.test', KEY: 'test-key' };" }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await signIn(page, url + '#/my', 'adham');   // signed in to ACS on this site
  await page.evaluate(t => { const d = window.__db.get(); d.tasks.find(x => x.title === t).status = 'Done'; window.__db.save(); }, T1);
  await page.goto(url + 'private/');
  await page.fill('input[name=email]', 'adham@example.com');
  await page.fill('input[name=password]', 'wrong');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('.login .error');
  ok(true, 'private tracker: a wrong password is refused');
  await page.fill('input[name=password]', 'private-password');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#addForm');
  ok(await page.isVisible(`.pv-row:has-text("${T1}") .pv-tag.acs`), 'private tracker: my done ACS task is copied in by itself (one way)');
  await page.fill('#addForm input[name=title]', 'Private: plan the team restructure');
  await page.fill('#addForm input[name=project]', 'Management');
  await page.click('#addForm button[type=submit]');
  await page.waitForSelector('.pv-row >> text=Private: plan the team restructure');
  let d = await db(page);
  ok(d.private_tasks.some(t => t.title === 'Private: plan the team restructure') && !d.tasks.some(t => /restructure/.test(t.title)), 'a private task stays private (not in ACS)');
  // Details: status, blocked with a reason, sub-steps, notes
  await page.click('[data-open]:has-text("Private: plan the team restructure")');
  await page.waitForSelector('.pv-sheet');
  await page.click('.pv-sheet [data-st="Blocked"]');
  await page.waitForSelector('.pv-sheet [data-reason]');
  await page.click('.pv-sheet [data-reason="Approval"]');
  await page.fill('#pvNewSub', 'Draft the new structure');
  await page.click('#pvAddSub');
  await page.waitForSelector('.pv-sheet .sub >> text=Draft the new structure');
  await page.fill('#pvNotes', 'Talk to HR first');
  await page.click('.pv-sheet h3');   // leave the box: the note saves
  await sleep(300);
  const pt = (await db(page)).private_tasks.find(t => t.title === 'Private: plan the team restructure');
  ok(pt.status === 'Blocked' && pt.block_note === 'Approval' && pt.subtasks.length === 1 && pt.notes === 'Talk to HR first', 'private task details: blocked with a reason, a sub-step, notes');
  await page.click('.pv-sheet [data-close]');
  ok(await page.isVisible('.pv-row:has-text("Private: plan the team restructure") .tag-block >> text=Approval'), 'the list shows it is blocked, and why');
  // Views: board (drag) and table (sort)
  await page.click('[data-layout="board"]');
  await page.waitForSelector('.board4');
  await page.dragAndDrop('.bcard:has-text("Private: plan the team restructure")', '.bcol[data-col="In Progress"]');
  await sleep(400);
  ok((await db(page)).private_tasks.find(t => t.title === 'Private: plan the team restructure').status === 'In Progress', 'Board: drag a private task to Doing');
  // A copy from ACS is edited here and saved in ACS too (ACS is linked)
  await page.click(`.bcard:has-text("${T1}")`);
  await page.waitForSelector('.pv-sheet .mtg-note.saved');
  await page.click('.pv-sheet [data-st="In Progress"]');
  await sleep(400);
  await page.fill('#pvNewSub', 'Check panel C');
  await page.click('#pvAddSub');
  await sleep(400);
  let acsT1 = (await db(page)).tasks.find(t => t.title === T1);
  const pvT1 = (await db(page)).private_tasks.find(t => t.title === T1);
  ok(acsT1.status === 'In Progress' && acsT1.subtasks.some(x => x.t === 'Check panel C') && pvT1.status === 'In Progress',
    'a task from ACS is edited in the private page and saved in ACS too');
  ok(await page.locator('.pv-sheet #pvDelete, .pv-sheet #pvSend').count() === 0 && await page.locator('.pv-sheet select#pvProject').count() === 1,
    '...its project is picked from ACS projects; no Delete / Send to ACS on a copy');
  await page.click('.pv-sheet [data-close]');
  await page.dragAndDrop(`.bcard[data-drag]:has-text("${T1}")`, '.bcol[data-col="Done"]');
  await sleep(400);
  acsT1 = (await db(page)).tasks.find(t => t.title === T1);
  ok(acsT1.status === 'Done', 'dragging a task from ACS to Done marks it done in ACS');
  await page.click('[data-layout="table"]');
  await page.waitForSelector('.ttable');
  await page.click('[data-sort="task"]');
  ok(await page.isVisible('.th-btn.on >> text=Task'), 'Table: sort by a column');
  ok(await page.isVisible('.th-btn >> text=Created') && await page.isVisible('.th-btn >> text=Last changed'), 'Table: Created and Last changed columns');
  await page.click('[data-layout="project"]');
  await page.selectOption('#pvGroup', 'created');
  ok(await page.isVisible('.card-title >> text=Today'), 'List: group by the day a task was created');
  // Drag and drop in the list: grouped by week, drag a task to next week
  await page.selectOption('#pvGroup', 'week');
  await page.dragAndDrop('.pv-row[data-drag]:has-text("Private: plan the team restructure") .pv-grip', '.pv-group[data-drop^="week|"]:has(.card-title:has-text("next week"))');
  await sleep(400);
  ok((await db(page)).private_tasks.find(t => t.title === 'Private: plan the team restructure').week > (await db(page)).W, 'List: drag a task to Next week');
  // Board by project: drag a task to another project's column
  await page.click('[data-layout="board"]');
  await page.selectOption('#pvCol', 'project');
  await page.dragAndDrop('.bcard[data-drag]:has-text("Private: plan the team restructure")', '.bcol[data-col="Alpha Plant"]');
  await sleep(400);
  ok((await db(page)).private_tasks.find(t => t.title === 'Private: plan the team restructure').project === 'Alpha Plant', 'Board by project: drag a card to another project');
  await page.selectOption('#pvCol', 'status');
  await page.click('[data-layout="project"]');
  // Filters
  await page.selectOption('#pvFSource', 'acs');
  ok(await page.locator('.pv-row').count() >= 1 && !(await page.isVisible('.pv-row >> text=Private: plan the team restructure')), 'Filter: only tasks from ACS');
  await page.click('#pvClear');
  await page.selectOption('#pvGroup', 'project');
  await page.click('[data-layout="project"]');
  await page.fill('#addForm input[name=title]', 'Prepare the client presentation');
  await page.click('#addForm button[type=submit]');
  await page.waitForSelector('.pv-row >> text=Prepare the client presentation');
  await page.click('[data-open]:has-text("Prepare the client presentation")');
  await page.click('#pvSend');
  await page.selectOption('#sendForm select[name=project]', 'PRJ-0001');
  await page.click('#sendForm button[type=submit]');
  await page.waitForSelector('.pv-row:has-text("Prepare the client presentation") .pv-tag.sent');
  d = await db(page);
  const sent = d.tasks.find(t => t.title === 'Prepare the client presentation');
  ok(sent && sent.project_id === 'PRJ-0001' && sent.assignee_ids.join() === d.users.adm.id, 'Send to ACS: one chosen task becomes my ACS task');
  await page.reload();
  await page.waitForSelector('#addForm');
  ok((await db(page)).private_tasks.filter(t => t.title === T1).length === 1, 'copying from ACS never duplicates');
  ok((await db(page)).private_tasks.some(t => t.title === 'Test the duty and standby pump logic' || t.source === 'acs'), 'open ACS tasks are copied too');
  await page.evaluate(t => { const d = window.__db.get(); d.tasks.find(x => x.title === t).status = 'Blocked'; window.__db.save(); }, T1);
  await page.reload();
  await page.waitForSelector('#addForm');
  ok((await db(page)).private_tasks.find(t => t.title === T1).status === 'Blocked', 'a copy follows ACS: changed there, updated here');
  ok((await db(page)).tasks.find(t => t.title === 'Private: plan the team restructure') === undefined, '...and nothing private goes to ACS');
  ok(errors.length === 0, 'private tracker: no page errors (' + errors.join('; ') + ')');
  await ctx.close();
}

(async () => {
  const { server, url } = await serve();
  const browser = await launch();
  try {
    for (const t of [myTasks, employee, teamPage, noUpdate, manage, sidePanel, phone, weekRollover, privateTracker]) {
      try { await t(browser, url); } catch (e) { ok(false, t.name + ' crashed: ' + e.message.split('\n').slice(0, 4).join(' | ')); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
  process.exit(failures ? 1 : 0);
})();
