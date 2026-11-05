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

  // Board layout: four columns; drag a task to Doing
  await page.click('[data-layout="board"]');
  await page.waitForSelector('.board4');
  ok(await page.locator('.bcol').count() === 4 && await page.isVisible('.bcol[data-col="Done"] >> text=' + T1), 'Board: To do · Doing · Blocked · Done');
  await page.dragAndDrop('.bcard:has-text("Test the duty and standby")', '.bcol[data-col="In Progress"]');
  await sleep(400);
  ok((await task(page, 'Test the duty and standby pump logic')).status === 'In Progress', 'drag a card to Doing changes its status');
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

(async () => {
  const { server, url } = await serve();
  const browser = await launch();
  try {
    for (const t of [myTasks, employee, teamPage, noUpdate, manage, sidePanel, phone, weekRollover]) {
      try { await t(browser, url); } catch (e) { ok(false, t.name + ' crashed: ' + e.message.split('\n')[0]); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
  process.exit(failures ? 1 : 0);
})();
