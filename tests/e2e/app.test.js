// Browser tests: drive the real app (frontend/) in Chromium against an in-memory
// fake of Supabase (tests/e2e/fake-supabase.js). Run: npm run test:e2e
const { launch, serve, newApp, signIn } = require('./harness');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T1 = 'Commission the pump station panels';
const T2 = 'Wire the remote IO cabinet';

async function mainFlow(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const db = () => page.evaluate(() => window.__db.get());
  const task = async title => (await db()).tasks.find(t => t.title === title);

  // ---- Sign in ----
  await page.goto(url);
  await page.fill('input[name=username]', 'nobody');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#loginError:not([hidden])');
  ok((await page.textContent('#loginError')).includes('Wrong username or password'), 'unknown user gets a clear sign-in error');
  await signIn(page, url, 'adham');
  ok(await page.isVisible(`text=${T1}`), 'signed in; the board shows this week’s tasks');

  // ---- Add a task ----
  await page.fill('#addForm input[name=title]', 'Panels');
  await page.click('#addForm button[type=submit]');
  ok(await page.isVisible('text=Add a bit more detail'), 'a very short task title gets a nudge');
  await page.fill('#addForm input[name=title]', 'Test the duty and standby pump logic');
  await page.click('#addForm button[type=submit]');
  await page.waitForSelector('text=Test the duty and standby pump logic');
  const added = await task('Test the duty and standby pump logic');
  ok(added && added.project_id === 'PRJ-0001' && added.status === 'To Do', 'new task saved to the project');
  ok(await page.inputValue('#addForm input[name=title]') === '', 'add box is cleared after adding');

  // ---- Half-typed text survives a redraw ----
  await page.fill('#addForm input[name=title]', 'Half typed');
  await page.click('[data-done]');   // ticking a task redraws the screen
  await sleep(300);
  ok(await page.inputValue('#addForm input[name=title]') === 'Half typed', 'half-typed new task kept when the screen redraws');
  await page.click('[data-done]');
  await page.fill('#addForm input[name=title]', '');
  await sleep(300);

  // ---- A teammate's change is not overwritten ----
  await page.evaluate(t => {
    const d = window.__db.get(); const k = d.tasks.find(x => x.title === t);
    k.assignee_ids.push(d.users.omar.id); k.subtasks[1].done = true; k.updated_at = window.__db.ts(); window.__db.save();
  }, T1);
  await page.click(`[data-toggle] >> text=${T1}`);
  await page.check('[data-sub$=":0"]');
  await sleep(400);
  let k = await task(T1);
  ok(k.subtasks[0].done && k.subtasks[1].done, 'my tick and a teammate’s tick on the same task are both kept');
  ok(k.assignee_ids.length === 2, 'teammate-added assignee kept after my save');

  // ---- Quick edits on a slow connection all land ----
  await page.evaluate(() => { window.__db.ctl.delay = 250; });
  await page.uncheck('[data-sub$=":0"]');
  await page.uncheck('[data-sub$=":1"]');
  await page.fill('[data-newsub]', 'Panel C');
  await page.press('[data-newsub]', 'Enter');
  await sleep(2000);
  k = await task(T1);
  ok(!k.subtasks[0].done && !k.subtasks[1].done && k.subtasks.length === 3 && k.subtasks[2].t === 'Panel C',
    'three quick edits on a slow connection are all saved');
  ok((await page.$$eval('.sub span', els => els.map(e => e.textContent))).join(',') === 'Panel A,Panel B,Panel C', 'screen matches the database');
  ok(await page.inputValue('[data-newsub]') === '', 'sub-task box is cleared after adding');
  const lastUpd = (await db()).log.filter(l => l.table === 'tasks' && l.op === 'update').pop();
  ok(Object.keys(lastUpd.payload).join() === 'subtasks', 'a save sends only the changed field');

  // ---- Block note survives a refresh landing mid-typing ----
  await page.evaluate(() => { window.__db.ctl.delay = 50; });
  await page.click('[data-block]');
  await page.waitForSelector('[data-blocknote]');
  await page.click('[data-blocknote]');
  await page.keyboard.type('Waiting for the client');
  await page.evaluate(() => window.__db.emit('tasks'));
  await sleep(150);
  await page.keyboard.type(' tag list');
  await page.evaluate(() => window.__db.emit('tasks'));
  await sleep(1500);
  k = await task(T1);
  ok(k.status === 'Blocked' && k.block_note === 'Waiting for the client tag list', 'blocked note saved in full despite live refreshes');
  ok(await page.inputValue('[data-blocknote]') === 'Waiting for the client tag list', 'note box keeps what was typed');
  await page.click('.weekbar-label');
  await sleep(500);

  // ---- A failed save is undone on screen ----
  await page.evaluate(() => { window.__db.ctl.failNextUpdate = true; });
  await page.click('[data-done]');
  await sleep(600);
  k = await task(T1);
  ok(k.status === 'Blocked', 'database unchanged after a failed save');
  ok(await page.isVisible('.toast.error'), 'error message shown');
  ok(!(await page.$eval('[data-done]', b => b.classList.contains('on'))), 'tick undone on screen after the failure');

  // ---- Meeting: tasks under the person assigned, in that person's column ----
  await page.goto(url + '#/meeting');
  await page.waitForSelector('.mtg-person');
  const people = await page.$$eval('.mtg-person', els => els.map(e =>
    e.querySelector('strong').textContent.trim().replace(/^[A-Z]{1,2}(?=[A-Z][a-z])/, '') + ' :: ' +
    Array.from(e.querySelectorAll('li, .t-title')).map(l => l.textContent.trim()).join(' | ')));
  ok(people.some(p => p.startsWith('Mona PLC') && p.includes(T2)), 'meeting: task created by Adham but assigned to Mona shows under Mona');
  ok(!people.some(p => p.startsWith('Adham Admin') && p.includes(T2)), 'meeting: ...and not under Adham');
  ok(people.some(p => p.startsWith('Omar Dev') && p.includes(T1)), 'meeting: a shared task shows under each assigned person');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#copyEmail');
  await sleep(300);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  ok(text.split('PLC team:')[1].split('Dev team:')[0].includes(T2), 'email: Mona’s task is in the PLC column');

  // ---- Saved minutes stay fixed ----
  await page.click('#saveMins');
  await page.waitForSelector('.mtg-note.saved');
  await page.evaluate(t => { const d = window.__db.get(); d.tasks.find(x => x.title === t).title = 'RENAMED after the meeting'; window.__db.save(); }, T2);
  await page.evaluate(() => window.__db.emit('tasks'));
  await sleep(800);
  ok(await page.isVisible(`.mtg-person >> text=${T2}`) && !(await page.isVisible('text=RENAMED after the meeting')), 'saved minutes don’t change when a task changes');
  ok(!(await page.isVisible('[data-done]')), 'saved minutes are read-only');
  ok(await page.locator('.board-card .name-tag').count() > 0, 'saved minutes still show who is on each project');
  // Minutes saved by an older version have no project ids: still matched by name
  await page.evaluate(() => {
    const d = window.__db.get(); const m = d.meetings[0];
    m.snapshot.rows.forEach(r => { delete r.id; r.people.forEach(pp => delete pp.id); }); window.__db.save();
  });
  await page.reload();
  await page.waitForSelector('.mtg-note.saved');
  ok(await page.locator('.board-card .name-tag').count() > 0, 'older saved minutes (no project ids) also show who is on each project');
  await page.click('#mtgEdit');
  ok(await page.isVisible('text=RENAMED after the meeting') && await page.isVisible('[data-done]'), '"Edit" shows the live, editable tasks');
  await page.click('#mtgCancel');
  ok(await page.isVisible('.mtg-note.saved'), '"Cancel edit" goes back to the saved minutes');
  await page.click('[data-mw="-1"]');
  await page.waitForSelector('.mtg-note.warn, .empty');
  ok(await page.isVisible('.mtg-note.warn'), 'an unsaved past week warns it is rebuilt from today’s tasks');
  await page.click('#archiveBtn');
  await page.waitForSelector('.archive-row');
  ok((await page.$$('.archive-row')).length === 1, 'past minutes lists the one saved week');
  await page.click('.archive-row');
  await page.waitForSelector('.mtg-note.saved');
  ok((await page.textContent('.weekbar-label')).includes('this week'), 'tapping a saved week opens its minutes');

  // ---- Admin project save keeps people who joined meanwhile ----
  await page.goto(url + '#/manage');
  await page.click('[data-edit="PRJ-0001"]');
  await page.waitForSelector('dialog[open]');
  await page.evaluate(() => { const d = window.__db.get(); d.assignments.push({ project_id: 'PRJ-0001', user_id: d.users.omar.id }); window.__db.save(); });
  const u = (await db()).users;
  await page.uncheck(`dialog input[name=assigned][value="${u.mona.id}"]`);
  await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const team = (await db()).assignments.filter(a => a.project_id === 'PRJ-0001').map(a => a.user_id);
  ok(team.includes(u.omar.id) && team.includes(u.adm.id) && !team.includes(u.mona.id), 'project save: person who joined meanwhile kept, unticked person removed');

  ok(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await ctx.close();
}

async function memberView(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await signIn(page, url, 'omar');
  ok(!(await page.isVisible('#settingsBtn')), 'members don’t see the settings (Manage) button');
  ok(await page.locator('nav').count() === 0, 'one page: no tabs');
  await page.goto(url + '#/projects');
  await page.click('[data-join="PRJ-0001"]');
  await page.waitForSelector('[data-join="PRJ-0001"]', { state: 'detached' });
  await page.waitForSelector('[data-board="mine"].on');
  ok(true, 'a member can join a project in one tap');
  ok((await page.$$eval('[data-board]', bs => bs.map(b => b.dataset.board + '=' + b.className))).join() === 'me=,mine=on,all=', 'after joining, the board shows My projects (members get no By person view)');
  const tags = await page.locator('.board-card').first().locator('.name-tag').allTextContents();
  ok(tags.length >= 2 && /Omar Dev\s*\(You\)/.test(tags[0]) && tags.some(t => /Adham Admin/.test(t)), 'project cards show everyone on the project as name tags, you first');
  await page.click('[data-board="all"]');
  ok(await page.locator('.board-card').count() >= 1, 'All projects lists every open project');
  // Omar adds a task to his project from the board, in last week (forgot to log it)
  await page.click('[data-addto="PRJ-0001"]');
  const weeks = await page.$$eval('#addForm select[name=week] option', os => os.map(o => o.textContent));
  ok(weeks.length === 3 && /last week/.test(weeks[0]) && /next week/.test(weeks[2]), 'members pick last, this or next week');
  ok(await page.locator('#addForm select[name=person]').count() === 0, 'members can only add tasks for themselves');
  await page.fill('#addForm input[name=title]', 'Checked the alarm list with the client');
  await page.selectOption('#addForm select[name=week]', { index: 1 });
  await page.click('#addForm button[type=submit]');
  await page.waitForSelector('.board-card >> text=Checked the alarm list with the client');
  ok(true, 'a task added on the board shows straight away in the board');
  await page.click('[data-project="PRJ-0001"]');
  await page.waitForSelector('#backBtn');
  ok(await page.locator('#assignSel').count() === 0, 'members can’t change who is on a project');
  await page.goto(url + '#/meeting');
  await page.waitForSelector('.weekbar');
  ok(!(await page.isVisible('#saveMins')), 'members can’t save minutes');
  await ctx.close();
}

async function adminNudges(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await page.goto(url);
  // Omar joins the project but adds nothing; Mona's only task is from last week and untouched since.
  await page.evaluate(() => {
    const d = window.__db.get();
    d.assignments.push({ project_id: 'PRJ-0001', user_id: d.users.omar.id });
    const t = d.tasks.find(x => x.assignee_ids.indexOf(d.users.mona.id) !== -1);
    const [y, w] = d.W.split('-W').map(Number);
    t.week = y + '-W' + String(w - 1).padStart(2, '0');
    t.updated_at = new Date(Date.now() - 10 * 86400000).toISOString();
    window.__db.save();
  });
  await signIn(page, url, 'adham');
  await page.goto(url + '#/meeting');
  await page.waitForSelector('.weekbar');
  const card = await page.textContent('.card.quiet').catch(() => '');
  ok(/No update yet \(2\)/.test(card) && card.includes('Mona') && card.includes('Omar') && !card.includes('Adham'),
    'admin sees who has no update this week (Mona, Omar; not Adham)');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#copyReminder');
  await sleep(300);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  ok(/^Hi Mona, Omar — please add your tasks for week \d+/.test(text), 'reminder text names them: "' + text.slice(0, 60) + '…"');
  await ctx.close();

  const c2 = await newApp(browser);
  const p2 = await c2.newPage();
  await signIn(p2, url + '#/', 'mona');
  ok(await p2.locator('.board-seg').count() === 1, 'the app opens on Projects (the meeting board)');
  await p2.goto(url + '#/tasks');
  await p2.waitForSelector('#addForm');
  await p2.goto(url + '#/meeting');
  await p2.waitForSelector('.weekbar');
  ok(!(await p2.isVisible('.card.quiet')), 'members don’t see the no-update list');
  await c2.close();
}

async function planNudge(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-10-29T10:00:00') });   // Thursday, week 44
  await signIn(page, url, 'adham');
  ok(await page.isVisible('#planNudge'), 'Thursday with nothing planned for next week: nudge shown');
  await page.click('#planNext');
  ok(/next week/.test(await page.$eval('#addForm select[name=week]', s => s.options[s.selectedIndex].textContent)), 'the nudge sets the add box to next week');
  await page.fill('#addForm input[name=title]', 'Prepare the site acceptance test documents');
  await page.click('#addForm button[type=submit]');
  await page.waitForSelector('.wk-col.next >> text=Prepare the site acceptance test documents');
  ok(!(await page.isVisible('#planNudge')), 'nudge gone once something is planned');
  await ctx.close();

  const c2 = await newApp(browser);
  const p2 = await c2.newPage();
  await p2.clock.install({ time: new Date('2026-10-30T10:00:00') });     // Friday
  await signIn(p2, url, 'mona');
  ok(await p2.isVisible('#planNudge'), 'nudge shown to another person with nothing planned');
  await p2.click('#planLater');
  ok(!(await p2.isVisible('#planNudge')), '"Later" hides it');
  await p2.reload();
  await p2.waitForSelector('.board-seg');
  ok(!(await p2.isVisible('#planNudge')), '...and it stays hidden for that week');
  await c2.close();

  const c3 = await newApp(browser);
  const p3 = await c3.newPage();
  await p3.clock.install({ time: new Date('2026-10-26T10:00:00') });     // Monday
  await signIn(p3, url, 'adham');
  ok(!(await p3.isVisible('#planNudge')), 'no nudge early in the week');
  await c3.close();
}

async function weekRollover(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-11-01T23:58:00') });   // Sunday night, week 44
  await signIn(page, url, 'adham');
  const before = await page.textContent('.weekbar-label');
  await page.clock.runFor(5 * 60 * 1000);                                // Monday, week 45
  await page.waitForTimeout(500);
  const after = await page.textContent('.weekbar-label');
  ok(/Week 44 · this week/.test(before) && /Week 45 · this week/.test(after) && /next to week 46/.test(after), 'the week moves on by itself while the app stays open');
  const carried = await page.$$eval('.wk-col:not(.next) .tag-carry', els => els.length);
  ok(carried >= 2, 'unfinished tasks roll over into the new week (' + carried + ' carried)');
  await ctx.close();
}

// Admin plans tasks for someone else in any week; the meeting shows this week and next side by side.
async function adminPlans(browser, url) {
  const ctx = await newApp(browser);
  const page = await ctx.newPage();
  await signIn(page, url, 'adham');
  const weeks = await page.$$eval('#addForm select[name=week] option', os => os.map(o => o.value));
  const later = weeks[weeks.length - 1 - 5];   // three weeks ahead
  await page.fill('#addForm input[name=title]', 'Prepare the FAT procedure for the client');
  await page.selectOption('#addForm select[name=person]', { label: 'For: Mona PLC' });
  await page.selectOption('#addForm select[name=week]', later);
  await page.click('#addForm button[type=submit]');
  await sleep(500);
  const t = await page.evaluate(() => { const d = window.__db.get(); return d.tasks.find(x => x.title === 'Prepare the FAT procedure for the client'); });
  const mona = await page.evaluate(() => window.__db.get().users.mona.id);
  ok(t && t.created_by === mona && t.assignee_ids.join() === mona, 'admin adds a task for someone else');
  ok(t && t.week === later, 'admin picks any week (' + later + ')');
  ok(/Added for Mona/.test(await page.textContent('#toast').catch(() => '')), 'admin is told who and which week it was added for');

  await page.fill('#addForm input[name=title]', 'Download the PLC program to site');
  await page.selectOption('#addForm select[name=person]', { label: 'For: Mona PLC' });
  await page.selectOption('#addForm select[name=week]', weeks[5]);   // next week
  await page.click('#addForm button[type=submit]');
  await sleep(500);
  await page.goto(url + '#/meeting');
  await page.waitForSelector('.wk2');
  ok(await page.locator('.wk2').first().locator('.wk-col').count() === 2, 'meeting: this week and next week side by side');
  ok(/Download the PLC program/.test(await page.textContent('.wk-col.next')), 'meeting: next week’s plan is in the second column');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(200);
  const scrolls = await page.$eval('.wk2', el => el.scrollWidth > el.clientWidth + 20);
  ok(scrolls, 'meeting: on a phone the two weeks scroll sideways');
  await page.setViewportSize({ width: 1000, height: 900 });
  ok(await page.$eval('.wk2', el => el.scrollWidth <= el.clientWidth + 1), 'meeting: on a wide screen both weeks fit');
  // By person: each employee, their tasks grouped by project
  await page.click('[data-board="people"]');
  await page.waitForSelector('.person-project');
  const monaCard = await page.locator('.board-card', { hasText: 'Mona PLC' }).first().textContent();
  ok(/Alpha Plant/.test(monaCard) && /Download the PLC program/.test(monaCard) && /Prepare the FAT/.test(monaCard) === false, 'admin By person: Mona’s tasks under their project (this and next week)');
  // Collapse all / expand all, and one card on its own
  await page.click('#foldAll');
  ok(await page.locator('.board-card.folded').count() === await page.locator('.board-card').count(), 'Collapse all folds every card');
  await page.locator('[data-fold]').first().click();
  ok(await page.locator('.board-card.folded').count() === await page.locator('.board-card').count() - 1, 'one card can be opened on its own');
  await page.click('#unfoldAll');
  ok(await page.locator('.board-card.folded').count() === 0, 'Expand all opens every card');
  // Tick a task straight on the board
  await page.click('[data-board="all"]');
  const first = page.locator('.board-card [data-done]').first();
  const id = await first.getAttribute('data-done');
  await first.click();
  await sleep(400);
  ok((await page.evaluate(i => window.__db.get().tasks.find(t => t.id === i).status, id)) === 'Done', 'a task can be ticked done right on the board');
  // Settings button opens Manage and leads back
  await page.click('#settingsBtn');
  await page.waitForSelector('.back');
  ok(/#\/manage$/.test(page.url()), 'admin settings button opens Manage');
  await page.click('.back');
  await page.waitForSelector('.board-seg');
  ok(true, 'Manage leads back to the board');

  // Admin puts Omar on the project from the project page, then takes him off again
  await page.click('[data-project="PRJ-0001"]');
  await page.waitForSelector('#assignSel');
  await page.selectOption('#assignSel', { label: 'Omar Dev · Dev' });
  await page.waitForSelector('[data-unassign]:near(:text("Omar"))');
  const omar = await page.evaluate(() => window.__db.get().users.omar.id);
  const onIt = async () => (await page.evaluate(() => window.__db.get().assignments.map(a => a.project_id + ':' + a.user_id))).indexOf('PRJ-0001:' + omar) !== -1;
  ok(await onIt(), 'admin adds a person to a project');
  page.once('dialog', d => d.accept());
  await page.click(`[data-unassign="${omar}"]`);
  await sleep(500);
  ok(!(await onIt()), 'admin takes a person off a project');
  await ctx.close();

  const ctx2 = await newApp(browser);
  const p2 = await ctx2.newPage();
  await signIn(p2, url, 'mona');
  ok(await p2.locator('#addForm select[name=person]').count() === 0, 'members can only add tasks for themselves');
  await ctx2.close();
}

// Phone layout: tasks open in a bottom sheet; the add box, Blocked list and weeks are compact.
async function phoneLayout(browser, url) {
  const ctx = await newApp(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await signIn(page, url + '#/', 'adham');
  await page.click('[data-board="all"]');
  ok(!(await page.isVisible('#addForm select[name=week]')), 'phone: the add box starts as one line');
  await page.click('#addForm input[name=title]');
  ok(await page.isVisible('#addForm select[name=week]'), 'phone: tapping it shows project and week');
  ok(await page.locator('.wk-tabs').first().isVisible(), 'phone: week tabs above each project');
  await page.locator('.wk-tabs').first().locator('button').nth(1).click();
  await sleep(600);
  ok((await page.locator('.wk-tabs').first().locator('button').nth(1).getAttribute('class')).includes('on'), 'phone: tapping a week tab shows that week');
  await page.locator('[data-toggle]').first().click();
  await page.waitForSelector('dialog[data-mode="task"][open]');
  ok(await page.locator('#view .t-open').count() === 0, 'phone: a task opens in a bottom sheet, not inside the board');
  await page.fill('dialog [data-newsub]', 'Check the cabinet heaters');
  await page.press('dialog [data-newsub]', 'Enter');
  await sleep(400);
  ok(await page.isVisible('dialog >> text=Check the cabinet heaters') && await page.isVisible('dialog[data-mode="task"][open]'), 'phone: editing in the sheet saves and keeps it open');
  await page.click('dialog [data-close]');
  await sleep(200);
  ok(!(await page.isVisible('dialog[open]')), 'phone: Done closes the sheet');
  ok(errors.length === 0, 'phone: no JavaScript errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await ctx.close();
}

(async () => {
  const { server, url } = await serve();
  const browser = await launch();
  try {
    await mainFlow(browser, url);
    await memberView(browser, url);
    await adminNudges(browser, url);
    await planNudge(browser, url);
    await weekRollover(browser, url);
    await adminPlans(browser, url);
    await phoneLayout(browser, url);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll browser checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
