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
  const S = { tasks: [], acs: null, week: 'now', addWeek: THIS, q: '', layout: 'project', sort: 'status', group: 'project', order: 'status', open: null, details: undefined };
  try {
    S.layout = ['board', 'table'].indexOf(localStorage.getItem('pv-layout')) !== -1 ? localStorage.getItem('pv-layout') : 'project';
    const v = JSON.parse(localStorage.getItem('pv-view') || '{}');
    if (['project', 'status', 'created', 'modified', 'none'].indexOf(v.group) !== -1) S.group = v.group;
    if (['status', 'new', 'old', 'modified'].indexOf(v.order) !== -1) S.order = v.order;
  } catch (e) { /* blocked */ }
  /** Group and sort are remembered on this device. */
  const remember = () => { try { localStorage.setItem('pv-view', JSON.stringify({ group: S.group, order: S.order })); } catch (e) { /* blocked */ } };
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
    // Blocked reasons, notes and sub-steps need the newer setup script; until it is run, they are off.
    if (S.details === undefined) S.details = !(await P.from('private_tasks').select('subtasks').limit(1)).error;
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
    const rows = check(await A.from('tasks').select('id,project_id,week,title,status,assignee_ids,created_by,block_note,subtasks,created_at'));
    const mine = rows.filter(t => ((t.assignee_ids || []).indexOf(me) !== -1 || (!(t.assignee_ids || []).length && t.created_by === me)) &&
      (ws.indexOf(t.week) !== -1 || (t.status !== 'Done' && t.week < THIS)));
    const pname = t => (S.acs.projects.find(p => p.id === t.project_id) || { name: '' }).name;
    const byAcs = {};
    S.tasks.forEach(t => { if (t.acs_task_id) byAcs[t.acs_task_id] = t; });
    const add = [], upd = [];
    mine.forEach(t => {
      const v = Object.assign({ week: t.week, title: t.title, status: t.status, project: pname(t) },
        S.details ? { block_note: t.block_note || '', subtasks: t.subtasks || [] } : {});
      const have = byAcs[t.id];
      if (!have) add.push(Object.assign({ source: 'acs', acs_task_id: t.id, created_at: t.created_at }, v));
      else if (have.source === 'acs' && Object.keys(v).some(k => JSON.stringify(have[k]) !== JSON.stringify(v[k]))) upd.push({ id: have.id, v: v });
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
  const STATUSES = [['To Do', 'To do'], ['In Progress', 'Doing'], ['Blocked', 'Blocked'], ['Done', 'Done']];
  const label = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];
  const REASONS = ['Waiting for someone', 'Approval', 'Information', 'Budget', 'Time'];
  const slug = v => String(v || '').toLowerCase().replace(/[^a-z]+/g, '-');
  const rank = t => t.status === 'Blocked' ? 0 : t.week < THIS && t.status !== 'Done' ? 1 : t.status === 'Done' ? 3 : 2;
  const subs = t => Array.isArray(t.subtasks) ? t.subtasks : [];
  // ---------- Created / last changed ----------
  const dayKey = v => { const d = new Date(v); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function dayLabel(key) {
    const today = dayKey(Date.now()), yest = dayKey(Date.now() - 86400000);
    if (key === today) return 'Today';
    if (key === yest) return 'Yesterday';
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: y === new Date().getFullYear() ? undefined : 'numeric' });
  }
  const when = v => v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const ORDERS = [['status', 'Status'], ['new', 'Newest first'], ['old', 'Oldest first'], ['modified', 'Recently changed']];
  /** The chosen order inside a group or board column. */
  function ordered(list) {
    const by = { status: (a, b) => rank(a) - rank(b), new: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
      old: (a, b) => (a.created_at || '').localeCompare(b.created_at || ''), modified: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') };
    return list.slice().sort(by[S.order] || by.status);
  }
  const isCopy = t => t.source === 'acs';   // copied from ACS: ACS is the source, change it there
  const searchOk = t => !S.q || (t.title + ' ' + t.project + ' ' + (t.notes || '')).toLowerCase().indexOf(S.q.toLowerCase()) !== -1;
  const projectNames = () => Array.from(new Set(S.tasks.map(t => t.project).filter(Boolean)
    .concat(S.acs ? S.acs.projects.filter(p => p.status !== 'Done' && p.status !== 'Canceled').map(p => p.name) : []))).sort();

  /** Small tags after a task's title: carried over, blocked (with the reason), sub-steps, next week, ACS. */
  function tags(t, ws) {
    const n = subs(t).length, d = subs(t).filter(x => x.done).length;
    return [
      t.week < THIS && t.status !== 'Done' ? `<span class="tag-carry">from week ${wnum(t.week)}</span>` : '',
      t.status === 'Blocked' ? `<span class="tag-block">Blocked${t.block_note ? ': ' + esc(t.block_note) : ''}</span>` : '',
      t.status === 'In Progress' ? '<span class="st st-in-progress">Doing</span>' : '',
      n ? `<span class="pv-tag">☑ ${d}/${n}</span>` : '',
      ws && ws.length > 1 && t.week === NEXT ? '<span class="pv-tag">next week</span>' : '',
      isCopy(t) ? '<span class="pv-tag acs">from ACS</span>' : t.acs_task_id ? '<span class="pv-tag sent">sent to ACS</span>' : '',
    ].join('');
  }

  const GROUPS = [['project', 'Project'], ['status', 'Status'], ['created', 'Day created'], ['modified', 'Day last changed'], ['none', 'No grouping']];
  /** The list: grouped by project, status, day created or day last changed; sorted inside each group. */
  function listHtml(list, ws) {
    const g = S.group;
    const keyOf = t => g === 'status' ? t.status : g === 'created' ? dayKey(t.created_at) : g === 'modified' ? dayKey(t.updated_at) : g === 'none' ? '' : (t.project || 'No project');
    const groups = {};
    list.forEach(t => { const k = keyOf(t); (groups[k] = groups[k] || []).push(t); });
    const keys = Object.keys(groups).sort((x, y) => g === 'status' ? STATUSES.findIndex(s2 => s2[0] === x) - STATUSES.findIndex(s2 => s2[0] === y)
      : g === 'created' || g === 'modified' ? y.localeCompare(x) : x.localeCompare(y));
    const title = k => g === 'status' ? label(k) : g === 'created' || g === 'modified' ? dayLabel(k) : g === 'none' ? 'All tasks' : k;
    const stamp = t => g === 'created' ? 'created ' + when(t.created_at) : g === 'modified' || S.order === 'modified' ? 'changed ' + when(t.updated_at) : S.order === 'new' || S.order === 'old' ? 'created ' + when(t.created_at) : '';
    const row = t => `<div class="pv-row${t.status === 'Done' ? ' done' : ''}">
      <button type="button" class="pv-check${t.status === 'Done' ? ' on' : ''}" data-done="${t.id}"${isCopy(t) ? ' disabled title="Copied from ACS: change it in ACS"' : ''} aria-label="${t.status === 'Done' ? 'Mark as not done' : 'Mark as done'}">${t.status === 'Done' ? '✓' : ''}</button>
      <button type="button" class="pv-title link-btn" data-open="${t.id}">${esc(t.title)}${g !== 'project' && t.project ? ` <small class="muted">· ${esc(t.project)}</small>` : ''}</button>
      <span class="pv-tags">${tags(t, ws)}${stamp(t) ? `<small class="muted pv-when">${stamp(t)}</small>` : ''}</span></div>`;
    return keys.map(k => `<section class="card"><h3 class="card-title">${esc(title(k))} <small class="muted">${groups[k].length}</small></h3>
      ${ordered(groups[k]).map(row).join('')}</section>`).join('');
  }
  function boardHtml(list) {
    return `<div class="board4">${STATUSES.map(([st, lab]) => {
      const col = ordered(list.filter(t => t.status === st));
      return `<section class="bcol" data-col="${st}"><h3 class="bcol-head">${lab}<small>${col.length}</small></h3>
        ${col.map(t => `<button type="button" class="bcard" data-open="${t.id}"${isCopy(t) ? '' : ` draggable="true" data-drag="${t.id}"`}>
          <span class="bcard-title">${esc(t.title)}</span><span class="bcard-meta"><span class="grow">${esc(t.project || 'No project')}</span>${tags(t)}</span></button>`).join('') || '<p class="muted small bcol-empty">Nothing here</p>'}
      </section>`;
    }).join('')}</div>`;
  }
  function tableHtml(list) {
    const keys = { task: t => t.title.toLowerCase(), project: t => (t.project || '').toLowerCase(), week: t => t.week,
      status: t => STATUSES.findIndex(x => x[0] === t.status), source: t => t.source + (t.acs_task_id ? '1' : '0'),
      created: t => t.created_at || '', modified: t => t.updated_at || '' };
    const k = keys[S.sort] ? S.sort : 'status';
    const desc = k === 'created' || k === 'modified';   // dates: newest first
    const rows = list.slice().sort((a, b) => (keys[k](a) < keys[k](b) ? -1 : keys[k](a) > keys[k](b) ? 1 : rank(a) - rank(b)) * (desc ? -1 : 1));
    const th = (id, l) => `<th><button type="button" class="th-btn${k === id ? ' on' : ''}" data-sort="${id}">${l}${k === id ? ' ↓' : ''}</button></th>`;
    return `<div class="table-wrap"><table class="ttable"><thead><tr>${th('task', 'Task')}${th('project', 'Project')}${th('week', 'Week')}${th('status', 'Status')}${th('created', 'Created')}${th('modified', 'Last changed')}${th('source', 'Where')}</tr></thead>
      <tbody>${rows.map(t => `<tr class="${t.status === 'Done' ? 'done' : ''}"><td class="tt"><button type="button" class="link-btn" data-open="${t.id}">${esc(t.title)}</button>${t.status === 'Blocked' && t.block_note ? ` <small class="muted">— ${esc(t.block_note)}</small>` : ''}</td>
        <td>${esc(t.project)}</td><td class="num">${wnum(t.week)}</td><td><span class="st st-${slug(t.status)}">${label(t.status)}</span></td>
        <td class="num">${when(t.created_at)}</td><td class="num">${when(t.updated_at)}</td>
        <td>${isCopy(t) ? 'from ACS' : t.acs_task_id ? 'sent to ACS' : 'private'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function render() {
    document.body.classList.add('signed-in');
    $('#outBtn').hidden = false;
    const ws = weeksOf(S.week);
    const list = S.tasks.filter(t => inWeeks(t, ws) && searchOk(t));
    const names = projectNames();
    const body = !list.length ? `<div class="empty"><h3>No tasks${S.q ? ' match' : ' in these weeks'}</h3><p>Add one above.</p></div>`
      : S.layout === 'board' ? boardHtml(list) : S.layout === 'table' ? tableHtml(list) : listHtml(list, ws);
    $('#view').innerHTML = `
      <div class="page-title"><h2>Private tasks</h2><span class="pv-lock">Only you</span></div>
      ${S.details === false ? '<div class="mtg-note warn"><span>Run the updated <b>private-setup.sql</b> once in the private project’s SQL Editor to turn on blocked reasons, notes and sub-steps.</span></div>' : ''}
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
        <label class="f${S.week !== 'now' ? ' set' : ''}"><span>Week</span><select id="pvWeek">${[['now', 'This + next week'], [THIS, 'This week · ' + wnum(THIS)], [NEXT, 'Next week · ' + wnum(NEXT)], [LAST, 'Last week · ' + wnum(LAST)], [shiftWeek(THIS, -2), 'Week ' + wnum(shiftWeek(THIS, -2))], [shiftWeek(THIS, -3), 'Week ' + wnum(shiftWeek(THIS, -3))]]
          .map(o => `<option value="${o[0]}"${o[0] === S.week ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>
        <input type="search" class="search f-search" id="pvSearch" placeholder="Search" value="${esc(S.q)}" autocomplete="off">
        ${S.layout === 'project' ? `<label class="f${S.group !== 'project' ? ' set' : ''}"><span>Group</span><select id="pvGroup">${GROUPS.map(o => `<option value="${o[0]}"${o[0] === S.group ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>` : ''}
        ${S.layout !== 'table' ? `<label class="f${S.order !== 'status' ? ' set' : ''}"><span>Sort</span><select id="pvOrder">${ORDERS.map(o => `<option value="${o[0]}"${o[0] === S.order ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>` : ''}
        ${S.acs ? `<button type="button" class="secondary small-btn" id="pullBtn">Update from ACS${S.week === 'now' ? '' : ' (week ' + wnum(S.week) + ')'}</button>` : ''}
        <div class="seg layout-seg" role="group" aria-label="Layout">${[['project', 'List'], ['board', 'Board'], ['table', 'Table']].map(l => `<button type="button" data-layout="${l[0]}" class="${S.layout === l[0] ? 'on' : ''}">${l[1]}</button>`).join('')}</div>
      </div>
      <div class="plist">${body}</div>
      <section class="card" style="margin-top:14px"><h3 class="card-title">Link to ACS</h3>
        ${S.acs ? `<p class="small">Linked as <b>${esc(S.acs.me.name)}</b>. Your ACS tasks are copied here (and kept up to date) when you open this page. Nothing goes to ACS unless you press <b>Send to ACS</b> on a task.</p>`
          : `<p class="small muted" style="margin-bottom:8px">Sign in to ACS to copy your ACS tasks here and to send a task there. (If you are signed in to the ACS app in this browser, this happens by itself.)</p>
          <form class="pv-link" id="linkForm"><input name="username" placeholder="ACS username" autocomplete="off" required><input name="password" type="password" placeholder="ACS password" autocomplete="off" required><button class="secondary small-btn" type="submit">Link</button></form>`}
      </section>`;
    bind();
    if (S.open) renderSheet();
  }

  /** Save a change to one private task: shown at once, undone if the save fails. */
  async function save(t, change) {
    const before = Object.assign({}, t);
    Object.assign(t, change); render();
    const saved = await run(async () => check(await P.from('private_tasks').update(change).eq('id', t.id).select().single()));
    Object.assign(t, saved || before); render();
  }

  function bind() {
    $$('[data-aw]').forEach(b => b.onclick = () => { S.addWeek = b.dataset.aw; keepAdd(render); });
    $('#pvWeek').onchange = e => { S.week = e.target.value; render(); };
    const pg = $('#pvGroup'); if (pg) pg.onchange = () => { S.group = pg.value; remember(); render(); };
    const po = $('#pvOrder'); if (po) po.onchange = () => { S.order = po.value; remember(); render(); };
    const q = $('#pvSearch');
    q.oninput = () => { S.q = q.value; const p = q.selectionStart; render(); const q2 = $('#pvSearch'); q2.focus(); q2.setSelectionRange(p, p); };
    $$('[data-layout]').forEach(b => b.onclick = () => { S.layout = b.dataset.layout; try { localStorage.setItem('pv-layout', S.layout); } catch (e) { /* blocked */ } render(); });
    $$('[data-sort]').forEach(b => b.onclick = () => { S.sort = b.dataset.sort; render(); });
    $$('[data-open]').forEach(b => b.onclick = () => { S.open = b.dataset.open; renderSheet(); });
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
    $$('[data-done]').forEach(b => b.onclick = () => {
      const t = S.tasks.find(x => x.id === b.dataset.done);
      save(t, t.status === 'Done' ? { status: 'To Do' } : { status: 'Done', week: t.week < THIS ? THIS : t.week });
    });
    // Board: drag a private task to another column
    $$('[data-drag]').forEach(c => { c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.drag); });
    $$('.bcol').forEach(col => {
      col.ondragover = e => { e.preventDefault(); col.classList.add('drop'); };
      col.ondragleave = () => col.classList.remove('drop');
      col.ondrop = e => {
        e.preventDefault(); col.classList.remove('drop');
        const t = S.tasks.find(x => x.id === e.dataTransfer.getData('text/plain'));
        if (t && !isCopy(t) && t.status !== col.dataset.col) save(t, Object.assign({ status: col.dataset.col }, t.week < THIS ? { week: THIS } : {}));
      };
    });
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

  /**
   * One task, in a sheet: status (blocked with a reason), title, notes, sub-steps, week, project,
   * Send to ACS and Delete. A copy from ACS is shown read-only: it is changed in ACS.
   */
  function renderSheet() {
    // A box losing focus while the sheet is redrawn fires its save, which redraws again: do that after.
    if (renderSheet.busy) { renderSheet.again = true; return; }
    renderSheet.busy = true;
    try { drawSheet(); } finally {
      renderSheet.busy = false;
      if (renderSheet.again) { renderSheet.again = false; setTimeout(renderSheet, 0); }
    }
  }
  function drawSheet() {
    const dlg = $('#dialog');
    const t = S.tasks.find(x => x.id === S.open);
    if (!t) { S.open = null; if (dlg.open) dlg.close(); return; }
    const ro = isCopy(t), det = S.details !== false;
    const scroll = dlg.open && $('.sheet-body', dlg) ? $('.sheet-body', dlg).scrollTop : 0;
    // Keep what is being typed when a save redraws the sheet: the new sub-step, and the box in use.
    const typed = {};
    if (dlg.open) {
      const ns = $('#pvNewSub', dlg); if (ns && ns.value) typed.pvNewSub = ns.value;
      const fx = document.activeElement;
      if (fx && dlg.contains(fx) && fx.id && /INPUT|TEXTAREA/.test(fx.tagName)) { typed[fx.id] = fx.value; typed.focus = fx.id; }
    }
    dlg.innerHTML = `<div class="sheet pv-sheet"><header class="sheet-head"><span></span><h3>${ro ? 'From ACS' : 'Private task'} · week ${wnum(t.week)}</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
      <div class="sheet-body">
        <p class="muted small pv-stamps">Created ${when(t.created_at)} · last changed ${when(t.updated_at)}</p>
        ${ro ? `<p class="mtg-note"><span>Copied from ACS. Change it in the ACS app; this copy follows it.</span><a class="text-btn" href="../#/my">Open ACS</a></p>
          <h3 class="pv-sheet-title">${esc(t.title)}</h3>
          <p class="small"><span class="st st-${slug(t.status)}">${label(t.status)}</span> ${esc(t.project)}</p>
          ${t.status === 'Blocked' ? `<p class="small tag-block-note">Blocked: ${esc(t.block_note || 'no reason given')}</p>` : ''}
          ${subs(t).length ? `<ul class="plain subs-ro">${subs(t).map(x => `<li class="${x.done ? 'done' : ''}">${x.done ? '✔' : '○'} ${esc(x.t)}</li>`).join('')}</ul>` : ''}`
        : `<label class="field">Task<textarea id="pvTitle" rows="2" maxlength="300">${esc(t.title)}</textarea></label>
          <p class="qa-label">Status</p>
          <div class="seg pv-status">${STATUSES.map(([st, lab]) => `<button type="button" data-st="${st}" class="${t.status === st ? 'on' : ''}">${lab}</button>`).join('')}</div>
          ${t.status === 'Blocked' && det ? `<div class="block-box"><p class="small"><strong>What is blocking it?</strong></p>
            <div class="chips">${REASONS.map(r => `<button type="button" class="chip${t.block_note === r ? ' on' : ''}" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
            <input id="pvBlock" placeholder="Or type the reason" value="${esc(t.block_note || '')}"></div>` : ''}
          <p class="qa-label">Week</p>
          <div class="seg">${[THIS, NEXT].map(w => `<button type="button" data-wk="${w}" class="${t.week === w ? 'on' : ''}">${w === THIS ? 'This week' : 'Next week'} · ${wnum(w)}</button>`).join('')}</div>
          <label class="field" style="margin-top:12px">Project or topic<input id="pvProject" list="pvProjects2" value="${esc(t.project)}" autocomplete="off"><datalist id="pvProjects2">${projectNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
          ${det ? `<p class="qa-label">Sub-steps</p>
          <div class="subs">${subs(t).map((x, i) => `<label class="sub"><input type="checkbox" data-sub="${i}"${x.done ? ' checked' : ''}><span class="${x.done ? 'done' : ''}">${esc(x.t)}</span><button type="button" data-subdel="${i}" aria-label="Remove sub-step">×</button></label>`).join('')}
            <div class="inline"><input id="pvNewSub" placeholder="Add a sub-step" autocomplete="off"><button type="button" class="secondary" id="pvAddSub">Add</button></div></div>
          <label class="field" style="margin-top:12px">Notes<textarea id="pvNotes" rows="3" placeholder="Details, links, who to talk to…">${esc(t.notes || '')}</textarea></label>` : ''}
          <div class="actions-row" style="margin-top:14px">${t.acs_task_id ? '<span class="pv-tag sent">sent to ACS</span>' : S.acs ? '<button type="button" class="secondary small-btn" id="pvSend">Send to ACS</button>' : ''}
            <button type="button" class="ghost danger-text small-btn" id="pvDelete">Delete task</button></div>`}
      </div></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.onclose = () => { S.open = null; dlg.classList.remove('pv-side'); };
    if (!ro) {
      const title = $('#pvTitle', dlg);
      title.onchange = () => setTimeout(() => { const v = title.value.replace(/\s+/g, ' ').trim(); if (v && v !== t.title) save(t, { title: v }); else title.value = t.title; }, 0);
      $$('[data-st]', dlg).forEach(b => b.onclick = () => save(t, Object.assign({ status: b.dataset.st }, t.week < THIS ? { week: THIS } : {})));
      $$('[data-reason]', dlg).forEach(b => b.onclick = () => save(t, { block_note: b.dataset.reason }));
      const bn = $('#pvBlock', dlg); if (bn) bn.onchange = () => { const v = bn.value.trim(); setTimeout(() => save(t, { block_note: v }), 0); };
      $$('[data-wk]', dlg).forEach(b => b.onclick = () => save(t, { week: b.dataset.wk }));
      const pr = $('#pvProject', dlg); pr.onchange = () => { const v = pr.value.trim(); setTimeout(() => save(t, { project: v }), 0); };
      const notes = $('#pvNotes', dlg); if (notes) notes.onchange = () => { const v = notes.value; setTimeout(() => save(t, { notes: v }), 0); };
      $$('[data-sub]', dlg).forEach(c => c.onchange = () => save(t, { subtasks: subs(t).map((x, i) => i === Number(c.dataset.sub) ? { t: x.t, done: c.checked } : x) }));
      $$('[data-subdel]', dlg).forEach(b => b.onclick = () => save(t, { subtasks: subs(t).filter((x, i) => i !== Number(b.dataset.subdel)) }));
      const addSub = () => {
        const i = $('#pvNewSub', dlg); const v = i.value.trim(); if (!v) return;
        i.value = '';
        save(t, { subtasks: subs(t).concat({ t: v, done: false }) }).then(() => { const n = $('#pvNewSub'); if (n) n.focus(); });
      };
      const as = $('#pvAddSub', dlg); if (as) { as.onclick = addSub; $('#pvNewSub', dlg).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } }; }
      const send = $('#pvSend', dlg); if (send) send.onclick = () => { dlg.close(); sendDialog(t); };
      $('#pvDelete', dlg).onclick = async () => {
        if (!confirm('Delete this private task?')) return;
        if (await run(async () => { check(await P.from('private_tasks').delete().eq('id', t.id)); return true; })) {
          S.tasks = S.tasks.filter(x => x.id !== t.id); dlg.close(); render();
        }
      };
    }
    dlg.classList.add('pv-side');   // a side panel on a computer, full screen on a phone
    if (!dlg.open) dlg.showModal();
    const sb = $('.sheet-body', dlg); if (sb) sb.scrollTop = scroll;
    Object.keys(typed).forEach(id => { const el = id !== 'focus' && $('#' + id, dlg); if (el) el.value = typed[id]; });
    if (typed.focus && $('#' + typed.focus, dlg)) $('#' + typed.focus, dlg).focus();
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
        const acsTask = check(await A.from('tasks').insert(Object.assign({ project_id: pid, week: t.week < THIS ? THIS : t.week, title: t.title,
          status: t.status, assignee_ids: [S.acs.me.id], team: S.acs.me.team || null },
          S.details ? { block_note: t.block_note || '', subtasks: subs(t), notes: t.notes || '' } : {})).select('id').single());
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
