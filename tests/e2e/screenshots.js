// Regenerates docs/screenshots/*.png from the real app with made-up demo data.
// Run: npm run screenshots
const path = require('path');
const { chromium, serve, newApp, signIn } = require('./harness');

const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots');

// Demo data (fictional people and projects), written into the fake database.
function demo() {
  const d = window.__db.get();
  const W = d.W;
  const shift = (week, n) => {
    const [y, w] = week.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (w - 1 + n) * 7);
    const t = new Date(mon); t.setUTCDate(t.getUTCDate() + 3);
    const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - ys) / 86400000 + 1) / 7)).padStart(2, '0');
  };
  const LAST = shift(W, -1), NEXT = shift(W, 1);
  const u = d.users;
  u.sara = { id: 'sara-0000-4000-8000-000000000000', email: 'sara@advcontrolsys.com', name: 'Sara Nabil', role: 'member', active: true, team: 'PLC' };
  u.adm.name = 'Adam Fares'; u.mona.name = 'Mona Samir'; u.omar.name = 'Omar Hany';
  d.profiles = Object.values(u);
  d.projects = [
    { id: 'PRJ-0001', name: 'Riverside Water Plant', type: 'AVEVA + PLC', status: 'In Progress', priority: 'High', client: 'Demo Water Co', manager: '', notes: '' },
    { id: 'PRJ-0002', name: 'Harbour Pump Station', type: 'PLC', status: 'In Progress', priority: 'Medium', client: 'Demo Port', manager: '', notes: '' },
    { id: 'PRJ-0003', name: 'Tower B Historian', type: 'AVEVA', status: 'Planning', priority: 'Low', client: 'Demo Towers', manager: '', notes: '' },
  ];
  d.assignments = [['PRJ-0001', 'adm'], ['PRJ-0001', 'mona'], ['PRJ-0001', 'omar'], ['PRJ-0002', 'adm'], ['PRJ-0002', 'sara'], ['PRJ-0002', 'mona'], ['PRJ-0003', 'omar']]
    .map(([p, k]) => ({ project_id: p, user_id: u[k].id }));
  const ts = window.__db.ts();
  let n = 0;
  const T = (p, week, title, who, extra) => Object.assign({
    id: 'task-' + (n++), project_id: p, week, title, notes: '', status: 'To Do', team: null, block_note: '',
    assignee_ids: who.map(k => u[k].id), contact_ids: [], subtasks: [], created_by: u[who[0]].id, created_at: ts, updated_at: ts,
  }, extra || {});
  d.contacts = [{ id: 'c1', name: 'Eng. Karim (client)', org: 'Demo Water Co' }];
  d.tasks = [
    T('PRJ-0001', W, 'Build the filter overview and alarm screens in InTouch', ['adm'], { subtasks: [{ t: 'Overview screen', done: true }, { t: 'Alarm banner', done: true }, { t: 'Trend pop-ups', done: false }] }),
    T('PRJ-0001', W, 'Configure historian tags for the filter area', ['adm'], { status: 'Blocked', block_note: 'Waiting for the final tag list from the client', contact_ids: ['c1'] }),
    T('PRJ-0001', LAST, 'Review the IO list against the electrical drawings', ['mona']),
    T('PRJ-0001', W, 'Program duty / standby logic for the lift pumps', ['mona'], { status: 'Done' }),
    T('PRJ-0001', W, 'Set up the OPC UA connection to the main PLC', ['omar', 'adm']),
    T('PRJ-0001', NEXT, 'Factory acceptance test with the client', ['adm', 'mona']),
    T('PRJ-0002', W, 'Terminate panel 3 and prepare it for loop checks', ['sara'], { subtasks: [{ t: 'Panel 1', done: true }, { t: 'Panel 2', done: true }, { t: 'Panel 3', done: false }] }),
    T('PRJ-0002', W, 'Send the HMI template to the client for approval', ['adm'], { status: 'Done' }),
    T('PRJ-0002', NEXT, 'Site commissioning plan', ['sara']),
    T('PRJ-0003', NEXT, 'Collect the BMS points list', ['omar']),
  ];
  d.meetings = [];
  window.__db.save();
}

(async () => {
  const { server, url } = await serve();
  const browser = await chromium.launch();
  const ctx = await newApp(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(demo);
  await page.reload();
  await page.waitForSelector('#loginView:not([hidden])');
  await page.screenshot({ path: path.join(OUT, '1-login.png') });

  await signIn(page, url, 'adham');
  await page.click('[data-toggle] >> text=Build the filter overview');
  await page.screenshot({ path: path.join(OUT, '2-my-tasks.png') });

  await page.goto(url + '#/projects');
  await page.click('[data-project="PRJ-0001"]');
  await page.waitForSelector('#backBtn');
  await page.screenshot({ path: path.join(OUT, '3-project.png') });

  await page.goto(url + '#/meeting');
  await page.waitForSelector('.mtg-person');
  await page.screenshot({ path: path.join(OUT, '4-meeting.png') });

  await browser.close();
  server.close();
  console.log('Screenshots written to docs/screenshots/');
})().catch(e => { console.error(e); process.exit(1); });
