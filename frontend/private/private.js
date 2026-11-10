// Private tasks: a small tracker for one person, in its own Supabase project.
// * Your private tasks live only in the private project (one owner, rows readable by the owner only).
// * Linked to ACS (the shared tracker) one way: your ACS tasks (last, this and next week, and anything
//   still open from before) are copied in when you open the page, and the copies follow ACS: a task
//   changed or done there is updated here. Use "Update from ACS" for another week.
// * A private task goes to ACS only when you press "Send to ACS" on it.
// The ACS sign-in is the same one as the ACS app on this site, so if you are signed in there,
// the link works without signing in again.
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const cfg = window.PRIVATE_CONFIG, acsCfg = window.APP_CONFIG;
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Weeks ----------
  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const y = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return date.getUTCFullYear() + '-W' + String(Math.ceil(((date - y) / 86400000 + 1) / 7)).padStart(2, '0');
  }
  function shiftWeek(week, n) {
    const [y, w] = week.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (w - 1) * 7 + 7 * n);
    return isoWeek(new Date(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()));
  }
  const wnum = w => Number(w.split('-W')[1]);
  const THIS = isoWeek(new Date()), NEXT = shiftWeek(THIS, 1), LAST = shiftWeek(THIS, -1);

  // ---------- State ----------
  const S = { tasks: [], acs: null, week: 'now', addWeek: THIS, busy: false };
  let P = null, A = null;   // private and ACS Supabase clients

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2600);
  }
  async function run(fn) {
    $('#sync').className = 'sync busy';
    try { const r = await fn(); $('#sync').className = 'sync'; return r; } catch (e) { $('#sync').className = 'sync off'; toast(e.message || String(e), true); return undefined; }
  }
  const check = res => { if (res.error) throw new Error(res.error.message); return res.data; };

  // ---------- Data ----------
  async function loadTasks() {
    S.tasks = check(await P.from('private_tasks').select('*').order('created_at'));
  }
  /** The ACS side: who you are there and the project list, if you are signed in to ACS on this site. */
  async function loadAcs() {
    const { data } = await A.auth.getSession();
    if (!data.session) { S.acs = null; return; }
    const me = check(await A.from('profiles').select('id,name,team').eq('id', data.session.user.id).single());
    const projects = check(await A.from('projects').select('id,name,status').order('name'));
    S.acs = { me: me, projects: projects };
  }
  /**
   * Copies your ACS tasks here, one way: the weeks given (default: last, this and next week) plus
   * anything still open from earlier weeks. Copies already here follow ACS (title, week, status,
   * project). Tasks you sent from here to ACS stay as they are. Nothing is ever written to ACS.
   */
  async function pullAcs(weeks, quiet) {
    if (!S.acs) return;
    const me = S.acs.me.id;
    const ws = weeks || [LAST, THIS, NEXT];
    const rows = check(await A.from('tasks').select('id,project_id,week,title,status,assignee_ids,created_by'));
    const mine = rows.filter(t => ((t.assignee_ids || []).indexOf(me) !== -1 || (!(t.assignee_ids || []).length && t.created_by === me)) &&
      (ws.indexOf(t.week) !== -1 || (t.status !== 'Done' && t.week < THIS)));
    const pname = t => (S.acs.projects.find(p => p.id === t.project_id) || { name: '' }).name;
    const byAcs = {};
    S.tasks.forEach(t => { if (t.acs_task_id) byAcs[t.acs_task_id] = t; });
    const add = [], upd = [];
    mine.forEach(t => {
      const v = { week: t.week, title: t.title, status: t.status, project: pname(t) };
      const have = byAcs[t.id];
      if (!have) add.push(Object.assign({ source: 'acs', acs_task_id: t.id }, v));
      else if (have.source === 'acs' && Object.keys(v).some(k => have[k] !== v[k])) upd.push({ id: have.id, v: v });
    });
    if (add.length) check(await P.from('private_tasks').upsert(add, { onConflict: 'acs_task_id', ignoreDuplicates: true }));
    for (const u of upd) check(await P.from('private_tasks').update(u.v).eq('id', u.id));
    await loadTasks();
    const msg = [add.length ? add.length + ' copied' : '', upd.length ? upd.length + ' updated' : ''].filter(Boolean).join(', ');
    if (!quiet || msg) toast(msg ? 'From ACS: ' + msg : 'Up to date with ACS');
  }

  // ---------- Screens ----------
  function showLogin(msg, email) {
    document.body.classList.remove('signed-in');
    $('#outBtn').hidden = true;
    $('#view').innerHTML = `<section class="login" style="display:block"><div class="login-card">
      <h1>Private tasks</h1><p>Only you can sign in here. These tasks are kept apart from the ACS tracker.</p>
      <form id="loginForm" class="login-form">
        <label class="field">Email<input name="email" type="email" autocomplete="username" value="${esc(email || '')}" required></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
        ${msg ? `<p class="error">${esc(msg)}</p>` : ''}
        <button class="primary big" type="submit">Sign in</button>
      </form></div></section>`;
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const res = await P.auth.signInWithPassword({ email: f.elements.email.value.trim(), password: f.elements.password.value });
      if (res.error) return showLogin('Wrong email or password.', f.elements.email.value.trim());
      start();
    };
  }

  const inWeeks = (t, ws) => ws.some(w => w === THIS ? (t.week === THIS || (t.week < THIS && t.status !== 'Done')) : t.week === w);
  const weeksOf = v => v === 'now' ? [THIS, NEXT] : [v];

  function render() {
    document.body.classList.add('signed-in');
    $('#outBtn').hidden = false;
    const ws = weeksOf(S.week);
    const list = S.tasks.filter(t => inWeeks(t, ws));
    const groups = {};
    list.forEach(t => { (groups[t.project || 'No project'] = groups[t.project || 'No project'] || []).push(t); });
    const names = Array.from(new Set(S.tasks.map(t => t.project).filter(Boolean).concat(S.acs ? S.acs.projects.filter(p => p.status !== 'Done' && p.status !== 'Canceled').map(p => p.name) : []))).sort();
    const rank = t => t.status === 'Blocked' ? 0 : t.status === 'Done' ? 2 : 1;
    const row = t => `<div class="pv-row${t.status === 'Done' ? ' done' : ''}">
      <button type="button" class="pv-check${t.status === 'Done' ? ' on' : ''}" data-done="${t.id}" aria-label="${t.status === 'Done' ? 'Mark as not done' : 'Mark as done'}">${t.status === 'Done' ? '✓' : ''}</button>
      <span class="pv-title">${esc(t.title)}${t.week !== THIS && t.week < THIS && t.status !== 'Done' ? ` <span class="tag-carry">from week ${wnum(t.week)}</span>` : ''}</span>
      ${ws.length > 1 && t.week === NEXT ? '<span class="pv-tag">next week</span>' : ''}
      ${t.source === 'acs' ? '<span class="pv-tag acs">from ACS</span>' : t.acs_task_id ? '<span class="pv-tag sent">sent to ACS</span>' : S.acs ? `<button type="button" class="ghost small-btn" data-send="${t.id}">Send to ACS</button>` : ''}
      <button type="button" class="pv-icon" data-del="${t.id}" aria-label="Delete">×</button></div>`;
    $('#view').innerHTML = `
      <div class="page-title"><h2>Private tasks</h2><span class="pv-lock">Only you</span></div>
      <form class="card pv-add" id="addForm">
        <input name="title" placeholder="A private task" autocomplete="off" required>
        <div class="pv-add-row">
          <input name="project" list="pvProjects" placeholder="Project or topic (optional)" autocomplete="off">
          <datalist id="pvProjects">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <div class="seg"><button type="button" data-aw="${THIS}" class="${S.addWeek === THIS ? 'on' : ''}">This week · ${wnum(THIS)}</button><button type="button" data-aw="${NEXT}" class="${S.addWeek === NEXT ? 'on' : ''}">Next week · ${wnum(NEXT)}</button></div>
          <button type="submit" class="primary small">+ Add</button>
        </div>
      </form>
      <div class="filters">
        <label class="f${S.week !== 'now' ? ' set' : ''}"><span>Week</span><select id="pvWeek">${[['now', 'This + next week'], [THIS, 'This week · ' + wnum(THIS)], [NEXT, 'Next week · ' + wnum(NEXT)], [LAST, 'Last week · ' + wnum(LAST)]]
          .map(o => `<option value="${o[0]}"${o[0] === S.week ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>
        ${S.acs ? `<button type="button" class="secondary small-btn" id="pullBtn">Update from ACS${S.week === 'now' ? '' : ' (week ' + wnum(S.week) + ')'}</button>` : ''}
      </div>
      ${Object.keys(groups).sort().map(g => `<section class="card"><h3 class="card-title">${esc(g)}</h3>${groups[g].sort((a, b) => rank(a) - rank(b)).map(row).join('')}</section>`).join('')
        || '<div class="empty"><h3>No private tasks in these weeks</h3><p>Add one above.</p></div>'}
      <section class="card"><h3 class="card-title">Link to ACS</h3>
        ${S.acs ? `<p class="small">Linked as <b>${esc(S.acs.me.name)}</b>. Your ACS tasks are copied here (and kept up to date) when you open this page. Nothing goes to ACS unless you press <b>Send to ACS</b> on a task.</p>`
          : `<p class="small muted" style="margin-bottom:8px">Sign in to ACS to copy your ACS tasks here and to send a task there. (If you are signed in to the ACS app in this browser, this happens by itself.)</p>
          <form class="pv-link" id="linkForm"><input name="username" placeholder="ACS username" autocomplete="off" required><input name="password" type="password" placeholder="ACS password" autocomplete="off" required><button class="secondary small-btn" type="submit">Link</button></form>`}
      </section>`;
    bind();
  }

  function bind() {
    $$('[data-aw]').forEach(b => b.onclick = () => { S.addWeek = b.dataset.aw; keepAdd(render); });
    $('#pvWeek').onchange = e => { S.week = e.target.value; render(); };
    $('#addForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const title = f.elements.title.value.replace(/\s+/g, ' ').trim();
      if (!title) return;
      const saved = await run(async () => check(await P.from('private_tasks').insert({ title: title, project: f.elements.project.value.trim(), week: S.addWeek }).select().single()));
      if (!saved) return;
      S.tasks.push(saved);
      const project = f.elements.project.value;
      render();
      $('#addForm').elements.project.value = project;   // the next task often goes to the same project
      $('#addForm').elements.title.focus();
    };
    $$('[data-done]').forEach(b => b.onclick = async () => {
      const t = S.tasks.find(x => x.id === b.dataset.done);
      const change = t.status === 'Done' ? { status: 'To Do' } : { status: 'Done', week: t.week < THIS ? THIS : t.week };
      const saved = await run(async () => check(await P.from('private_tasks').update(change).eq('id', t.id).select().single()));
      if (saved) { Object.assign(t, saved); render(); }
    });
    $$('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this private task?')) return;
      if (await run(async () => check(await P.from('private_tasks').delete().eq('id', b.dataset.del)))) { S.tasks = S.tasks.filter(t => t.id !== b.dataset.del); render(); }
    });
    $$('[data-send]').forEach(b => b.onclick = () => sendDialog(S.tasks.find(t => t.id === b.dataset.send)));
    const pull = $('#pullBtn');
    if (pull) pull.onclick = () => run(() => pullAcs(S.week === 'now' ? null : [S.week])).then(render);
    const link = $('#linkForm');
    if (link) link.onsubmit = async e => {
      e.preventDefault();
      const u = link.elements.username.value.trim().toLowerCase();
      const email = u.indexOf('@') !== -1 ? u : u + '@' + acsCfg.EMAIL_DOMAIN;
      const res = await A.auth.signInWithPassword({ email: email, password: link.elements.password.value });
      if (res.error) return toast('ACS: wrong username or password.', true);
      await run(async () => { await loadAcs(); await pullAcs(); });
      render();
    };
  }
  /** Redraw without losing what is typed in the add box. */
  function keepAdd(fn) {
    const f = $('#addForm'); const v = f ? { t: f.elements.title.value, p: f.elements.project.value } : null;
    fn();
    if (v) { const g = $('#addForm'); g.elements.title.value = v.t; g.elements.project.value = v.p; }
  }

  /** Send one private task to ACS, on an ACS project you pick. It becomes a normal ACS task of yours. */
  function sendDialog(t) {
    const dlg = $('#dialog');
    const open = S.acs.projects.filter(p => p.status !== 'Done' && p.status !== 'Canceled');
    const guess = open.find(p => p.name.toLowerCase() === String(t.project || '').toLowerCase());
    dlg.innerHTML = `<form class="sheet" id="sendForm"><header class="sheet-head"><button type="button" class="text-btn" data-close>Cancel</button><h3>Send to ACS</h3><button type="submit" class="text-btn strong">Send</button></header>
      <div class="sheet-body"><p style="margin-bottom:10px"><b>${esc(t.title)}</b></p>
        <p class="small muted" style="margin-bottom:10px">This copy becomes one of your normal ACS tasks: the people who can see your ACS tasks will see it. The private copy stays here, marked “sent to ACS”.</p>
        <label class="field">ACS project<select name="project" required><option value="">Choose a project…</option>${open.map(p => `<option value="${esc(p.id)}"${guess && guess.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </div></form>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    $('#sendForm').onsubmit = async e => {
      e.preventDefault();
      const pid = e.target.elements.project.value;
      if (!pid) return;
      const ok = await run(async () => {
        const acsTask = check(await A.from('tasks').insert({ project_id: pid, week: t.week < THIS ? THIS : t.week, title: t.title,
          status: t.status === 'Done' ? 'Done' : 'To Do', assignee_ids: [S.acs.me.id], team: S.acs.me.team || null }).select('id').single());
        Object.assign(t, check(await P.from('private_tasks').update({ acs_task_id: acsTask.id }).eq('id', t.id).select().single()));
        return true;
      });
      if (ok) { dlg.close(); toast('Sent to ACS'); render(); }
    };
    dlg.showModal();
  }

  async function start() {
    const { data } = await P.auth.getSession();
    if (!data.session) return showLogin();
    await run(async () => { await loadTasks(); await loadAcs().catch(() => { S.acs = null; }); if (S.acs) await pullAcs(null, true); });
    render();
  }

  function boot() {
    if (!cfg || !cfg.URL || !cfg.KEY) {
      $('#view').innerHTML = '<div class="empty"><h3>Not set up yet</h3><p>Add the private project’s publishable key in private/config.js.</p></div>';
      return;
    }
    P = window.supabase.createClient(cfg.URL, cfg.KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    A = window.supabase.createClient(acsCfg.SUPABASE_URL, acsCfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    $('#outBtn').onclick = async () => { await P.auth.signOut(); S.tasks = []; showLogin(); };
    start();
  }
  boot();
  // Installable as its own app: the site's service worker (one level up) also serves this page.
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js').catch(() => {}));
})();
