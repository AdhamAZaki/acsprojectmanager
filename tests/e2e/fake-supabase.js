// In-memory stand-in for supabase-js, just enough for the ACS app. Test hooks on window.__db.
(function () {
  const LS = 'fake-db-v1';
  const isoWeek = d => {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const y = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return date.getUTCFullYear() + '-W' + String(Math.ceil(((date - y) / 86400000 + 1) / 7)).padStart(2, '0');
  };
  let tick = 0;
  const ts = () => { tick++; return new Date(Date.now()).toISOString().replace('Z', String(tick % 1000).padStart(3, '0') + '+00:00'); };
  const uid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));

  function seed() {
    const W = isoWeek(new Date());
    const users = {
      adm: { id: uid(), email: 'adham@advcontrolsys.com', name: 'Adham Admin', role: 'admin', active: true, team: 'Dev', department_id: 'AUTO', title: 'Engineering Manager', unit: 'Management' },
      mona: { id: uid(), email: 'mona@advcontrolsys.com', name: 'Mona PLC', role: 'member', active: true, team: 'PLC', department_id: 'AUTO', title: 'PLC Engineer', unit: 'PLC' },
      omar: { id: uid(), email: 'omar@advcontrolsys.com', name: 'Omar Dev', role: 'member', active: true, team: 'Dev', department_id: 'AUTO', title: 'Software Engineer', unit: 'Development' },
      hany: { id: uid(), email: 'hany@advcontrolsys.com', name: 'Hany BMS Lead', role: 'lead', active: true, team: null, department_id: 'BMS', title: 'BMS Team Leader Engineer', unit: 'B.A Execution Team B' },
      laila: { id: uid(), email: 'laila@advcontrolsys.com', name: 'Laila BMS', role: 'member', active: true, team: null, department_id: 'BMS', title: 'BMS Engineer', unit: 'B.A Execution Team B' },
      tamer: { id: uid(), email: 'tamer@advcontrolsys.com', name: 'Tamer Tech', role: 'member', active: true, team: null, department_id: 'BMS', title: 'Technician', unit: 'Building Technical Staff' },
    };
    const t0 = ts();
    return {
      W, users,
      profiles: Object.values(users),
      departments: [
        { id: 'AUTO', name: 'Automation', teams: ['PLC', 'Dev'], project_types: ['PLC', 'AVEVA', 'AVEVA + PLC', 'Other'], sort: 1 },
        { id: 'BMS', name: 'BMS', teams: ['BMS'], project_types: ['BMS', 'GRMS', 'CRS', 'Service', 'Other'], sort: 2 },
      ],
      projects: [
        { id: 'PRJ-0001', name: 'Alpha Plant', type: 'AVEVA + PLC', status: 'In Progress', priority: 'Medium', client: '', manager: '', notes: '', start_date: null, end_date: null, department_id: 'AUTO' },
        { id: 'PRJ-0002', name: 'Tower BMS Retrofit', type: 'BMS', status: 'In Progress', priority: 'Medium', client: '', manager: '', notes: '', start_date: null, end_date: null, department_id: 'BMS' },
      ],
      assignments: [{ project_id: 'PRJ-0001', user_id: users.adm.id }, { project_id: 'PRJ-0001', user_id: users.mona.id },
        { project_id: 'PRJ-0002', user_id: users.hany.id }, { project_id: 'PRJ-0002', user_id: users.laila.id }],
      tasks: [
        { id: uid(), project_id: 'PRJ-0001', week: W, title: 'Commission the pump station panels', notes: '', status: 'To Do', team: 'Dev', block_note: '',
          assignee_ids: [users.adm.id], contact_ids: [], subtasks: [{ t: 'Panel A', done: false }, { t: 'Panel B', done: false }],
          created_by: users.adm.id, created_at: t0, updated_at: t0 },
        { id: uid(), project_id: 'PRJ-0001', week: W, title: 'Wire the remote IO cabinet', notes: '', status: 'To Do', team: 'Dev', block_note: '',
          assignee_ids: [users.mona.id], contact_ids: [], subtasks: [], created_by: users.adm.id, created_at: t0, updated_at: t0 },
        { id: uid(), project_id: 'PRJ-0002', week: W, title: 'Survey the AHU controllers on every floor', notes: '', status: 'To Do', team: null, block_note: '',
          assignee_ids: [users.laila.id], contact_ids: [], subtasks: [], created_by: users.laila.id, created_at: t0, updated_at: t0 },
      ],
      contacts: [],
      meetings: [],
      log: [],
    };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(LS)); } catch (e) { db = null; }
  if (!db) db = seed();
  const save = () => localStorage.setItem(LS, JSON.stringify(db));
  save();

  const ctl = { delay: 0, failNextUpdate: false, listeners: [] };
  const sessionUser = () => { const id = localStorage.getItem('fake-session'); return id ? db.profiles.find(p => p.id === id) : null; };
  const clone = x => JSON.parse(JSON.stringify(x));
  const wait = () => new Promise(r => setTimeout(r, ctl.delay));

  function Query(table) {
    this.table = table; this.filters = []; this.op = 'select'; this.payload = null; this.wantSingle = false; this.lim = null;
  }
  Query.prototype.select = function () { if (this.op === 'select') this.op = 'select'; this.returning = true; return this; };
  Query.prototype.insert = function (row) { this.op = 'insert'; this.payload = row; return this; };
  Query.prototype.update = function (row) { this.op = 'update'; this.payload = row; return this; };
  Query.prototype.upsert = function (row) { this.op = 'insert'; this.payload = row; return this; };
  Query.prototype.delete = function () { this.op = 'delete'; return this; };
  Query.prototype.eq = function (c, v) { this.filters.push(r => r[c] === v); return this; };
  Query.prototype.ilike = function (c, v) { this.filters.push(r => String(r[c]).toLowerCase() === String(v).toLowerCase()); return this; };
  Query.prototype.not = function (c, op, v) { this.filters.push(r => r[c] !== null && r[c] !== undefined); return this; };
  Query.prototype.order = function () { return this; };
  Query.prototype.limit = function (n) { this.lim = n; return this; };
  Query.prototype.single = function () { this.wantSingle = true; return this; };
  Query.prototype.maybeSingle = function () { this.wantSingle = true; return this; };
  Query.prototype.then = function (ok, bad) { return this.run().then(ok, bad); };
  Query.prototype.run = async function () {
    await wait();
    const rows = db[this.table];
    const match = r => this.filters.every(f => f(r));
    let out;
    db.log.push({ table: this.table, op: this.op, payload: clone(this.payload) });
    if (this.op === 'select') out = rows.filter(match);
    if (this.op === 'insert') {
      const now = ts();
      const r = Object.assign({ id: uid(), created_at: now, updated_at: now, created_by: (sessionUser() || {}).id }, clone(this.payload));
      rows.push(r); out = [r];
    }
    if (this.op === 'update') {
      if (ctl.failNextUpdate) { ctl.failNextUpdate = false; return { data: null, error: { message: 'Simulated failure' } }; }
      out = [];
      rows.forEach(r => { if (match(r)) { Object.assign(r, clone(this.payload), { updated_at: ts() }); out.push(r); } });
    }
    if (this.op === 'delete') { out = rows.filter(match); db[this.table] = rows.filter(r => !match(r)); }
    save();
    out = clone(out);
    if (this.lim) out = out.slice(0, this.lim);
    if (this.wantSingle) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: out, error: null };
  };

  async function rpc(name, a) {
    await wait();
    db.log.push({ rpc: name, args: clone(a) });
    const me = sessionUser();
    if (name === 'app_bootstrap') {
      const r = { me, team: db.profiles, departments: db.departments, projects: db.projects, assignments: db.assignments, updates: [],
        tasks: db.tasks.filter(t => !a.p_since || t.week >= a.p_since || t.status !== 'Done'), contacts: db.contacts };
      save(); return { data: clone(r), error: null };
    }
    if (name === 'admin_save_project') {
      const p = a.p; let pr = db.projects.find(x => x.id === p.id);
      if (!pr) { pr = { id: p.id || 'PRJ-' + String(db.projects.length + 1).padStart(4, '0') }; db.projects.push(pr); }
      Object.assign(pr, { department_id: p.department_id || pr.department_id || me.department_id, name: p.name, type: p.type, status: p.status, priority: p.priority, client: p.client, manager: p.manager, notes: p.notes, start_date: p.start_date || null, end_date: p.end_date || null });
      db.assignments = db.assignments.filter(x => !(x.project_id === pr.id && a.p_remove_ids.indexOf(x.user_id) !== -1));
      a.p_add_ids.forEach(id => { if (!db.assignments.some(x => x.project_id === pr.id && x.user_id === id)) db.assignments.push({ project_id: pr.id, user_id: id }); });
      save(); return { data: clone(pr), error: null };
    }
    if (name === 'admin_save_minutes') {
      const dept = a.p_department || me.department_id;
      let m = db.meetings.find(x => x.week === a.p_week && x.department_id === dept && x.snapshot);
      if (!m) { m = { id: uid(), week: a.p_week, department_id: dept }; db.meetings.push(m); }
      Object.assign(m, { snapshot: clone(a.p_snapshot), created_by: me.id, updated_at: ts() });
      save(); return { data: clone(m), error: null };
    }
    return { data: null, error: { message: 'unknown rpc ' + name } };
  }

  window.__db = {
    get: () => db, save, ctl, ts,
    emit: table => ctl.listeners.forEach(f => f(table)),
    reset: () => { db = seed(); save(); },
  };

  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { const u = sessionUser(); return { data: { session: u ? { user: { id: u.id } } : null } }; },
          async signInWithPassword({ email }) {
            const u = db.profiles.find(p => p.email === email);
            if (!u) return { error: { message: 'Invalid login credentials' } };
            localStorage.setItem('fake-session', u.id); return { data: {}, error: null };
          },
          async signOut() { localStorage.removeItem('fake-session'); return {}; },
          async updateUser() { return {}; },
        },
        rpc,
        from: t => new Query(t),
        channel() {
          const handlers = [];
          const ch = {
            on(evt, filter, cb) { handlers.push({ table: filter.table, cb }); return ch; },
            subscribe(cb) {
              ctl.listeners.push(table => handlers.filter(h => h.table === table).forEach(h => h.cb({})));
              setTimeout(() => cb('SUBSCRIBED'), 0); return ch;
            },
          };
          return ch;
        },
        removeChannel() {},
      };
    },
  };
})();
