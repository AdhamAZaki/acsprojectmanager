// Private tasks: a small tracker for one person, in its own Supabase project.
// * Your private tasks live only in the private project (one owner, rows readable by the owner only).
// * Linked to ACS (the shared tracker) one way: your ACS tasks (last, this and next week, and anything
//   still open from before) are copied in when you open the page, and the copies follow ACS: a task
//   changed or done there is updated here. Use "Update from ACS" for another week.
// * A private task goes to ACS only when you press "Send to ACS" on it.
// The ACS sign-in is the same one as the ACS app on this site, so if you are signed in there,
// the link works without signing in again.
//
// The page is laid out like the ACS app (and uses its w- styles): one search-and-filter box whose
// filters show as tags, View (List · Board · Table, Group by, Sort, Show empty groups), Shortcuts,
// and one panel on the right for a task. Only the tasks scroll.
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
  const weekName = w => (w === THIS ? 'This week' : w === NEXT ? 'Next week' : w === LAST ? 'Last week' : 'Week') + (w === THIS || w === NEXT || w === LAST ? ' · ' : ' ') + wnum(w);

  // ---------- State ----------
  const S = {
    tasks: [], acs: null,     // acs: { me, projects } while ACS is linked
    details: undefined,       // false until the newer private-setup.sql is run (blocked reasons, notes, sub-steps)
    layout: 'list', group: 'project', sort: 'added', showEmpty: true,   // remembered on this device
    q: '', searchOpen: false,
    week: 'now', fStatus: 'all', fProject: 'all', fSource: 'all',      // filters
    task: null,               // task open in the panel
    subsOpen: {}, folded: {}, pending: false,
  };
  try {
    const v = JSON.parse(localStorage.getItem('pv-page') || '{}');
    if (['list', 'board', 'table'].indexOf(v.layout) !== -1) S.layout = v.layout;
    ['group', 'sort'].forEach(k => { if (typeof v[k] === 'string') S[k] = v[k]; });
    if (typeof v.showEmpty === 'boolean') S.showEmpty = v.showEmpty;
  } catch (e) { /* blocked */ }
  const remember = () => { try { localStorage.setItem('pv-page', JSON.stringify({ layout: S.layout, group: S.group, sort: S.sort, showEmpty: S.showEmpty })); } catch (e) { /* blocked */ } };
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
    const rows = check(await A.from('tasks').select('id,project_id,week,title,status,assignee_ids,created_by,block_note,subtasks,notes,created_at'));
    const mine = rows.filter(t => ((t.assignee_ids || []).indexOf(me) !== -1 || (!(t.assignee_ids || []).length && t.created_by === me)) &&
      (ws.indexOf(t.week) !== -1 || (t.status !== 'Done' && t.week < THIS)));
    const pname = t => (S.acs.projects.find(p => p.id === t.project_id) || { name: '' }).name;   // '' = no project
    const byAcs = {};
    S.tasks.forEach(t => { if (t.acs_task_id) byAcs[t.acs_task_id] = t; });
    const add = [], upd = [];
    mine.forEach(t => {
      const v = Object.assign({ week: t.week, title: t.title, status: t.status, project: pname(t), notes: t.notes || '' },
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

  // ---------- Sign in ----------
  function showLogin(msg, email) {
    document.body.classList.remove('signed-in');
    $('#shell').hidden = true;
    $('#loginView').innerHTML = `<section class="login" style="display:block"><div class="login-card">
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

  // ---------- Task rules ----------
  const STATUSES = [['To Do', 'To do'], ['In Progress', 'Doing'], ['Blocked', 'Blocked'], ['Done', 'Done']];
  const statusLabel = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];
  const REASONS = ['Waiting for someone', 'Approval', 'Information', 'Budget', 'Time'];
  const WHERE = { private: 'Private', acs: 'From ACS', sent: 'Sent to ACS' };
  const slug = v => String(v || '').toLowerCase().replace(/[^a-z]+/g, '-');
  const subs = t => Array.isArray(t.subtasks) ? t.subtasks : [];
  const isDone = t => t.status === 'Done';
  const carried = t => t.week < THIS && !isDone(t);
  /** The week a task is in now: an unfinished task from an earlier week is still open this week. */
  const shownWeek = t => carried(t) ? THIS : t.week;
  const isCopy = t => t.source === 'acs';   // copied from ACS: ACS is the source
  /** A private task, or a copy from ACS while ACS is linked (its changes are saved in ACS too). */
  const editable = t => !isCopy(t) || !!S.acs;
  const whereOf = t => isCopy(t) ? 'acs' : t.acs_task_id ? 'sent' : 'private';
  const findTask = id => S.tasks.find(t => t.id === id);
  const statusChange = (t, s) => Object.assign({ status: s }, s === 'Done' && t.week < THIS ? { week: THIS } : {});
  const dayKey = v => { const d = new Date(v); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function dayLabel(key) {
    if (key === dayKey(Date.now())) return 'Today';
    if (key === dayKey(Date.now() - 86400000)) return 'Yesterday';
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: y === new Date().getFullYear() ? undefined : 'numeric' });
  }
  const when = v => v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const acsOpenProjects = () => S.acs ? S.acs.projects.filter(p => p.status !== 'Done' && p.status !== 'Canceled') : [];
  /** Project and topic names to offer: the ones in use, and the open ACS projects. */
  const projectNames = () => Array.from(new Set(S.tasks.map(t => t.project).filter(Boolean).concat(acsOpenProjects().map(p => p.name)))).sort();

  /**
   * Save a change to one task: shown at once, undone if the save fails. A copy from ACS is saved
   * in ACS first (as you), then here, so both stay the same. `quiet`: a text edit; the page is
   * drawn again once the person leaves the boxes, so typing is never interrupted.
   */
  async function save(t, change, quiet) {
    const before = Object.assign({}, t);
    Object.assign(t, change);
    if (quiet) S.pending = true; else render();
    const saved = await run(async () => {
      if (isCopy(t)) {
        const row = {};
        ['title', 'status', 'week', 'block_note', 'notes', 'subtasks'].forEach(k => { if (k in change) row[k] = change[k]; });
        if ('project' in change) {
          const p = S.acs.projects.find(x => x.name.toLowerCase() === String(change.project || '').toLowerCase());
          if (change.project && !p) throw new Error('There is no ACS project called “' + change.project + '”. A task from ACS is on an ACS project, or on none.');
          row.project_id = p ? p.id : null;
        }
        const res = await A.from('tasks').update(row).eq('id', t.acs_task_id).select('id');
        if (res.error) throw new Error('ACS: ' + res.error.message);
        if (!res.data || !res.data.length) throw new Error('ACS did not accept the change (the task may have been deleted there).');
      }
      return check(await P.from('private_tasks').update(change).eq('id', t.id).select().single());
    });
    Object.assign(t, saved || before);
    if (quiet && saved && typing()) S.pending = true; else render();
  }
  async function addTask(v) {
    const saved = await run(async () => check(await P.from('private_tasks').insert(v).select().single()));
    if (saved) S.tasks.push(saved);
    return saved;
  }

  // ---------- Filters ----------
  const weeksOf = v => v === 'now' ? [THIS, NEXT] : [v];
  const inWeeks = (t, ws) => ws.some(w => w === THIS ? shownWeek(t) === THIS : t.week === w);
  const SPECIAL = { open: t => !isDone(t), carried: carried };
  const statusOk = t => S.fStatus === 'all' || (SPECIAL[S.fStatus] ? SPECIAL[S.fStatus](t) : t.status === S.fStatus);
  const searchOk = (t, q) => !q || (t.title + ' ' + t.project + ' ' + (t.notes || '')).toLowerCase().indexOf(q.toLowerCase()) !== -1;
  function tasksInView() {
    const ws = weeksOf(S.week), q = S.q.trim();
    return S.tasks.filter(t => inWeeks(t, ws) && searchOk(t, q) && (S.fSource === 'all' || whereOf(t) === S.fSource) &&
      (S.fProject === 'all' || (S.fProject === 'none' ? !t.project : t.project === S.fProject)));
  }
  /** Everything that can be filtered. The search box, its tags and the shortcuts all read this one list. */
  function filterDefs() {
    return [
      { k: 'week', label: 'Week', def: 'now', opts: [THIS, NEXT, LAST, shiftWeek(THIS, -2), shiftWeek(THIS, -3)].map(w => [w, weekName(w)]) },
      { k: 'fStatus', label: 'Status', def: 'all', opts: [['open', 'Open (not done)']].concat(STATUSES, [['carried', 'Carried over']]) },
      { k: 'fProject', label: 'Project', def: 'all', opts: Array.from(new Set(S.tasks.map(t => t.project).filter(Boolean))).sort().map(p => [p, p]).concat([['none', 'No project']]) },
      { k: 'fSource', label: 'Where', def: 'all', opts: Object.keys(WHERE).map(k => [k, WHERE[k]]) },
    ];
  }

  // ---------- Grouping and sorting: the same for List, Board and Table ----------
  /** `set(key, task)`: what changes when a task is dragged into that group (none: the grouping is for looking only). */
  const FIELD = {
    project: { label: 'Project', key: t => t.project || '', title: k => k || 'No project', set: k => ({ project: k }) },
    status: { label: 'Status', key: t => t.status, title: statusLabel, order: STATUSES.map(s => s[0]), set: (k, t) => statusChange(t, k) },
    week: { label: 'Week', key: shownWeek, title: weekName, set: k => ({ week: k }) },
    where: { label: 'Where', key: whereOf, title: k => WHERE[k], order: Object.keys(WHERE) },
    created: { label: 'Day created', key: t => dayKey(t.created_at), title: dayLabel, desc: true },
    modified: { label: 'Day last changed', key: t => dayKey(t.updated_at), title: dayLabel, desc: true },
    none: { label: 'No grouping', key: () => '', title: () => 'All tasks' },
  };
  const SORTS = {
    added: ['Date added', (a, b) => (a.created_at || '').localeCompare(b.created_at || '')],
    title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
    status: ['Status', (a, b) => STATUSES.findIndex(s => s[0] === a.status) - STATUSES.findIndex(s => s[0] === b.status)],
    changed: ['Last changed', (a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')],
  };
  /** Every group a grouping could show, inside the filters in use. */
  function allKeys(gid) {
    if (gid === 'project') return S.fProject === 'none' ? [''] : S.fProject !== 'all' ? [S.fProject] : Array.from(new Set(S.tasks.map(t => t.project).filter(Boolean))).concat(['']);
    if (gid === 'status') return S.fStatus === 'all' ? STATUSES.map(s => s[0]) : SPECIAL[S.fStatus] ? ['To Do', 'In Progress', 'Blocked'] : [S.fStatus];
    if (gid === 'week') return weeksOf(S.week);
    if (gid === 'where') return S.fSource === 'all' ? Object.keys(WHERE) : [S.fSource];
    return gid === 'none' ? [''] : [];
  }
  /** Groups in a fixed order (names A–Z with "No project" last; statuses and weeks in their own order), so a change to a task never moves a group. */
  function groups(list) {
    const gid = FIELD[S.group] ? S.group : 'project', f = FIELD[gid], map = {};
    if (S.showEmpty && !S.q.trim()) allKeys(gid).forEach(k => { map[k] = []; });
    list.forEach(t => { const k = f.key(t); (map[k] = map[k] || []).push(t); });
    const keys = Object.keys(map).sort((a, b) => f.order ? f.order.indexOf(a) - f.order.indexOf(b) : f.desc ? b.localeCompare(a) : (a === '') - (b === '') || a.localeCompare(b));
    const cmp = (SORTS[S.sort] || SORTS.added)[1];
    return keys.map(k => ({ key: k, title: f.title(k), tasks: map[k].slice().sort(cmp), field: gid, canSet: !!f.set }));
  }
  /** Add a task from the line under a group: it takes the group's project, status or week. */
  async function addInline(title, g) {
    const ws = weeksOf(S.week);
    const v = { title: title, project: S.fProject !== 'all' && S.fProject !== 'none' ? S.fProject : '', week: ws.indexOf(THIS) !== -1 ? THIS : ws[0] };
    if (g.field === 'project') v.project = g.key;
    if (g.field === 'status') v.status = g.key;
    if (g.field === 'week') v.week = g.key;
    if (await addTask(v)) toast('Added');
    render();
  }

  // ---------- Pieces of a task ----------
  const statusSel = t => editable(t)
    ? `<select class="w-st st-${slug(t.status)}" id="st-${t.id}" data-chg="status" data-id="${t.id}" aria-label="Status">${STATUSES.map(s => `<option value="${s[0]}"${s[0] === t.status ? ' selected' : ''}>${s[1]}</option>`).join('')}</select>`
    : `<span class="w-st st-${slug(t.status)}" title="Link ACS to change this task">${esc(statusLabel(t.status))}</span>`;
  const whereTag = t => isCopy(t) ? '<span class="w-pill pv-acs">from ACS</span>' : t.acs_task_id ? '<span class="w-pill pv-sent">sent to ACS</span>' : '';
  function tagsHtml(t, gid) {
    return [
      gid !== 'project' ? `<span>${esc(t.project || 'No project')}</span>` : '',
      carried(t) ? `<span class="tag-carry">from week ${wnum(t.week)}</span>` : gid !== 'week' && t.week > THIS ? `<span class="w-pill">${t.week === NEXT ? 'next week' : 'week ' + wnum(t.week)}</span>` : '',
      t.status === 'Blocked' ? `<span class="tag-block">Blocked${t.block_note ? ': ' + esc(t.block_note) : ''}</span>` : '',
      gid !== 'where' ? whereTag(t) : '',
    ].join('');
  }
  const subsChip = t => subs(t).length ? `<button type="button" class="w-chip${S.subsOpen[t.id] ? ' on' : ''}" data-act="subs" data-id="${t.id}" title="Show sub-tasks" aria-expanded="${!!S.subsOpen[t.id]}">☑ ${subs(t).filter(s => s.done).length}/${subs(t).length} ${S.subsOpen[t.id] ? '▴' : '▾'}</button>` : '';
  /** Sub-tasks: tick, edit the text in place, remove. `where` keeps the box ids apart (r = row or card, p = panel). */
  function subsHtml(t, where, withAdd) {
    const edit = editable(t);
    return `<div class="w-subs">${subs(t).map((s, i) => edit
      ? `<div class="w-sub${s.done ? ' done' : ''}"><input type="checkbox" id="${where}c-${t.id}-${i}" data-chg="subc" data-id="${t.id}" data-i="${i}"${s.done ? ' checked' : ''} aria-label="Done">
        <input type="text" id="${where}s-${t.id}-${i}" data-txt="sub" data-id="${t.id}" data-i="${i}" value="${esc(s.t)}" maxlength="300" aria-label="Sub-task"><button type="button" class="w-x" data-act="subdel" data-id="${t.id}" data-i="${i}" aria-label="Remove sub-task">×</button></div>`
      : `<div class="w-sub ro${s.done ? ' done' : ''}"><span>${s.done ? '✔' : '○'}</span><span>${esc(s.t)}</span></div>`).join('')}
      ${withAdd && edit ? `<form class="w-inline" data-form="sub" data-id="${t.id}"><input id="newsub-${t.id}" data-keep="sub-${t.id}" placeholder="Add a sub-task" maxlength="300" autocomplete="off"><button class="secondary small-btn" type="submit">Add</button></form>` : ''}</div>`;
  }
  const weekChoices = sel => [THIS, NEXT].concat(sel !== THIS && sel !== NEXT ? [sel] : []).map(w => `<option value="${w}"${w === sel ? ' selected' : ''}>${weekName(w)}</option>`).join('');

  // ---------- Layouts ----------
  const canAddTo = g => g.field === 'none' || g.canSet;
  const addLine = (g, i) => canAddTo(g) ? `<form class="w-add" data-form="add" data-g="${i}"><input id="add-${i}" data-keep="add-${esc(g.field + ':' + g.key)}" autocomplete="off" maxlength="300" placeholder="+ Add a private task${g.field === 'none' ? '' : ' to ' + esc(g.title)} (type, then Enter)" aria-label="Add a private task${g.field === 'none' ? '' : ' to ' + esc(g.title)}"></form>` : '';
  function listHtml(gs) {
    return `<div class="w-groups">${gs.map((g, i) => `<section class="w-grp" data-group="${esc(g.key)}"><header class="w-ghead">
        <button type="button" class="w-caret" data-act="fold" data-g="${i}" aria-label="Fold or unfold ${esc(g.title)}">${S.folded[g.field + ':' + g.key] ? '▸' : '▾'}</button>
        <div class="w-gtitle"><h3 class="w-gname">${esc(g.title)}</h3><span class="w-count">${g.tasks.length}</span></div><span></span></header>
      ${S.folded[g.field + ':' + g.key] ? '' : g.tasks.map(t => `<div class="w-row pv${isDone(t) ? ' done' : ''}${S.task === t.id ? ' sel' : ''}">
        <button type="button" class="w-chk${isDone(t) ? ' on' : ''}" data-act="done" data-id="${t.id}"${editable(t) ? '' : ' disabled title="Link ACS to change this task"'} aria-label="${isDone(t) ? 'Mark as not done' : 'Mark as done'}">${isDone(t) ? '✓' : ''}</button>
        <div><button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button><div class="w-meta">${tagsHtml(t, g.field)}</div></div>
        <div class="w-side"><span class="c-sub">${subsChip(t)}</span><span class="c-st">${statusSel(t)}</span></div>
        ${S.subsOpen[t.id] && subs(t).length ? subsHtml(t, 'r', false) : ''}</div>`).join('') + addLine(g, i)}</section>`).join('')}</div>`;
  }
  function boardHtml(gs) {
    return `<div class="w-board">${gs.map((g, i) => `<section class="w-col" data-col="${esc(g.key)}"${g.canSet ? ` data-drop="${i}"` : ''}><header class="w-chead"><h3>${esc(g.title)}</h3><span class="w-count">${g.tasks.length}</span></header>
      ${g.tasks.map(t => { const drag = g.canSet && editable(t); return `<article class="w-card${isDone(t) ? ' done' : ''}${S.task === t.id ? ' sel' : ''}"${drag ? ` data-drag="${t.id}"` : ''}>
        <div class="w-ctitle">${drag ? '<span class="grip" title="Drag to move">⋮⋮</span>' : ''}<button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button></div>
        <div class="w-meta">${tagsHtml(t, g.field)}</div>
        <div class="w-meta">${subsChip(t)}<span class="w-grow"></span>${g.field === 'status' ? '' : statusSel(t)}</div>
        ${S.subsOpen[t.id] && subs(t).length ? subsHtml(t, 'r', false) : ''}</article>`; }).join('')}
      ${addLine(g, i) || (g.tasks.length ? '' : '<p class="muted small w-none">Nothing here</p>')}</section>`).join('')}</div>`;
  }
  function tableHtml(gs) {
    return `<div class="w-twrap"><table class="w-table"><thead><tr><th>Task</th><th>Project</th><th>Week</th><th>Status</th><th>Sub-tasks</th><th>Where</th><th>Created</th><th>Last changed</th></tr></thead><tbody>
      ${gs.map((g, i) => (g.field === 'none' ? '' : `<tr class="w-gh"><td colspan="8">${esc(g.title)} <span class="w-count">${g.tasks.length}</span></td></tr>`) +
        g.tasks.map(t => `<tr class="${isDone(t) ? 'done' : ''}${S.task === t.id ? ' sel' : ''}">
        <td class="w-tt"><button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button>${carried(t) ? ` <span class="tag-carry">from week ${wnum(t.week)}</span>` : ''}${S.subsOpen[t.id] && subs(t).length ? subsHtml(t, 'r', false) : ''}</td>
        <td>${esc(t.project || 'No project')}</td>
        <td>${editable(t) ? `<select class="w-cell" id="tw-${t.id}" data-chg="week" data-id="${t.id}" aria-label="Week">${weekChoices(t.week)}</select>` : weekName(t.week)}</td>
        <td>${statusSel(t)}</td><td>${subsChip(t) || '<span class="muted">–</span>'}</td><td>${esc(WHERE[whereOf(t)])}</td>
        <td class="muted">${when(t.created_at)}</td><td class="muted">${when(t.updated_at)}</td></tr>`).join('') +
        (addLine(g, i) ? `<tr class="w-addtr"><td colspan="8">${addLine(g, i)}</td></tr>` : '')).join('')}</tbody></table></div>`;
  }
  /** Drag and drop with a mouse or a finger (on a phone: the ⋮⋮ handle): move a card over another column and let go. */
  function bindBoard(root, gs) {
    $$('[data-drag]', root).forEach(el => {
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('select, input, .w-chip')) return;
        if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return;
        const id = el.dataset.drag, x0 = e.clientX, y0 = e.clientY;
        let ghost = null, over = null;
        const move = ev => {
          if (!ghost) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
            ghost = el.cloneNode(true); ghost.classList.add('drag-ghost'); ghost.style.width = el.offsetWidth + 'px';
            document.body.appendChild(ghost); el.classList.add('dragging'); document.body.classList.add('is-dragging');
          }
          ev.preventDefault();
          ghost.style.transform = 'translate(' + (ev.clientX - 24) + 'px,' + (ev.clientY - 18) + 'px)';
          ghost.style.display = 'none';
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          ghost.style.display = '';
          const tgt = under && under.closest('[data-drop]');
          if (tgt !== over) { if (over) over.classList.remove('drop'); over = tgt; if (over) over.classList.add('drop'); }
          const box = root.getBoundingClientRect();
          if (ev.clientY < box.top + 50) root.scrollTop -= 14; else if (ev.clientY > box.bottom - 50) root.scrollTop += 14;
          if (ev.clientX < box.left + 50) root.scrollLeft -= 16; else if (ev.clientX > box.right - 50) root.scrollLeft += 16;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          if (!ghost) return;
          ghost.remove(); el.classList.remove('dragging'); document.body.classList.remove('is-dragging');
          if (over) over.classList.remove('drop');
          S.dragged = Date.now();   // the click that ends a drag does not open the task
          const g = over && gs[Number(over.dataset.drop)], t = findTask(id);
          if (!g || !t || !g.canSet || !editable(t) || FIELD[g.field].key(t) === g.key) return;
          save(t, FIELD[g.field].set(g.key, t));
          toast('Moved to ' + g.title);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
      });
    });
  }

  // ---------- The top of the page ----------
  function suggHtml(defs) {
    const q = S.q.trim().toLowerCase();
    const gs = defs.map(d => ({ d: d, opts: d.opts.filter(o => o[0] !== S[d.k] && (!q || (d.label + ' ' + o[1]).toLowerCase().indexOf(q) !== -1)) })).filter(g => g.opts.length);
    const hits = q ? S.tasks.filter(t => searchOk(t, q)).sort((a, b) => b.week.localeCompare(a.week)).slice(0, 6) : [];
    return `<div class="w-sugg" id="sugg">
      ${q ? '' : '<p class="muted small w-sugg-tip">Type to search your tasks, or pick a filter below. Each filter you pick becomes a tag in the box.</p>'}
      ${hits.length ? `<h4>Tasks</h4><div class="w-sugg-items col">${hits.map(t => `<button type="button" class="w-hit" data-act="gopen" data-id="${t.id}"><span>${esc(t.title)}</span><small class="muted">${esc(t.project || 'No project')} · week ${wnum(t.week)} · ${esc(statusLabel(t.status))}</small></button>`).join('')}</div>` : ''}
      ${gs.map(g => `<h4>Filter by ${g.d.label.toLowerCase()}</h4><div class="w-sugg-items">${g.opts.map(o => `<button type="button" class="w-opt" data-act="filter" data-k="${g.d.k}" data-v="${esc(o[0])}">${esc(o[1])}</button>`).join('')}</div>`).join('')}
      ${q && !gs.length && !hits.length ? '<p class="muted small w-sugg-tip">Nothing matches.</p>' : ''}</div>`;
  }
  function searchHtml(defs) {
    const chips = defs.filter(d => S[d.k] !== d.def).map(d => {
      const o = d.opts.find(x => x[0] === S[d.k]);
      return `<span class="w-fchip">${d.label}: <b>${esc(o ? o[1] : S[d.k])}</b><button type="button" class="w-x" data-act="unfilter" data-k="${d.k}" aria-label="Remove the ${d.label.toLowerCase()} filter">×</button></span>`;
    }).join('');
    return `<div class="w-gbox"><span class="w-label">Filter</span>${chips}
        <input type="search" id="gq" placeholder="Search tasks, or filter by project, status, week, where…" value="${esc(S.q)}" autocomplete="off" aria-label="Search and filter">
        ${chips || S.q ? '<button type="button" class="text-btn" data-act="clear" id="clearFilters">Clear</button>' : ''}</div>
      ${S.searchOpen ? suggHtml(defs) : ''}`;
  }
  /** The link to ACS: who you are linked as, or the sign-in to link. */
  function linkItems() {
    return S.acs ? `<p class="muted small w-menu-note">Linked as <b>${esc(S.acs.me.name)}</b>. Your ACS tasks are copied here (and kept up to date) when you open this page. Nothing goes to ACS unless you press <b>Send to ACS</b> on a task.</p>
        <button type="button" data-act="pull">Update from ACS${S.week === 'now' ? '' : ' (week ' + wnum(S.week) + ')'}</button><a class="pv-menu-link" href="../">Open the ACS app</a>`
      : `<p class="muted small w-menu-note">Sign in to ACS to copy your ACS tasks here and to send a task there. (If you are signed in to the ACS app in this browser, this happens by itself.)</p>
        <form class="pv-link" id="linkForm" data-form="link"><input name="username" placeholder="ACS username" autocomplete="off" required aria-label="ACS username"><input name="password" type="password" placeholder="ACS password" autocomplete="off" required aria-label="ACS password"><button class="secondary small-btn" type="submit">Link</button></form>`;
  }
  function actionsHtml() {
    return `${S.acs ? '<button type="button" class="secondary small-btn w-wide" data-act="pull" id="pullBtn">Update from ACS</button>' : ''}
      <button type="button" class="primary small" data-act="newtask" id="addTaskBtn">+ Task</button>
      <details class="w-menu" id="linkMenu"><summary class="secondary small-btn" role="button">${S.acs ? 'ACS link' : 'Link to ACS'} ▾</summary><div class="w-menu-items pv-menu">${linkItems()}<hr><button type="button" data-act="signout" id="outBtn">Sign out</button></div></details>`;
  }
  function barsHtml(base) {
    const sel = (key, label, opts) => `<label class="w-f"><span>${label}</span><select id="v-${key}" data-chg="${key}">${opts.map(o => `<option value="${esc(o[0])}"${o[0] === S[key] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    const n = fn => base.filter(fn).length;
    const short = (k, v, label, cls, count) => `<button type="button" class="w-kpi ${cls || ''}${S[k] === v ? ' on' : ''}" data-act="short" data-k="${k}" data-v="${esc(v)}" aria-pressed="${S[k] === v}">${count === undefined ? '' : `<b>${count}</b>`}${label}</button>`;
    const what = S.layout === 'board' ? 'columns' : 'groups';
    return `<div class="w-bars">
        <div class="w-bar"><span class="w-label">View</span>
          <div class="w-seg" role="group" aria-label="Layout">${[['list', 'List'], ['board', 'Board'], ['table', 'Table']].map(l => `<button type="button" data-act="layout" data-k="${l[0]}" class="${S.layout === l[0] ? 'on' : ''}" aria-pressed="${S.layout === l[0]}">${l[1]}</button>`).join('')}</div>
          ${sel('group', S.layout === 'board' ? 'Columns' : 'Group by', Object.keys(FIELD).filter(k => S.layout !== 'board' || k !== 'none').map(k => [k, FIELD[k].label]))}
          ${sel('sort', 'Sort', Object.keys(SORTS).map(k => [k, SORTS[k][0]]))}
          <label class="w-f tick" title="Also show the ${what} that have no tasks"><input type="checkbox" id="v-empty" data-chg="empty"${S.showEmpty ? ' checked' : ''}><span>Show empty ${what}</span></label>
        </div>
        <div class="w-bar"><span class="w-label">Shortcuts</span>
          ${short('fStatus', 'open', 'Open', '', n(SPECIAL.open))}${short('fStatus', 'Blocked', 'Blocked', 'k-bad', n(t => t.status === 'Blocked'))}${short('fStatus', 'Done', 'Done', 'k-ok', n(isDone))}${short('fStatus', 'carried', 'Carried over', 'k-warn', n(carried))}
          <span class="w-sep"></span>${Object.keys(WHERE).map(k => short('fSource', k, WHERE[k])).join('')}
        </div>
      </div>
      ${S.details === false ? '<div class="w-note"><span>Run the updated <b>private-setup.sql</b> once in the private project’s SQL Editor to turn on blocked reasons, notes and sub-tasks.</span></div>' : ''}`;
  }

  // ---------- The task panel ----------
  function panelHtml(t) {
    const copy = isCopy(t), det = S.details !== false;
    const head = `<header class="w-phead"><span class="muted small w-grow">${copy ? 'From ACS' : 'Private task'} · week ${wnum(t.week)}</span><button type="button" class="secondary small-btn" data-act="close">Close ✕</button></header>`;
    if (!editable(t)) {
      return head + `<div class="w-pbody">
        <p class="w-note"><span>Copied from ACS. Link ACS (top right) to change it here, or change it in the ACS app.</span></p>
        <h3 class="w-ro-title">${esc(t.title)}</h3>
        <p>${statusSel(t)} ${esc(t.project || 'No project')}${t.status === 'Blocked' ? ` <span class="tag-block">${esc(t.block_note || 'no reason given')}</span>` : ''}</p>
        ${subs(t).length ? `<div><span class="w-label">Sub-tasks</span>${subsHtml(t, 'p', false)}</div>` : ''}</div>`;
    }
    const projects = copy ? acsOpenProjects().map(p => p.name).concat(t.project && !acsOpenProjects().some(p => p.name === t.project) ? [t.project] : []) : [];
    return head + `<div class="w-pbody">
      <p class="muted small">Created ${when(t.created_at)} · last changed ${when(t.updated_at)}</p>
      ${copy ? '<p class="w-note"><span>From ACS: what you change here is saved in ACS too.</span></p>' : ''}
      <div><span class="w-label">Task</span><textarea class="w-title-in" id="p-title" rows="2" maxlength="300" data-txt="title" data-id="${t.id}" aria-label="Task title">${esc(t.title)}</textarea></div>
      <div><span class="w-label">Status</span><div class="w-seg" role="group" aria-label="Status">${STATUSES.map(s => `<button type="button" data-act="pstatus" data-id="${t.id}" data-k="${s[0]}" class="${t.status === s[0] ? 'on' : ''}" aria-pressed="${t.status === s[0]}">${s[1]}</button>`).join('')}</div>
        ${t.status === 'Blocked' && det ? `<div class="w-block"><div class="w-pchips">${REASONS.map(r => `<button type="button" class="w-chip${t.block_note === r ? ' on' : ''}" data-act="reason" data-id="${t.id}" data-k="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          <input id="p-block" data-txt="block_note" data-id="${t.id}" value="${esc(t.block_note || '')}" placeholder="Or type what is blocking it" aria-label="What is blocking it"></div>` : ''}</div>
      <div class="w-two"><div><span class="w-label">${copy ? 'ACS project' : 'Project or topic'}</span>
          ${copy ? `<select id="p-project" data-chg="project" data-id="${t.id}" aria-label="ACS project"><option value="">No project</option>${projects.map(p => `<option value="${esc(p)}"${p === t.project ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>`
            : `<input id="p-project" data-txt="project" data-id="${t.id}" list="pv-projects" value="${esc(t.project)}" placeholder="No project" autocomplete="off" aria-label="Project or topic"><datalist id="pv-projects">${projectNames().map(p => `<option value="${esc(p)}">`).join('')}</datalist>`}</div>
        <div><span class="w-label">Week</span><select id="p-week" data-chg="week" data-id="${t.id}" aria-label="Week">${weekChoices(t.week)}</select></div></div>
      ${det ? `<div><span class="w-label">Sub-tasks${subs(t).length ? ' · ' + subs(t).filter(s => s.done).length + '/' + subs(t).length : ''}</span>${subsHtml(t, 'p', true)}</div>
      <div><span class="w-label">Notes</span><textarea id="p-notes" rows="3" data-txt="notes" data-id="${t.id}" placeholder="Details, links, who to talk to…" aria-label="Notes">${esc(t.notes || '')}</textarea></div>` : ''}
      ${copy ? '' : `<div class="w-pfoot pv-foot">${t.acs_task_id ? '<span class="w-pill pv-sent">sent to ACS</span>' : S.acs ? `<button type="button" class="secondary small-btn" data-act="send" data-id="${t.id}" id="pvSend">Send to ACS</button>` : '<span></span>'}
        <button type="button" class="ghost danger-text small-btn" data-act="del" data-id="${t.id}" id="pvDelete">Delete task</button></div>`}
    </div>`;
  }

  // ---------- Sheets: add a task, send a task to ACS ----------
  function addSheet() {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form class="sheet qa-sheet" id="qaForm"><header class="sheet-head"><button type="button" class="text-btn" data-close>Close</button><h3>Add a private task</h3><button type="submit" class="text-btn strong">Add</button></header>
      <div class="sheet-body"><p class="qa-label" style="margin-top:0">Task</p><textarea name="title" rows="2" maxlength="300" placeholder="A private task" aria-label="Task" required></textarea>
        <p class="qa-label">Project or topic</p><input name="project" list="pv-projects-add" placeholder="No project" autocomplete="off" aria-label="Project or topic" value="${esc(S.fProject !== 'all' && S.fProject !== 'none' ? S.fProject : '')}"><datalist id="pv-projects-add">${projectNames().map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        <p class="qa-label">When</p><select name="week" aria-label="Week">${weekChoices(weeksOf(S.week).indexOf(THIS) !== -1 ? THIS : NEXT)}</select>
        <p class="muted small qa-hint">Tap <b>Add</b> and type the next one. The project and week stay chosen.</p></div></form>`;
    const f = $('#qaForm', dlg);
    $('[data-close]', f).onclick = () => dlg.close();
    f.onsubmit = async e => {
      e.preventDefault();
      const title = f.elements.title.value.replace(/\s+/g, ' ').trim();
      if (!title) { f.elements.title.focus(); return; }
      if (!(await addTask({ title: title, project: f.elements.project.value.trim(), week: f.elements.week.value }))) return;
      toast('Added');
      f.elements.title.value = ''; f.elements.title.focus();
    };
    dlg.onclose = () => { dlg.onclose = null; render(); };
    dlg.showModal();
    f.elements.title.focus();
  }
  /** Send one private task to ACS, on an ACS project you pick (or none). It becomes a normal ACS task of yours. */
  function sendSheet(t) {
    const dlg = $('#dialog');
    const open = acsOpenProjects();
    const guess = open.find(p => p.name.toLowerCase() === String(t.project || '').toLowerCase());
    dlg.innerHTML = `<form class="sheet" id="sendForm"><header class="sheet-head"><button type="button" class="text-btn" data-close>Cancel</button><h3>Send to ACS</h3><button type="submit" class="text-btn strong">Send</button></header>
      <div class="sheet-body"><p style="margin-bottom:10px"><b>${esc(t.title)}</b></p>
        <p class="small muted" style="margin-bottom:10px">This copy becomes one of your normal ACS tasks: the people who can see your ACS tasks will see it. The private copy stays here, marked “sent to ACS”.</p>
        <label class="field">ACS project<select name="project"><option value="">No project</option>${open.map(p => `<option value="${esc(p.id)}"${guess && guess.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </div></form>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    $('#sendForm').onsubmit = async e => {
      e.preventDefault();
      const pid = e.target.elements.project.value || null;
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

  // ---------- Drawing ----------
  let restoring = false;   // true while render() puts the cursor back
  const typing = () => $('#dialog').open || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
  /** Draws the page from the state. Only the tasks scroll; what is being typed and the cursor survive the redraw. */
  function render() {
    S.pending = false;
    $('#loginView').innerHTML = '';
    document.body.classList.add('signed-in');
    $('#shell').hidden = false;
    const act = document.activeElement, fid = act && act.id, pos = act && typeof act.selectionStart === 'number' ? act.selectionStart : null;
    const kept = {};
    $$('#shell [data-keep]').forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    const openMenus = $$('#shell details.w-menu[open]').map(d => d.id);
    const body = $('#panel .w-pbody'), scroll = body ? body.scrollTop : 0;
    if (!FIELD[S.group] || (S.layout === 'board' && S.group === 'none')) S.group = S.layout === 'board' ? 'status' : 'project';
    if (!SORTS[S.sort]) S.sort = 'added';

    const defs = filterDefs();
    const base = tasksInView(), list = base.filter(statusOk), gs = groups(list);
    render.groups = gs;
    $('#gsearch').innerHTML = searchHtml(defs);
    $('#topActions').innerHTML = actionsHtml();
    $('#bars').innerHTML = barsHtml(base);
    const view = $('#view');
    view.className = 'w-data w-' + S.layout;
    view.innerHTML = (S.layout === 'board' ? boardHtml(gs) : S.layout === 'table' ? tableHtml(gs) : listHtml(gs)) +
      (list.length ? '' : `<p class="empty w-empty">No tasks ${S.q.trim() || defs.some(d => S[d.k] !== d.def) ? 'match the search and filters' : 'this week or next'}. Use <b>+ Task</b> to add one.</p>`);
    if (S.layout === 'board') bindBoard(view, gs);

    const t = S.task && findTask(S.task), panel = $('#panel');
    if (!t) S.task = null;
    $('#shell').classList.toggle('panel-on', !!t);
    panel.hidden = !t;
    panel.innerHTML = t ? panelHtml(t) : '';
    const nb = $('#panel .w-pbody'); if (nb) nb.scrollTop = scroll;

    $$('#shell [data-keep]').forEach(i => { if (kept[i.dataset.keep] && !i.value) i.value = kept[i.dataset.keep]; });
    openMenus.forEach(id => { const d = id && document.getElementById(id); if (d) d.open = true; });
    if (fid && !$('#shell').contains(act)) {
      const el = document.getElementById(fid);
      if (el && $('#shell').contains(el)) { restoring = true; el.focus(); restoring = false; if (pos !== null && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text box */ } } }
    }
  }

  // ---------- What happens when something is tapped, changed or typed ----------
  const closeSugg = () => { S.searchOpen = false; const s = $('#sugg'); if (s) s.remove(); };
  const ACTIONS = {
    layout: (b, k) => { S.layout = k; remember(); },
    fold: b => { const g = render.groups[Number(b.dataset.g)], key = g.field + ':' + g.key; S.folded[key] = !S.folded[key]; },
    subs: (b, k, t) => { S.subsOpen[t.id] = !S.subsOpen[t.id]; },
    open: (b, k, t) => { if (Date.now() - (S.dragged || 0) < 400) return false; S.task = S.task === t.id ? null : t.id; },
    gopen: (b, k, t) => { S.task = t.id; S.searchOpen = false; },
    close: () => { S.task = null; },
    done: (b, k, t) => { save(t, isDone(t) ? { status: 'To Do' } : statusChange(t, 'Done')); return false; },
    pstatus: (b, k, t) => { save(t, statusChange(t, k)); return false; },
    reason: (b, k, t) => { save(t, { block_note: k }); return false; },
    subdel: (b, k, t) => { save(t, { subtasks: subs(t).filter((x, i) => i !== Number(b.dataset.i)) }); return false; },
    del: (b, k, t) => {
      if (!confirm('Delete this private task?')) return false;
      run(async () => { check(await P.from('private_tasks').delete().eq('id', t.id)); return true; }).then(ok => {
        if (ok) { S.tasks = S.tasks.filter(x => x.id !== t.id); S.task = null; }
        render();
      });
      return false;
    },
    send: (b, k, t) => { sendSheet(t); return false; },
    filter: (b, k) => { S[k] = b.dataset.v; S.q = ''; S.searchOpen = false; },
    unfilter: (b, k) => { S[k] = k === 'week' ? 'now' : 'all'; },
    short: (b, k) => { S[k] = S[k] === b.dataset.v ? 'all' : b.dataset.v; },
    clear: () => { S.week = 'now'; S.fStatus = 'all'; S.fProject = 'all'; S.fSource = 'all'; S.q = ''; S.searchOpen = false; },
    newtask: () => { addSheet(); return false; },
    pull: () => { run(() => pullAcs(S.week === 'now' ? null : [S.week])).then(render); return false; },
    signout: () => { P.auth.signOut().then(() => { S.tasks = []; S.task = null; showLogin(); }); return false; },
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (S.searchOpen && !e.target.closest('#gsearch')) closeSugg();
    $$('#shell details.w-menu[open]').forEach(d => { if (!d.contains(e.target) || b) d.open = false; });
    if (!b || !ACTIONS[b.dataset.act]) return;
    const t = b.dataset.id ? findTask(b.dataset.id) : null;
    if (ACTIONS[b.dataset.act](b, b.dataset.k, t) !== false) render();   // an action that draws the page itself (or opens a sheet) returns false
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el.closest || !el.closest('#shell')) return;
    const c = el.dataset.chg, x = el.dataset.txt, t = el.dataset.id ? findTask(el.dataset.id) : null;
    if (c === 'group' || c === 'sort') { S[c] = el.value; remember(); return render(); }
    if (c === 'empty') { S.showEmpty = el.checked; remember(); return render(); }
    if (!t) return;
    if (c === 'status') save(t, statusChange(t, el.value));
    else if (c === 'week') save(t, { week: el.value });
    else if (c === 'project') save(t, { project: el.value });
    else if (c === 'subc') save(t, { subtasks: subs(t).map((s, i) => i === Number(el.dataset.i) ? { t: s.t, done: el.checked } : s) });
    else if (x === 'title') { const v = el.value.replace(/\s+/g, ' ').trim(); if (v && v !== t.title) save(t, { title: v }, true); else el.value = t.title; }
    else if (x === 'project') { const v = el.value.trim(); if (v !== (t.project || '')) save(t, { project: v }, true); }
    else if (x === 'block_note' || x === 'notes') { const v = x === 'notes' ? el.value : el.value.trim(); if (v !== (t[x] || '')) save(t, { [x]: v }, true); }
    else if (x === 'sub') {
      const i = Number(el.dataset.i), v = el.value.replace(/\s+/g, ' ').trim();
      if (v && subs(t)[i] && v !== subs(t)[i].t) save(t, { subtasks: subs(t).map((s, j) => j === i ? { t: v, done: s.done } : s) }, true); else if (subs(t)[i]) el.value = subs(t)[i].t;
    }
  });
  document.addEventListener('input', e => { if (e.target.id === 'gq') { S.q = e.target.value; S.searchOpen = true; render(); } });
  document.addEventListener('focusin', e => {
    if (restoring || $('#shell').hidden) return;
    if (e.target.id === 'gq') { if (!S.searchOpen) { S.searchOpen = true; render(); } }
    else if (S.searchOpen && !(e.target.closest && e.target.closest('#gsearch'))) closeSugg();
  });
  // A text edit is saved without redrawing; the page is drawn again once the person leaves the boxes.
  document.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !typing()) render(); }, 300));
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form, t = f.dataset.id ? findTask(f.dataset.id) : null;
    if (kind === 'link') {
      const u = f.elements.username.value.trim().toLowerCase();
      const email = u.indexOf('@') !== -1 ? u : u + '@' + acsCfg.EMAIL_DOMAIN;
      A.auth.signInWithPassword({ email: email, password: f.elements.password.value }).then(res => {
        if (res.error) return toast('ACS: wrong username or password.', true);
        return run(async () => { await loadAcs(); await pullAcs(); }).then(render);
      });
      return;
    }
    const i = $('input', f), v = i.value.replace(/\s+/g, ' ').trim();
    if (!v) return;
    i.value = '';
    if (kind === 'add') addInline(v, render.groups[Number(f.dataset.g)]);
    else if (kind === 'sub' && t) save(t, { subtasks: subs(t).concat({ t: v, done: false }) });
  });
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (e.key === 'Escape') {
      if (S.searchOpen) closeSugg();
      else if (S.task && !$('#dialog').open) { S.task = null; render(); }
      return;
    }
    if (el.id === 'gq' && e.key === 'Enter') { e.preventDefault(); closeSugg(); return; }
    if (el.id === 'p-title' && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && $('#sugg') && el.closest && el.closest('#gsearch')) {
      const items = $$('#sugg button'), i = items.indexOf(el);
      const next = e.key === 'ArrowDown' ? items[i + 1] : i <= 0 ? $('#gq') : items[i - 1];
      if (next) { e.preventDefault(); next.focus(); }
    }
  });

  async function start() {
    const { data } = await P.auth.getSession();
    if (!data.session) return showLogin();
    await run(async () => { await loadTasks(); await loadAcs().catch(() => { S.acs = null; }); if (S.acs) await pullAcs(null, true); });
    render();
  }

  function boot() {
    if (!cfg || !cfg.URL || !cfg.KEY) {
      $('#loginView').innerHTML = '<div class="empty"><h3>Not set up yet</h3><p>Add the private project’s publishable key in private/config.js.</p></div>';
      return;
    }
    P = window.supabase.createClient(cfg.URL, cfg.KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    A = window.supabase.createClient(acsCfg.SUPABASE_URL, acsCfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    start();
  }
  boot();
  // Installable as its own app: the site's service worker (one level up) also serves this page.
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js').catch(() => {}));
})();
