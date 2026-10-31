// ACS Weekly Tasks: UI. Plain JS, no build step. Mobile-first.
// One page: the weekly board (every project, this week and next side by side, tasks editable in
// place), viewed as My tasks / My projects / All projects, or By person for admins. Admins also
// get Manage behind the settings button.
// Departments (e.g. Automation and BMS) each have their own board, minutes and email; everyone
// opens on their own department's board and can switch. Admins manage every department, a
// "Dept admin" only their own.
(function () {
  const Api = window.Api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PROJECT_TYPES = ['PLC', 'AVEVA', 'AVEVA + PLC', 'Other'];   // fallback when the database has no departments yet
  // Same statuses as the Notion "Projects" database.
  const PROJECT_STATUSES = ['In Progress', 'Planning', 'Paused', 'Backlog', 'Done', 'Canceled'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const CLOSED = ['Done', 'Canceled'];

  // The current and next week. Re-checked while the app is open (see checkWeek), so an
  // app left open over the weekend moves on to the new week by itself.
  let THIS = isoWeek(new Date());
  let NEXT = shiftWeek(THIS, 1);

  const S = {
    data: null,          // see Api.refresh()
    which: 'this',       // My tasks / project page: 'this' or 'next' week
    open: {},            // expanded task rows
    project: null,       // open project page
    mtgWeek: THIS,
    manageTab: 'projects',
    projectFilter: 'Open',
    projectSearch: '',
    lastProject: null,
    lastWrite: 0,
    minutes: {},         // saved minutes per week: record, null (none saved) or undefined (loading)
    mtgEdit: {},         // week -> true while editing a week that has saved minutes
    board: null,         // 'me' | 'mine' | 'all' | 'people' (admins); remembered per device
    addFor: null,        // project whose own add box is open
    addWeek: null,       // week picked in the add box (e.g. by "Plan next week")
    collapsed: null,     // card key ('p:<project id>' / 'u:<user id>') -> true; remembered per device
    sheetTask: null,     // phone: task open in the bottom sheet
    fold: { blocked: true, quiet: true },   // phone: Blocked / No-update lists folded to one line
    dept: null,          // department whose board is shown (default: your own)
  };

  // ---------- Helpers ----------

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function slug(v) { return String(v || '').toLowerCase().replace(/[^a-z]+/g, '-'); }
  function initials(name) {
    return String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  }
  function shortName(name) {
    const w = String(name || '').replace(/\(.*?\)/g, '').trim().split(/\s+/);
    return w.length > 1 ? w[0] + ' ' + w[1][0] + '.' : w[0];
  }
  /** Re-checks the date. Returns true when a new week has started. */
  function checkWeek() {
    const now = isoWeek(new Date());
    if (now === THIS) return false;
    if (S.mtgWeek === THIS) S.mtgWeek = now;
    THIS = now;
    NEXT = shiftWeek(THIS, 1);
    return true;
  }
  /** Phone layout (narrower than 720px): tasks open in a bottom sheet, extras fold away. Desktop is unchanged. */
  const isPhone = () => window.matchMedia('(max-width: 719px)').matches;
  const typeClass = t => 'type-' + slug(t === 'AVEVA + PLC' ? 'aveva' : t);
  const isAdmin = () => S.data && S.data.me.role === 'Admin';
  const me = () => S.data.me;
  const member = id => S.data.team.find(m => m.id === id) || { name: 'Unknown', username: '', team: '' };
  const project = id => S.data.projects.find(p => p.id === id) || { id: id, name: '(removed project)', type: '', status: '' };
  const contact = id => S.data.contacts.find(c => c.id === id);

  // ---------- Departments ----------

  /** Admins manage every department; a "Dept admin" only their own. */
  const canManage = deptId => isAdmin() || (!!S.data && me().role === 'Dept admin' && me().departmentId === deptId);
  const isManager = () => isAdmin() || (!!S.data && me().role === 'Dept admin');
  const departments = () => S.data.departments && S.data.departments.length ? S.data.departments
    : [{ id: 'AUTO', name: 'Automation', teams: ['PLC', 'Dev'], projectTypes: PROJECT_TYPES }];
  const dept = id => departments().find(d => d.id === id) || departments()[0];
  const manyDepts = () => departments().length > 1;
  /** The department whose board is shown: your own, until you switch. */
  function curDept() {
    if (!S.dept || !departments().some(d => d.id === S.dept)) S.dept = dept(me().departmentId).id;
    return S.dept;
  }
  /** Meeting email columns: the department's sub-teams, or one column named after it. */
  const deptTeams = id => dept(id).teams.length ? dept(id).teams : [dept(id).name];
  const inDept = p => (p.departmentId || 'AUTO') === curDept();
  const deptProjects = () => S.data.projects.filter(inDept);
  /** Manage: admins work on the department in view, department admins on their own. */
  const manageDept = () => isAdmin() ? curDept() : me().departmentId;
  /** Can I manage what is on screen (the open project's department, or the board's)? */
  const managesHere = () => canManage(S.project ? project(S.project).departmentId : curDept());
  /** Saved minutes are per department and week. */
  const mkey = week => curDept() + ':' + week;

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2400);
  }
  async function guard(fn) {
    try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
  }

  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return date.getUTCFullYear() + '-W' + String(Math.ceil(((date - yearStart) / 86400000 + 1) / 7)).padStart(2, '0');
  }
  function weekMonday(week) {
    const [y, w] = week.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (w - 1) * 7);
    return mon;
  }
  function shiftWeek(week, n) {
    const m = weekMonday(week);
    m.setUTCDate(m.getUTCDate() + 7 * n);
    return isoWeek(new Date(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()));
  }
  function weekRange(week) {
    const mon = weekMonday(week);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const f = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return f(mon) + ' – ' + f(sun);
  }
  const wnum = w => Number(w.split('-W')[1]);
  function weekLabel(week) { return 'Week ' + wnum(week) + ' · ' + weekRange(week); }
  /** <option>s from strings, or from { value, label } objects. */
  function options(list, selected) {
    return list.map(o => typeof o === 'object'
      ? `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`
      : `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  const ICONS = {
    tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
    projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    meeting: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
    manage: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  const icon = (name, cls) => `<svg class="ico ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  // ---------- Task rules ----------

  const isDone = t => t.status === 'Done';
  const isBlocked = t => t.status === 'Blocked';
  /** "This week" shows this week's tasks plus anything unfinished from earlier weeks (it rolls over by itself). */
  function inView(t, which) {
    if (which === 'next') return t.week === NEXT;
    return t.week === THIS || (t.week < THIS && !isDone(t));
  }
  const isMine = t => t.createdBy === me().id || t.assigneeIds.indexOf(me().id) !== -1;
  const myProjectIds = () => S.data.assignments.filter(a => a.userId === me().id).map(a => a.projectId);
  const myProjects = () => S.data.projects.filter(p => myProjectIds().indexOf(p.id) !== -1)
    .sort((a, b) => (CLOSED.indexOf(a.status) !== -1) - (CLOSED.indexOf(b.status) !== -1) || a.name.localeCompare(b.name));
  const projectTeam = pid => S.data.assignments.filter(a => a.projectId === pid).map(a => member(a.userId));
  const liveContacts = t => t.contactIds.filter(id => contact(id));
  /** "Ahmed Hamdy, Eng. Moataz" — everyone on a task. */
  const who = t => t.assigneeIds.map(id => member(id).name).concat(liveContacts(t).map(id => contact(id).name)).join(', ');
  /** The people a task belongs to: its assigned team members, or its creator if nobody is assigned. */
  function ownersOf(t) {
    const ids = t.assigneeIds.filter(id => S.data.team.some(m => m.id === id));
    return ids.length ? ids : [t.createdBy];
  }
  /**
   * Meeting column(s), out of the project's department's columns: the teams of the people on the
   * task; else the task's team; else the project type if it names a column (PLC); else the last column.
   */
  function teamsOf(t) {
    const p = project(t.projectId);
    const cols = deptTeams(p.departmentId || curDept());
    const teams = Array.from(new Set(ownersOf(t).map(id => member(id).team).filter(x => cols.indexOf(x) !== -1)));
    if (teams.length) return teams;
    if (cols.indexOf(t.team) !== -1) return [t.team];
    return [cols.indexOf(p.type) !== -1 ? p.type : cols[cols.length - 1]];
  }

  /**
   * Change a task: show it at once and save only the changed fields in the background.
   * `change` is an object, or a function of the task that returns the fields to change
   * (use a function when the change depends on the task, e.g. adding a sub-task, so it
   * can be re-applied on top of a teammate's newer version). Undone on error.
   */
  function updateTask(t, change) {
    const fn = typeof change === 'function' ? change : () => change;
    S.data.tasks = S.data.tasks.map(x => x.id === t.id ? Object.assign({}, x, fn(x)) : x);
    S.lastWrite = Date.now();
    render();
    return Api.patchTask(t.id, fn).then(softRender, e => { toast(e.message, true); render(); });
  }
  const findTask = id => S.data.tasks.find(t => t.id === id);
  /** Where sub-task i (with this text) is now; it may have moved if a teammate changed the list. */
  function subIndex(t, i, text) {
    return t.subtasks[i] && t.subtasks[i].t === text ? i : t.subtasks.findIndex(s => s.t === text);
  }
  const addId = (list, id) => list.indexOf(id) === -1 ? list.concat(id) : list;

  // ---------- Task rows (My tasks and project pages) ----------

  function taskHtml(t, showOwner, inSheet) {
    const open = !!S.open[t.id] && (inSheet || !isPhone());
    const subDone = t.subtasks.filter(s => s.done).length;
    const team = projectTeam(t.projectId);
    const extra = t.assigneeIds.filter(id => !team.some(m => m.id === id)).map(member);
    return `
      <div class="t ${isDone(t) ? 'done' : ''}">
        <div class="t-row">
          <button type="button" class="t-check ${isDone(t) ? 'on' : ''}" data-done="${t.id}" aria-label="${isDone(t) ? 'Mark as not done' : 'Mark as done'}">${isDone(t) ? icon('check') : ''}</button>
          <button type="button" class="t-body" data-toggle="${t.id}" aria-expanded="${open}">
            <span class="t-title">${esc(t.title)}</span>
            <span class="t-meta">
              ${t.week < THIS && !isDone(t) ? `<span class="tag-carry">from week ${wnum(t.week)}</span>` : ''}
              ${isBlocked(t) ? '<span class="tag-block">Blocked</span>' : ''}
              ${t.subtasks.length ? `<span>☑ ${subDone}/${t.subtasks.length}</span>` : ''}
              ${showOwner ? '' : t.assigneeIds.filter(id => id !== me().id).map(id => `<span class="avatar sm" title="${esc(member(id).name)}">${esc(initials(member(id).name))}</span>`).join('')}
              ${liveContacts(t).map(id => `<span class="ext-chip">${esc(contact(id).name)}</span>`).join('')}
            </span>
          </button>
        </div>
        ${open ? `
        <div class="t-open">
          <label class="title-edit"><span class="muted small">Task</span><textarea rows="2" data-title="${t.id}" maxlength="300" aria-label="Task title">${esc(t.title)}</textarea></label>
          <div class="subs">
            ${t.subtasks.map((s, i) => `<label class="sub"><input type="checkbox" data-sub="${t.id}:${i}"${s.done ? ' checked' : ''}><span class="${s.done ? 'done' : ''}">${esc(s.t)}</span><button type="button" data-subdel="${t.id}:${i}" aria-label="Remove sub-task">×</button></label>`).join('')}
            <div class="inline"><input placeholder="Add a sub-task" data-newsub="${t.id}" data-keep="sub-${t.id}" autocomplete="off"><button type="button" class="secondary" data-addsub="${t.id}">Add</button></div>
          </div>
          <div class="people">
            ${team.concat(extra).map(m => `<label><input type="checkbox" data-asg="${t.id}:${m.id}"${t.assigneeIds.indexOf(m.id) !== -1 ? ' checked' : ''}><span class="avatar sm">${esc(initials(m.name))}</span>${esc(shortName(m.name))}</label>`).join('')}
            ${S.data.contacts.map(c => `<label class="ext"><input type="checkbox" data-ext="${t.id}:${c.id}"${t.contactIds.indexOf(c.id) !== -1 ? ' checked' : ''}>${esc(c.name)}</label>`).join('')}
          </div>
          <div class="inline"><input placeholder="Add someone outside the team" data-newext="${t.id}" data-keep="ext-${t.id}" autocomplete="off"><button type="button" class="secondary" data-addext="${t.id}">Add</button></div>
          ${isBlocked(t) ? `<input class="block-note" placeholder="What is blocking it?" data-blocknote="${t.id}" value="${esc(t.blockNote)}">` : ''}
          <div class="t-actions">
            <button type="button" class="${isBlocked(t) ? 'danger' : 'secondary'}" data-block="${t.id}">${isBlocked(t) ? 'Unblock' : 'Blocked?'}</button>
            <button type="button" class="secondary" data-move="${t.id}">${t.week === NEXT ? 'Move to this week' : 'Move to next week'}</button>
            ${canManage(project(t.projectId).departmentId) || t.createdBy === me().id ? `<button type="button" class="ghost danger-text" data-del="${t.id}">Delete</button>` : ''}
          </div>
        </div>` : ''}
      </div>`;
  }

  /** Phone: the open task, in a bottom sheet over the board. Redrawn with the board. */
  function renderTaskSheet() {
    const dlg = $('#dialog');
    const t = S.sheetTask && findTask(S.sheetTask);
    if (!t || !isPhone()) {
      if (dlg.dataset.mode === 'task') { delete dlg.dataset.mode; if (dlg.open) dlg.close(); }
      if (S.sheetTask && !t) S.sheetTask = null;
      return;
    }
    const body = $('.sheet-body', dlg);
    const scroll = dlg.dataset.mode === 'task' && body ? body.scrollTop : 0;
    dlg.dataset.mode = 'task';
    dlg.innerHTML = `<div class="sheet task-sheet">
      <header class="sheet-head"><span></span><h3>${esc(project(t.projectId).name)} · week ${wnum(t.week)}</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
      <div class="sheet-body">${taskHtml(t, false, true)}</div></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.onclose = () => {
      if (dlg.dataset.mode !== 'task') return;
      delete dlg.dataset.mode; S.open[S.sheetTask] = false; S.sheetTask = null; render();
    };
    // The title row toggles the task closed again in the sheet
    $$('[data-toggle]', dlg).forEach(b => b.setAttribute('aria-expanded', 'true'));
    bindTasks(dlg);
    $$('[data-toggle]', dlg).forEach(b => b.onclick = () => dlg.close());
    if (!dlg.open) dlg.showModal();
    const nb = $('.sheet-body', dlg); if (nb) nb.scrollTop = scroll;
  }

  function bindTasks(root) {
    const pair = v => v.split(':');
    $$('[data-done]', root).forEach(b => b.onclick = () => {
      const t = findTask(b.dataset.done);
      const done = !isDone(t);
      updateTask(t, x => done ? { status: 'Done', week: x.week < THIS ? THIS : x.week } : { status: 'To Do' });
      if (done) toast('Done ✔ — it goes into this week’s meeting');
    });
    $$('[data-toggle]', root).forEach(b => b.onclick = () => {
      const id = b.dataset.toggle;
      if (isPhone() && !root.closest('dialog')) { S.open[id] = true; S.sheetTask = id; render(); return; }
      S.open[id] = !S.open[id]; render();
    });
    $$('[data-sub]', root).forEach(c => c.onchange = () => {
      const [tid, i] = pair(c.dataset.sub); const t = findTask(tid);
      const text = t.subtasks[Number(i)].t; const done = c.checked;
      updateTask(t, x => {
        const k = subIndex(x, Number(i), text);
        return k === -1 ? {} : { subtasks: x.subtasks.map((s, j) => j === k ? { t: s.t, done: done } : s) };
      });
    });
    $$('[data-subdel]', root).forEach(b => b.onclick = e => {
      e.preventDefault(); const [tid, i] = pair(b.dataset.subdel); const t = findTask(tid);
      const text = t.subtasks[Number(i)].t;
      updateTask(t, x => {
        const k = subIndex(x, Number(i), text);
        return k === -1 ? {} : { subtasks: x.subtasks.filter((s, j) => j !== k) };
      });
    });
    const addSub = tid => {
      const input = $(`[data-newsub="${tid}"]`, root); const title = input.value.trim(); if (!title) return;
      input.value = '';
      const t = findTask(tid);
      updateTask(t, x => ({ subtasks: x.subtasks.concat({ t: title, done: false }) }));
      const again = $(`[data-newsub="${tid}"]`); if (again) again.focus();
    };
    $$('[data-addsub]', root).forEach(b => b.onclick = () => addSub(b.dataset.addsub));
    $$('[data-newsub]', root).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addSub(i.dataset.newsub); } });
    $$('[data-asg]', root).forEach(c => c.onchange = () => {
      const [tid, pid] = pair(c.dataset.asg); const t = findTask(tid); const on = c.checked;
      updateTask(t, x => ({ assigneeIds: on ? addId(x.assigneeIds, pid) : x.assigneeIds.filter(y => y !== pid) }));
    });
    $$('[data-ext]', root).forEach(c => c.onchange = () => {
      const [tid, cid] = pair(c.dataset.ext); const t = findTask(tid); const on = c.checked;
      updateTask(t, x => ({ contactIds: on ? addId(x.contactIds, cid) : x.contactIds.filter(y => y !== cid) }));
    });
    const addExt = async tid => {
      const input = $(`[data-newext="${tid}"]`, root); const name = input.value.trim(); if (!name) return;
      const c = await guard(() => Api.addContact(name));
      if (!c) return;
      input.value = '';
      const t = findTask(tid);
      if (t.contactIds.indexOf(c.id) === -1) updateTask(t, x => ({ contactIds: addId(x.contactIds, c.id) })); else render();
      toast(c.name + ' added — everyone can now pick them');
    };
    $$('[data-addext]', root).forEach(b => b.onclick = () => addExt(b.dataset.addext));
    $$('[data-newext]', root).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addExt(i.dataset.newext); } });
    $$('[data-block]', root).forEach(b => b.onclick = () => {
      const t = findTask(b.dataset.block);
      updateTask(t, { status: isBlocked(t) ? 'To Do' : 'Blocked' });
      const n = $(`[data-blocknote="${t.id}"]`); if (n) n.focus();
    });
    // The title saves like the note below: shortly after typing stops, and when leaving the box.
    // An empty title is not saved (the old one comes back when you leave the box).
    $$('[data-title]', root).forEach(i => {
      const id = i.dataset.title;
      i._saved = i.value.trim();
      const save = final => {
        clearTimeout(i._t);
        const v = i.value.replace(/\s+/g, ' ').trim();
        if (!v) { if (final) { const t = findTask(id); i.value = t ? t.title : i._saved; } return; }
        if (v === i._saved) return;
        i._saved = v;
        const t = findTask(id); if (t) t.title = v;
        S.lastWrite = Date.now();
        Api.patchTask(id, () => ({ title: v })).then(() => { if (final) softRender(); }, e => toast(e.message, true));
      };
      i.oninput = () => { clearTimeout(i._t); i._t = setTimeout(() => save(false), 700); };
      i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } };
      i.onchange = () => save(true);
      i.onblur = () => save(true);
    });
    // The note saves what is in the box (not a copy in memory), shortly after typing stops
    // and again when leaving the box, so a refresh arriving mid-typing can't lose it.
    $$('[data-blocknote]', root).forEach(i => {
      const id = i.dataset.blocknote;
      i._saved = i.value;
      const save = () => {
        clearTimeout(i._t);
        const v = i.value;
        if (v === i._saved) return;
        i._saved = v;
        S.lastWrite = Date.now();
        Api.patchTask(id, () => ({ blockNote: v })).catch(e => toast(e.message, true));
      };
      i.oninput = () => {
        const t = findTask(id); if (t) t.blockNote = i.value;
        clearTimeout(i._t); i._t = setTimeout(save, 600);
      };
      i.onchange = save;
    });
    $$('[data-move]', root).forEach(b => b.onclick = () => {
      const t = findTask(b.dataset.move);
      const to = t.week === NEXT ? THIS : NEXT;
      updateTask(t, { week: to });
      toast(to === NEXT ? 'Moved to next week' : 'Moved to this week');
    });
    $$('[data-del]', root).forEach(b => b.onclick = async () => {
      if (!confirm('Delete this task?')) return;
      S.lastWrite = Date.now();
      try { await Api.deleteTask(b.dataset.del); toast('Task deleted'); } catch (e) { toast(e.message, true); }
      if (S.sheetTask === b.dataset.del) S.sheetTask = null;
      render();
    });
  }

  function weekSwitch(countThis, countNext) {
    return `<div class="seg week-seg">
      <button type="button" data-which="this" class="${S.which === 'this' ? 'on' : ''}">This week <small>· ${wnum(THIS)} · ${countThis}</small></button>
      <button type="button" data-which="next" class="${S.which === 'next' ? 'on' : ''}">Next week <small>· ${wnum(NEXT)} · ${countNext}</small></button>
    </div>`;
  }
  const bindWeekSwitch = root => $$('[data-which]', root).forEach(b => b.onclick = () => { S.which = b.dataset.which; render(); });

  /** Weeks a task can go in: last, this and next week; admins 4 back to 8 ahead. */
  function weekChoices(selected) {
    const out = [];
    const [from, to] = managesHere() ? [-4, 8] : [-1, 1];
    const names = { '-1': 'last week', 0: 'this week', 1: 'next week' };
    for (let n = from; n <= to; n++) {
      const w = shiftWeek(THIS, n);
      out.push(`<option value="${w}"${w === selected ? ' selected' : ''}>Week ${wnum(w)} · ${names[n] || esc(weekRange(w))}</option>`);
    }
    return out.join('');
  }
  /** Admins only: who the task is for (default: themselves). */
  function personChoices(people) {
    const list = people.filter(m => m.active !== false && m.id !== me().id).sort((a, b) => a.name.localeCompare(b.name));
    return `<option value="${esc(me().id)}">For: me</option>` + list.map(m => `<option value="${esc(m.id)}">For: ${esc(m.name)}</option>`).join('');
  }
  /** Project picker: my projects first, then every other open project of the department (anyone can add to any project). */
  function projectChoices() {
    const open = p => CLOSED.indexOf(p.status) === -1 && inDept(p);
    const mine = myProjects().filter(open);
    const others = S.data.projects.filter(p => open(p) && mine.indexOf(p) === -1).sort((a, b) => a.name.localeCompare(b.name));
    const opt = p => `<option value="${esc(p.id)}"${p.id === S.lastProject ? ' selected' : ''}>${esc(p.name)}</option>`;
    return (mine.length ? `<optgroup label="My projects">${mine.map(opt).join('')}</optgroup>` : '') +
      (others.length ? `<optgroup label="${mine.length ? 'Other projects' : 'Projects'}">${others.map(opt).join('')}</optgroup>` : '');
  }
  /** `fixedProject`: add straight into that project. `week`: the week picked by default. */
  function addBar(fixedProject, people, week) {
    week = S.addWeek || week || (S.which === 'next' ? NEXT : THIS);
    if (week < shiftWeek(THIS, managesHere() ? -4 : -1) || week > shiftWeek(THIS, managesHere() ? 8 : 1)) week = THIS;
    return `
      <form class="card addbar${S.addWeek || fixedProject ? ' expanded' : ''}" id="addForm">
        <input name="title" data-keep="add-title" placeholder="${week === NEXT ? 'What will you do next week?' : week < THIS ? 'What did you do that week?' : 'What are you working on this week?'}" autocomplete="off" required>
        <div class="addbar-row">
          ${fixedProject ? '' : `<select name="project" aria-label="Project">${projectChoices()}</select>`}
          <select name="week" aria-label="Week">${weekChoices(week)}</select>
          <button type="submit" class="primary small">${icon('plus')} Add</button>
        </div>
        ${managesHere() ? `<div class="addbar-row admin-row"><select name="person" aria-label="For">${personChoices(people || S.data.team)}</select></div>` : ''}
      </form>`;
  }
  function bindAddBar(root, fixedProject) {
    const f = $('#addForm', root);
    if (!f) return;
    f.elements.title.addEventListener('focus', () => f.classList.add('expanded'));
    f.onsubmit = async e => {
      e.preventDefault();
      const title = f.elements.title.value.trim();
      const pid = fixedProject || f.elements.project.value;
      if (!title || !pid) return;
      if (title.split(/\s+/).length < 3 && f.dataset.nudged !== title) {
        f.dataset.nudged = title;
        toast('Add a bit more detail so the meeting understands it, or tap Add again to keep it.');
        f.elements.title.focus();
        return;
      }
      S.lastProject = pid;
      const forId = f.elements.person ? f.elements.person.value : me().id;
      const week = f.elements.week.value;
      const btn = $('button[type=submit]', f); btn.disabled = true;
      S.lastWrite = Date.now();
      const saved = await guard(() => Api.addTask({ projectId: pid, week: week, title: title, status: 'To Do',
        team: member(forId).team || '', assigneeIds: [forId], contactIds: [], subtasks: [],
        createdBy: forId === me().id ? undefined : forId }));
      btn.disabled = false;
      if (saved) {
        f.elements.title.value = '';
        const onBoard = currentTab().id === 'projects' && !S.project;
        const shown = forId === me().id && (onBoard ? week === S.mtgWeek || week === shiftWeek(S.mtgWeek, 1) || (week < S.mtgWeek && S.mtgWeek === THIS) : week === (S.which === 'next' ? NEXT : THIS));
        S.addWeek = null;
        if (!shown) toast('Added for ' + (forId === me().id ? 'you' : shortName(member(forId).name)) + ' · week ' + wnum(week));
        render(); const i = $('#addForm input'); if (i) i.focus();
      }
    };
  }

  // ---------- My tasks ----------

  /** Small per-device memory (e.g. a dismissed nudge). Never required: storage may be blocked. */
  const remember = {
    get(k) { try { return localStorage.getItem('acs-' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('acs-' + k, v); } catch (e) { /* blocked */ } },
  };

  /** From Thursday, nudge people who have nothing planned for next week yet. */
  function planNudge() {
    const day = new Date().getDay();   // 0 = Sunday
    const lateInWeek = day === 0 || day >= 4;
    const mine = S.data.tasks.filter(isMine);
    const onOpen = myProjects().some(p => CLOSED.indexOf(p.status) === -1);
    if (!lateInWeek || !onOpen || S.mtgWeek !== THIS) return '';
    if (mine.some(t => t.week === NEXT) || remember.get('plan-dismissed') === NEXT) return '';
    return `<div class="nudge" id="planNudge"><span><strong>Plan next week</strong><br>Nothing planned for week ${wnum(NEXT)} yet. It goes straight into next week’s meeting.</span>
      <span class="nudge-actions"><button type="button" class="primary small" id="planNext">Plan week ${wnum(NEXT)}</button><button type="button" class="text-btn" id="planLater">Later</button></span></div>`;
  }
  function bindPlanNudge(root) {
    const plan = $('#planNext', root);
    if (plan) plan.onclick = () => { S.addWeek = NEXT; S.addFor = null; render(); const i = $('#addForm input'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } };
    const later = $('#planLater', root);
    if (later) later.onclick = () => { remember.set('plan-dismissed', NEXT); render(); };
  }

  // ---------- Projects ----------

  function viewProjects(root) {
    if (S.project) return viewProject(root, project(S.project));
    return viewBoard(root);
  }

  function viewProject(root, p) {
    const cur = S.data.tasks.filter(t => t.projectId === p.id && inView(t, S.which));
    const byPerson = {};   // a task shared by two people shows under both
    cur.forEach(t => ownersOf(t).forEach(id => { (byPerson[id] = byPerson[id] || []).push(t); }));
    const onIt = myProjectIds().indexOf(p.id) !== -1;
    const order = Object.keys(byPerson).sort((a, b) => (a === me().id ? -1 : b === me().id ? 1 : member(a).name.localeCompare(member(b).name)));
    root.innerHTML = `
      <button type="button" class="back" id="backBtn">${icon('left')} Projects</button>
      <div class="page-head"><h2>${esc(p.name)}</h2>${onIt ? '<button type="button" class="ghost small-btn" id="leaveBtn">Leave</button>' : '<button type="button" class="primary small" id="joinBtn">Join</button>'}</div>
      <p class="muted small" style="margin:-8px 0 12px">${manyDepts() ? esc(dept(p.departmentId).name) + ' · ' : ''}${esc(p.type)} · ${esc(p.status)} · ${projectTeam(p.id).map(m => esc(shortName(m.name))).join(', ') || 'nobody yet'}</p>
      ${weekSwitch(S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length, S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'next')).length)}
      ${canManage(p.departmentId) ? teamEditor(p) : ''}
      ${CLOSED.indexOf(p.status) === -1 ? addBar(p.id, projectTeam(p.id).concat(S.data.team.filter(m => projectTeam(p.id).indexOf(m) === -1))) : ''}
      ${order.map(id => `<section class="card"><h3 class="card-title"><span class="avatar sm">${esc(initials(member(id).name))}</span>${esc(member(id).name)}${member(id).team ? ` <span class="badge">${esc(member(id).team)}</span>` : ''}</h3>
        ${byPerson[id].sort((a, b) => isDone(a) - isDone(b)).map(t => taskHtml(t, true)).join('')}</section>`).join('')
        || `<div class="empty"><h3>No tasks ${S.which === 'next' ? 'planned for next week' : 'this week'}</h3></div>`}`;
    $('#backBtn', root).onclick = () => { S.project = null; render(); };
    const leave = $('#leaveBtn', root);
    if (leave) leave.onclick = async () => {
      if (!confirm('Leave ' + p.name + '? Your tasks stay on the project.')) return;
      S.lastWrite = Date.now();
      await guard(() => Api.leaveProject(p.id)); S.project = null; render();
    };
    const join = $('#joinBtn', root);
    if (join) join.onclick = async () => { S.lastWrite = Date.now(); await guard(() => Api.joinProject(p.id)); render(); };
    bindWeekSwitch(root); bindAddBar(root, p.id); bindTasks(root); bindTeamEditor(root, p);
  }

  /** Admins: who is on the project. Tap × to take someone off, or pick a person to add. */
  function teamEditor(p) {
    const team = projectTeam(p.id);
    const others = S.data.team.filter(m => m.active && team.indexOf(m) === -1).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="card team-edit"><strong class="small">Team</strong>
      <div class="avatars-row">${team.map(m => `<span class="person-chip">${esc(shortName(m.name))}<button type="button" class="chip-x" data-unassign="${esc(m.id)}" aria-label="Take ${esc(m.name)} off the project">×</button></span>`).join('') || '<span class="muted small">Nobody yet</span>'}</div>
      ${others.length ? `<select id="assignSel" aria-label="Add a person to the project"><option value="">+ Add a person…</option>${others.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${m.team ? ' · ' + esc(m.team) : ''}</option>`).join('')}</select>` : ''}</div>`;
  }
  function bindTeamEditor(root, p) {
    const sel = $('#assignSel', root);
    if (sel) sel.onchange = async () => {
      const id = sel.value; if (!id) return;
      S.lastWrite = Date.now();
      if (await guard(() => Api.joinProject(p.id, id).then(() => true))) toast(shortName(member(id).name) + ' added to ' + p.name);
      render();
    };
    $$('[data-unassign]', root).forEach(b => b.onclick = async () => {
      const id = b.dataset.unassign;
      if (!confirm('Take ' + member(id).name + ' off ' + p.name + '? Their tasks stay on the project.')) return;
      S.lastWrite = Date.now();
      await guard(() => Api.leaveProject(p.id, id)); render();
    });
  }

  // ---------- Meeting (written by the tasks) ----------

  /**
   * The week's minutes as plain data (no links to live tasks), so the same object can be
   * shown on screen, copied as an email, and saved as a permanent copy.
   */
  function buildMinutes(week) {
    const isCurrent = week === THIS;
    const nextOf = shiftWeek(week, 1);
    const open = t => t.week === week || (isCurrent && t.week < week);
    const itemOf = (t, kind) => ({
      id: t.id, title: t.title, who: who(t) || member(t.createdBy).name, kind: kind, week: t.week,
      blocked: isBlocked(t), note: t.blockNote || '',
      subDone: t.subtasks.filter(x => x.done).length, subTotal: t.subtasks.length,
    });
    const rows = [];
    const summary = { moved: 0, done: 0, delayed: 0, blocked: 0 };
    const teams = deptTeams(curDept());
    deptProjects().forEach(p => {
      const ts = S.data.tasks.filter(t => t.projectId === p.id);
      const pick = {
        doing: ts.filter(t => !isDone(t) && open(t)),
        done: ts.filter(t => isDone(t) && t.week === week),
        next: ts.filter(t => t.week === nextOf),
      };
      if (!pick.doing.length && !pick.done.length && !pick.next.length) return;
      const cols = {};
      teams.forEach(k => { cols[k] = { done: [], doing: [], next: [] }; });
      const people = {};
      ['doing', 'done', 'next'].forEach(kind => pick[kind].forEach(t => {
        const it = itemOf(t, kind);
        teamsOf(t).forEach(team => cols[team][kind].push(it));
        ownersOf(t).forEach(id => {
          const m = member(id);
          (people[id] = people[id] || { id: id, name: m.name, team: m.team || '', items: [] }).items.push(it);
        });
      }));
      summary.done += pick.done.length;
      summary.delayed += pick.doing.filter(t => t.week < week).length;
      if (pick.doing.length + pick.done.length) summary.moved++;
      rows.push({
        id: p.id, name: p.name, type: p.type, status: p.status, cols: cols,
        people: Object.keys(people).map(k => people[k]).sort((x, y) => x.name.localeCompare(y.name)),
      });
    });
    const blocked = S.data.tasks.filter(t => isBlocked(t) && open(t) && inDept(project(t.projectId)))
      .map(t => Object.assign(itemOf(t, 'doing'), { project: project(t.projectId).name }));
    summary.blocked = blocked.length;
    return { v: 1, week: week, dept: curDept(), deptName: dept(curDept()).name, teams: teams, rows: rows, blocked: blocked, summary: summary };
  }

  /**
   * Active people on an open project with no task activity in the week: none of their tasks
   * (created by or assigned to them) was saved that week, and nothing is planned for it.
   */
  function quietPeople(week) {
    const openIds = deptProjects().filter(p => CLOSED.indexOf(p.status) === -1).map(p => p.id);
    const onOpenProject = id => S.data.assignments.some(a => a.userId === id && openIds.indexOf(a.projectId) !== -1);
    const active = new Set();
    S.data.tasks.forEach(t => {
      const savedThatWeek = t.version && isoWeek(new Date(t.version)) === week;
      if (!savedThatWeek && t.week !== week) return;
      active.add(t.createdBy);
      t.assigneeIds.forEach(id => active.add(id));
    });
    return S.data.team.filter(m => m.active && onOpenProject(m.id) && !active.has(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg);
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => toast('Copy failed', true));
    else toast('Copy failed', true);
  }

  /** Every week with saved minutes, newest first; tap one to open it. */
  async function minutesArchive() {
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="sheet"><header class="sheet-head"><span></span><h3>Saved minutes${manyDepts() ? ' · ' + esc(dept(curDept()).name) : ''}</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
      <div class="sheet-body" id="archiveBody"><div class="skeleton"></div></div></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.showModal();
    const list = await guard(() => Api.minutesList(curDept()));
    const body = $('#archiveBody', dlg);
    if (!list || !body) return;
    list.sort((a, b) => b.week.localeCompare(a.week));
    body.innerHTML = list.length ? `<div class="archive">${list.map(r => `
      <button type="button" class="archive-row${r.week === S.mtgWeek ? ' on' : ''}" data-week="${esc(r.week)}">
        <span><strong>Week ${wnum(r.week)}</strong> · ${esc(weekRange(r.week))} ${weekMonday(r.week).getUTCFullYear()}<br>
        <span class="muted small">Saved ${esc(r.savedAt)}${r.savedBy ? ' by ' + esc(member(r.savedBy).name) : ''}</span></span>${icon('chevron')}</button>`).join('')}</div>`
      : '<div class="empty"><h3>No saved minutes yet</h3><p>An admin can save them from the Projects tab after each meeting.</p></div>';
    $$('[data-week]', body).forEach(b => b.onclick = () => {
      S.mtgWeek = b.dataset.week; S.mtgEdit = {}; S.project = null; dlg.close(); location.hash = '#/'; render(); window.scrollTo(0, 0);
    });
  }

  /** Loads the saved minutes for a week once, then redraws. */
  function loadMinutes(week) {
    const d = curDept(), key = mkey(week);
    S.minutes[key] = undefined;
    Api.minutes(week, d).then(rec => { S.minutes[key] = rec; }, () => { S.minutes[key] = null; })
      .then(() => { if (currentTab().id === 'projects' && !S.project && S.mtgWeek === week && curDept() === d) softRender(); });
  }

  const VIEWS = [['me', 'My tasks'], ['mine', 'My projects'], ['all', 'All projects'], ['people', 'By person']];
  function boardMode() {
    if (!S.board) S.board = remember.get('board') || 'mine';
    if (S.board === 'people' && !canManage(curDept())) S.board = 'mine';
    if (S.board === 'mine' && !deptProjects().some(p => myProjectIds().indexOf(p.id) !== -1)) return 'all';   // nothing to show under "My projects" yet
    return S.board;
  }
  function collapsed() {
    if (!S.collapsed) { try { S.collapsed = JSON.parse(remember.get('collapsed') || '{}'); } catch (e) { S.collapsed = {}; } }
    return S.collapsed;
  }
  function setCollapsed(keys, on) {
    const c = collapsed();
    keys.forEach(k => { if (on) c[k] = true; else delete c[k]; });
    remember.set('collapsed', JSON.stringify(c));
  }
  /**
   * Who is on the project, as name tags: everyone who joined, then (dashed) anyone with a task
   * on it this week or next who hasn't joined. Your own tag is marked "You".
   */
  function teamTags(pid, r) {
    const team = projectTeam(pid).filter(m => m.active !== false).sort((a, b) => (b.id === me().id) - (a.id === me().id) || a.name.localeCompare(b.name));
    const helping = (r ? r.people : []).filter(pp => pp.id && !team.some(m => m.id === pp.id)).map(pp => member(pp.id));
    const tag = (m, extra) => `<span class="name-tag${m.id === me().id ? ' me' : ''}${extra ? ' helping' : ''}${m.team ? ' team-' + slug(m.team) : ''}" title="${esc(m.name)}${m.team ? ' · ' + esc(m.team) + ' team' : ''}${extra ? ' · has tasks here, not on the project' : ''}">
      <span class="avatar xs">${esc(initials(m.name))}</span>${esc(m.name)}${m.id === me().id ? ' <small>(You)</small>' : ''}</span>`;
    if (!team.length && !helping.length) return '<p class="team-line muted">Nobody on this project yet</p>';
    return `<div class="name-tags" aria-label="People on this project">${team.map(m => tag(m)).join('')}${helping.map(m => tag(m, true)).join('')}</div>`;
  }
  const chevron = (key, label) => `<button type="button" class="icon-btn fold" data-fold="${esc(key)}" aria-expanded="${!collapsed()[key]}" aria-label="${collapsed()[key] ? 'Expand' : 'Collapse'} ${esc(label)}">${icon(collapsed()[key] ? 'chevron' : 'down')}</button>`;

  /**
   * The two weeks side by side for one project (or one person on it). Live: the real task rows,
   * so tasks can be ticked and edited right here. Saved minutes: plain text, exactly as saved.
   */
  function weekGrid(r, week, live, onlyId) {
    const subs = it => it.subTotal ? ` <em>(${it.subDone}/${it.subTotal})</em>` : '';
    const blockText = it => it.blocked ? ` — blocked: ${esc(it.note || 'no reason given')}` : '';
    const mark = it => it.kind === 'done' ? '✔' : it.kind === 'next' ? '→' : it.blocked ? '⛔' : '•';
    const text = it => `<li class="${it.blocked ? 'blk' : ''}"><span class="mk">${mark(it)}</span><span>${esc(it.title)}${it.kind === 'doing' && it.week < week ? ` <span class="tag-carry">from week ${wnum(it.week)}</span>` : ''}${blockText(it)}${subs(it)}</span></li>`;
    // A task shared by two people is editable once (under the first); elsewhere it is a plain line.
    const drawn = {};
    const row = it => {
      const t = live && it.id && !drawn[it.id] && findTask(it.id);
      if (t) { drawn[it.id] = true; return taskHtml(t, true); }
      return `<ul>${text(it)}</ul>`;
    };
    const people = r.people.filter(pp => !onlyId || pp.id === onlyId);
    const column = isNext => {
      const inCol = it => (it.kind === 'next') === isNext;
      const blocks = people.filter(pp => pp.items.some(inCol)).map(pp => `<div class="mtg-person">
        ${onlyId ? '' : `<strong><span class="avatar sm">${esc(initials(pp.name))}</span>${esc(pp.name)}${pp.team ? ` <span class="badge">${esc(pp.team)}</span>` : ''}</strong>`}
        ${pp.items.filter(inCol).map(row).join('')}</div>`);
      const w = isNext ? shiftWeek(week, 1) : week;
      return `<div class="wk-col${isNext ? ' next' : ''}"><h4>Week ${wnum(w)} <span>${isNext ? 'plan' : 'done & in progress'}</span></h4>
        ${blocks.join('') || `<p class="muted small">${isNext ? 'Nothing planned yet' : 'Nothing this week'}</p>`}</div>`;
    };
    const tabs = `<div class="wk-tabs" aria-hidden="true"><button type="button" class="on">Week ${wnum(week)}</button><button type="button">Week ${wnum(shiftWeek(week, 1))} · plan</button></div>`;
    return `${tabs}<div class="wk2">${column(false)}${column(true)}</div>`;
  }

  /** One card per project (My tasks / My projects / All projects views). */
  function projectCards(rows, week, live, mode) {
    const byId = {}; rows.forEach(r => { if (r.id) byId[r.id] = r; });
    const mineIds = myProjectIds();
    const mineHas = r => r && r.people.some(pp => pp.id === me().id);
    let list;
    // Saved minutes: find each project again by id, or by name for minutes saved before ids were kept.
    const savedProject = r => S.data.projects.find(x => x.id === r.id) || S.data.projects.find(x => x.name === r.name);
    if (!live) list = rows.map(r => ({ r: r, p: savedProject(r) || { id: r.id || r.name, name: r.name, type: r.type, status: r.status } }));
    else {
      const shown = p => mode === 'me' ? mineHas(byId[p.id]) : mode === 'mine' ? mineIds.indexOf(p.id) !== -1 : (CLOSED.indexOf(p.status) === -1 || byId[p.id]);
      list = deptProjects().filter(shown).sort((a, b) =>
        (mineIds.indexOf(b.id) !== -1) - (mineIds.indexOf(a.id) !== -1) || !!byId[b.id] - !!byId[a.id] || a.name.localeCompare(b.name))
        .map(p => ({ r: byId[p.id], p: p }));
    }
    const card = ({ r, p }) => {
      const key = 'p:' + p.id;
      const exists = project(p.id).id === p.id;   // saved minutes may name a project that was removed since
      const isReal = live && exists;
      const on = mineIds.indexOf(p.id) !== -1;
      const open = CLOSED.indexOf(p.status) === -1;
      return `<section class="card board-card${collapsed()[key] ? ' folded' : ''}">
        <div class="board-head">
          ${chevron(key, p.name)}
          <div class="board-name">
            ${isReal ? `<button type="button" class="board-title" data-project="${esc(p.id)}">` : '<span class="board-title">'}<strong>${esc(p.name)}</strong> <span class="badge ${typeClass(p.type)}">${esc(p.type)}</span><span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>${isReal ? '</button>' : '</span>'}
          </div>
          ${isReal ? `<span class="board-actions no-print">${on ? '' : `<button type="button" class="ghost small-btn" data-join="${esc(p.id)}">Join</button>`}${open ? `<button type="button" class="secondary small-btn" data-addto="${esc(p.id)}">${icon('plus')} Task</button>` : ''}</span>` : ''}
        </div>
        ${exists ? teamTags(p.id, r) : ''}
        <div class="board-body">
          ${live && S.addFor === p.id ? `<div class="no-print">${addBar(p.id, projectTeam(p.id).concat(S.data.team.filter(m => projectTeam(p.id).indexOf(m) === -1)), week)}</div>` : ''}
          ${r ? weekGrid(r, week, live, mode === 'me' ? me().id : null) : `<p class="muted small" style="margin:8px 0 0">No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))}.</p>`}
        </div>
      </section>`;
    };
    const empty = mode === 'me'
      ? `<div class="empty"><h3>No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))} yet</h3><p>Add one above, on any project.</p></div>`
      : '<div class="empty"><h3>No projects to show</h3></div>';
    return { html: list.map(card).join('') || empty, keys: list.map(x => 'p:' + x.p.id) };
  }

  /** Admins: one card per person in the department (or with tasks in it), their tasks grouped by project. */
  function personCards(rows, week, live) {
    const people = S.data.team.filter(m => m.active && (m.departmentId === curDept() || rows.some(r => r.people.some(pp => pp.id === m.id)))).sort((a, b) => (a.team || 'z').localeCompare(b.team || 'z') || a.name.localeCompare(b.name));
    const html = people.map(m => {
      const key = 'u:' + m.id;
      const mine = rows.filter(r => r.people.some(pp => pp.id === m.id));
      const count = mine.reduce((n, r) => n + r.people.find(pp => pp.id === m.id).items.length, 0);
      return `<section class="card board-card${collapsed()[key] ? ' folded' : ''}">
        <div class="board-head">${chevron(key, m.name)}
          <div class="board-name"><span class="board-title"><span class="avatar sm">${esc(initials(m.name))}</span><strong>${esc(m.name)}</strong>${m.team ? ` <span class="badge">${esc(m.team)}</span>` : ''}</span>
          <p class="team-line muted">${count} ${count === 1 ? 'task' : 'tasks'} · ${mine.length} ${mine.length === 1 ? 'project' : 'projects'}</p></div></div>
        <div class="board-body">${mine.map(r => `<h4 class="person-project">${esc(r.name)}</h4>${weekGrid(r, week, live, m.id)}`).join('') || `<p class="muted small" style="margin:8px 0 0">No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))}.</p>`}</div>
      </section>`;
    }).join('');
    return { html: html, keys: people.map(m => 'u:' + m.id) };
  }

  function bindBoard(root, keys) {
    $$('[data-board]', root).forEach(b => b.onclick = () => { S.board = b.dataset.board; remember.set('board', S.board); S.addFor = null; render(); });
    $$('[data-fold]', root).forEach(b => b.onclick = () => { setCollapsed([b.dataset.fold], !collapsed()[b.dataset.fold]); render(); });
    const fold = $('#foldAll', root); if (fold) fold.onclick = () => { setCollapsed(keys, true); render(); };
    const unfold = $('#unfoldAll', root); if (unfold) unfold.onclick = () => { setCollapsed(keys, false); render(); };
    $$('[data-project]', root).forEach(b => b.onclick = () => { S.project = b.dataset.project; S.which = S.mtgWeek > THIS ? 'next' : 'this'; render(); window.scrollTo(0, 0); });
    $$('[data-addto]', root).forEach(b => b.onclick = () => {
      S.addFor = S.addFor === b.dataset.addto ? null : b.dataset.addto;
      if (S.addFor) setCollapsed(['p:' + S.addFor], false);
      render();
      const i = $('#addForm input', root); if (i) i.focus();
    });
    $$('[data-join]', root).forEach(b => b.onclick = async () => {
      b.disabled = true; S.lastWrite = Date.now();
      if (await guard(() => Api.joinProject(b.dataset.join).then(() => true))) toast('You joined ' + project(b.dataset.join).name);
      render();
    });
    bindAddBar(root, S.addFor || undefined);
    bindTasks(root);
    bindPlanNudge(root);
  }

  function viewBoard(root) {
    const week = S.mtgWeek;
    const key = mkey(week);
    if (!(key in S.minutes)) loadMinutes(week);
    const saved = S.minutes[key];
    const hasSaved = !!(saved && saved.snapshot);
    const live = !hasSaved || !!S.mtgEdit[key];
    const manager = canManage(curDept());
    const m = live ? buildMinutes(week) : saved.snapshot;
    const { rows, blocked, summary } = m;
    const mode = live ? boardMode() : 'all';
    // Admins, live view of this week or an earlier one: who hasn't touched their tasks.
    const quiet = manager && live && week <= THIS ? quietPeople(week) : [];
    const quietCard = quiet.length ? `<section class="card quiet foldable${S.fold.quiet ? ' shut' : ''}"><h3 class="card-title" data-extra="quiet">No update ${week === THIS ? 'yet' : ''} (${quiet.length})</h3>
      <p class="muted small" style="margin:0 0 8px">On an open project, but none of their tasks was added or changed in week ${wnum(week)}.</p>
      <div class="avatars-row">${quiet.map(m => `<span class="person-chip"><span class="avatar sm">${esc(initials(m.name))}</span>${esc(m.name)}${m.team ? ` <small class="muted">${esc(m.team)}</small>` : ''}</span>`).join('')}</div>
      ${week === THIS ? '<button type="button" class="secondary small-btn" id="copyReminder">Copy reminder</button>' : ''}</section>` : '';
    const savedBy = hasSaved ? `${esc(saved.savedAt)}${saved.savedBy ? ' by ' + esc(member(saved.savedBy).name) : ''}` : '';
    const note = !live
      ? `<div class="mtg-note saved"><span>Saved minutes · ${savedBy}</span><button type="button" class="secondary small-btn" id="mtgEdit">Edit</button></div>`
      : hasSaved ? `<div class="mtg-note editing"><span><strong>Edit mode.</strong> Changes save to the tasks straight away.${manager ? ' Tap <b>Save minutes</b> to update the saved copy.' : ''}</span><button type="button" class="ghost small-btn" id="mtgCancel">Cancel edit</button></div>`
      : week < THIS && saved === null ? '<div class="mtg-note warn"><span>Not saved. This is rebuilt from today’s tasks, so it may differ from what was discussed.</span></div>' : '';
    const cards = mode === 'people' ? personCards(rows, week, live) : projectCards(rows, week, live, mode);
    const views = VIEWS.filter(v => v[0] !== 'people' || manager);
    const deptSwitch = manyDepts() ? `<div class="seg dept-seg no-print" aria-label="Department">${departments().map(d =>
      `<button type="button" data-dept="${esc(d.id)}" class="${d.id === curDept() ? 'on' : ''}">${esc(d.name)}${d.id === me().departmentId ? ' <small>· mine</small>' : ''}</button>`).join('')}</div>` : '';
    root.innerHTML = `
      ${deptSwitch}
      <div class="weekbar">
        <button type="button" class="icon-btn" data-mw="-1" aria-label="Previous week">${icon('left')}</button>
        <div class="weekbar-label"><strong>Week ${wnum(week)}${week === THIS ? ' · this week' : ''}</strong><span>${manyDepts() ? esc(dept(curDept()).name) + ' · ' : ''}${esc(weekRange(week))} · next to week ${wnum(shiftWeek(week, 1))}</span></div>
        <button type="button" class="icon-btn" data-mw="1" aria-label="Next week"${week >= shiftWeek(THIS, 8) ? ' disabled' : ''}>${icon('chevron')}</button>
      </div>
      <div class="actions-row"><button type="button" class="primary" id="copyEmail">Copy as email</button><button type="button" class="secondary" id="printMom">Print / PDF</button>${manager && live && week <= THIS ? `<button type="button" class="secondary" id="saveMins">Save minutes</button>` : ''}<button type="button" class="ghost" id="archiveBtn">Past minutes</button></div>
      ${note}
      ${live ? planNudge() : ''}
      ${live && !S.addFor && deptProjects().some(p => CLOSED.indexOf(p.status) === -1) ? addBar(undefined, undefined, week <= THIS ? THIS : week) : ''}
      ${quietCard}
      ${rows.length ? `<div class="mtg-sum"><span><b>${summary.moved}</b> ${summary.moved === 1 ? 'project' : 'projects'} with progress</span><span><b>${summary.done}</b> done</span><span class="${summary.blocked ? 'bad' : ''}"><b>${summary.blocked}</b> blocked</span><span class="${summary.delayed ? 'warn' : ''}"><b>${summary.delayed}</b> delayed</span></div>` : ''}
      ${blocked.length ? `<section class="card warn foldable${S.fold.blocked ? ' shut' : ''}"><h3 class="card-title" data-extra="blocked">Blocked (${blocked.length})</h3><ul class="plain">${blocked.map(it => `<li><span><strong>${esc(it.title)}</strong><br><span class="muted">${esc(it.project)} · ${esc(it.who)} — ${esc(it.note || 'no reason given')}</span></span></li>`).join('')}</ul></section>` : ''}
      <div class="board-tools no-print">
        ${live ? `<div class="seg board-seg">${views.map(v => `<button type="button" data-board="${v[0]}" class="${mode === v[0] ? 'on' : ''}">${v[1]}</button>`).join('')}</div>` : ''}
        <span class="fold-all"><button type="button" class="text-btn" id="unfoldAll">Expand all</button><button type="button" class="text-btn" id="foldAll">Collapse all</button></span>
      </div>
      ${cards.html}`;
    $$('[data-dept]', root).forEach(b => b.onclick = () => { S.dept = b.dataset.dept; S.addFor = null; S.addWeek = null; render(); });
    $$('[data-mw]', root).forEach(b => b.onclick = () => { S.mtgWeek = shiftWeek(S.mtgWeek, Number(b.dataset.mw)); S.addFor = null; S.addWeek = null; render(); });
    // Phone: the Blocked and No-update lists fold to one line (tap the title)
    $$('[data-extra]', root).forEach(h => h.onclick = () => { if (!isPhone()) return; S.fold[h.dataset.extra] = !S.fold[h.dataset.extra]; render(); });
    // Phone: tabs above each project's two weeks jump between them; the tab follows a swipe
    $$('.wk2', root).forEach(g => {
      const tabs = g.previousElementSibling && g.previousElementSibling.classList.contains('wk-tabs') ? $$('button', g.previousElementSibling) : [];
      if (!tabs.length) return;
      // Mark the week in view and fit the row to it, so a short week leaves no gap below.
      const mark = () => {
        const i = g.scrollLeft > g.scrollWidth / 4 ? 1 : 0;
        tabs.forEach((b, k) => b.classList.toggle('on', k === i));
        const col = g.children[i];
        if (col) g.style.height = col.offsetHeight + 'px';
      };
      tabs.forEach((b, k) => b.onclick = () => { g.scrollTo({ left: k ? g.scrollWidth : 0, behavior: 'smooth' }); });
      g.addEventListener('scroll', mark, { passive: true });
      mark();
    });
    $('#printMom', root).onclick = () => window.print();
    $('#copyEmail', root).onclick = () => copyEmail(m);
    $('#archiveBtn', root).onclick = minutesArchive;
    if (live) bindBoard(root, cards.keys);
    else {
      $$('[data-fold]', root).forEach(b => b.onclick = () => { setCollapsed([b.dataset.fold], !collapsed()[b.dataset.fold]); render(); });
      $('#foldAll', root).onclick = () => { setCollapsed(cards.keys, true); render(); };
      $('#unfoldAll', root).onclick = () => { setCollapsed(cards.keys, false); render(); };
    }
    const remind = $('#copyReminder', root);
    if (remind) remind.onclick = () => copyText(
      'Hi ' + quiet.map(x => x.name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0]).join(', ') +
      ' — please add your tasks for week ' + wnum(week) + ' in Weekly Tasks before the meeting: ' + location.origin + location.pathname,
      'Reminder copied — paste it into your team chat');
    const edit = $('#mtgEdit', root); if (edit) edit.onclick = () => { S.mtgEdit[key] = true; render(); };
    const cancel = $('#mtgCancel', root); if (cancel) cancel.onclick = () => { S.mtgEdit[key] = false; S.addFor = null; render(); };
    const save = $('#saveMins', root);
    if (save) save.onclick = async () => {
      if (hasSaved && !confirm('Replace the saved minutes for week ' + wnum(week) + ' with today’s tasks?')) return;
      save.disabled = true;
      const rec = await guard(() => Api.saveMinutes(week, buildMinutes(week), curDept()));
      save.disabled = false;
      if (rec) { S.minutes[key] = rec; S.mtgEdit[key] = false; toast('Minutes saved'); render(); }
    };
  }

  /** Same layout as the "Weekly Progress Check & Action Plan" email; inline styles so it pastes into Zoho / Outlook. */
  function copyEmail(m) {
    const week = m.week;
    const rows = m.rows;
    const teams = m.teams || ['PLC', 'Dev'];   // minutes saved before departments: PLC | Dev
    const title = 'Weekly Progress Check & Action Plan' + (manyDepts() && m.deptName ? ' — ' + m.deptName : '');
    const none = { done: [], doing: [], next: [] };
    const cell = 'border:1px solid #E7E3DE;padding:12px;text-align:left;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:13px;';
    const head = cell + 'background:#CB2150;color:#ffffff;font-size:14px;';
    const item = (it, prefix) => `<li style="margin-bottom:6px">${prefix}${esc(it.title)} "${esc(it.who)}"${it.blocked ? ' <b style="color:#CB2150">(blocked: ' + esc(it.note || 'no reason given') + ')</b>' : ''}</li>`;
    const list = c => {
      const items = c.done.map(it => item(it, '✔ ')).concat(c.doing.map(it => item(it, ''))).concat(c.next.map(it => item(it, 'Next week: ')));
      return '<ul style="margin:0;padding-left:18px">' + (items.length ? items.join('') : '<li>-</li>') + '</ul>';
    };
    const html = `<div style="max-width:1100px;font-family:Arial,Helvetica,sans-serif;color:#191919">
      <h2 style="text-align:center;margin:0 0 4px">${esc(title)}</h2>
      <p style="text-align:center;margin:0 0 18px;color:#6B6862;font-weight:bold">Week ${wnum(week)} · ${esc(weekRange(week))} ${weekMonday(week).getUTCFullYear()}</p>
      <table style="width:100%;border-collapse:collapse" width="100%">
        <thead><tr><th style="${head}">Project Name</th>${teams.map(k => `<th style="${head}">${esc(k)} Team Action Plan</th>`).join('')}<th style="${head}width:15%">Overall Status</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr style="background:${i % 2 ? '#F7F5F2' : '#ffffff'}"><td style="${cell}font-weight:bold;color:#CB2150">${esc(r.name)}</td>
          ${teams.map(k => `<td style="${cell}">${list(r.cols[k] || none)}</td>`).join('')}<td style="${cell}font-weight:bold">${esc(r.status)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const text = [title + ' — ' + weekLabel(week), ''].concat(rows.map(r => [r.name + ' — ' + r.status].concat(teams.map(k => {
      const c = r.cols[k] || none;
      const items = c.done.map(it => '✔ ' + it.title).concat(c.doing.map(it => it.title + (it.blocked ? ' (blocked: ' + (it.note || '-') + ')' : ''))).concat(c.next.map(it => 'Next week: ' + it.title));
      return '  ' + k + ' team: ' + (items.length ? items.map(x => '\n    - ' + x).join('') : '-');
    })).join('\n'))).join('\n\n');
    const ok = () => toast('Copied — paste it into a new email');
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
        .then(ok, () => navigator.clipboard.writeText(text).then(ok, () => toast('Copy failed', true)));
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(ok, () => toast('Copy failed', true));
    }
  }

  // ---------- Form sheet ----------

  /**
   * fields: [{ name, label, type: text|email|password|date|select|textarea|checkbox|checklist|chips, options, required }]
   * onSubmit(values) may throw; the sheet stays open and shows the error.
   */
  function openForm({ title, fields, values, onSubmit, submitLabel }) {
    const dlg = $('#dialog');
    values = values || {};
    const fieldHtml = fields.map(f => {
      const v = values[f.name];
      const req = f.required ? ' required' : '';
      const id = 'f-' + f.name;
      const wide = f.wide || ['textarea', 'checklist', 'chips', 'checkbox'].indexOf(f.type) !== -1 ? ' wide' : '';
      if (f.type === 'textarea') {
        return `<label class="field${wide}" for="${id}">${esc(f.label)}<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}"${req}>${esc(v)}</textarea></label>`;
      }
      if (f.type === 'select') {
        return `<label class="field${wide}" for="${id}">${esc(f.label)}<select id="${id}" name="${f.name}">${options(f.options, v)}</select></label>`;
      }
      if (f.type === 'chips') {
        return `<fieldset class="field${wide}"><legend>${esc(f.label)}</legend><div class="chips">${f.options.map(o =>
          `<label class="chip-opt"><input type="radio" name="${f.name}" value="${esc(o)}"${o === v ? ' checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`;
      }
      if (f.type === 'checkbox') {
        return `<label class="check${wide}"><input type="checkbox" name="${f.name}"${v !== false ? ' checked' : ''}> ${esc(f.label)}</label>`;
      }
      if (f.type === 'checklist') {
        const sel = v || [];
        const items = f.options.length ? f.options.map(o =>
          `<label class="check row"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"${sel.indexOf(o.value) !== -1 ? ' checked' : ''}>
            <span class="avatar sm">${esc(initials(o.label))}</span> ${esc(o.label)}</label>`
        ).join('') : '<p class="muted">Nobody on the team yet.</p>';
        return `<fieldset class="field${wide}"><legend>${esc(f.label)}</legend><div class="checklist">${items}</div></fieldset>`;
      }
      return `<label class="field${wide}" for="${id}">${esc(f.label)}<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}"${req}${f.readonly ? ' readonly' : ''}${f.type === 'password' ? ' autocomplete="new-password"' : ''}></label>`;
    }).join('');

    dlg.innerHTML = `
      <form method="dialog" class="sheet">
        <header class="sheet-head">
          <button type="button" class="text-btn" data-cancel>Cancel</button>
          <h3>${esc(title)}</h3>
          <button type="submit" class="text-btn strong">${esc(submitLabel || 'Save')}</button>
        </header>
        <div class="sheet-body">
          <p class="error" hidden></p>
          <div class="form-grid">${fieldHtml}</div>
        </div>
      </form>`;
    const form = $('form', dlg);
    $('[data-cancel]', dlg).addEventListener('click', () => dlg.close());
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const out = {};
      fields.forEach(f => {
        if (f.type === 'checkbox') out[f.name] = form.elements[f.name].checked;
        else if (f.type === 'checklist') out[f.name] = $$(`input[name="${f.name}"]:checked`, form).map(i => i.value);
        else if (f.type === 'chips') { const c = $(`input[name="${f.name}"]:checked`, form); out[f.name] = c ? c.value : ''; }
        else out[f.name] = form.elements[f.name].value.trim();
      });
      const btn = $('button[type=submit]', form);
      const err = $('.error', form);
      btn.disabled = true; err.hidden = true;
      try {
        await onSubmit(out);
        dlg.close();
      } catch (e) {
        err.textContent = e.message; err.hidden = false;
        $('.sheet-body', dlg).scrollTop = 0;
      } finally {
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  // ---------- Manage: projects & team (admins and department admins) ----------

  /** Manage (admins), opened from the settings button; a link leads back to the board. */
  function viewManage(root) {
    renderManage(root);
    root.insertAdjacentHTML('afterbegin', `<a href="#/" class="back">${icon('left')} Weekly board</a>`);
  }

  function renderManage(root) {
    const tab = S.manageTab;
    const addLabel = { projects: 'Project', team: 'Member', external: '3rd party' }[tab];
    const d = dept(manageDept());
    // Admins pick the department to manage; a department admin manages their own.
    const deptRow = !manyDepts() ? '' : isAdmin()
      ? `<div class="seg dept-seg" aria-label="Department">${departments().map(x =>
        `<button type="button" data-dept="${esc(x.id)}" class="${x.id === d.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>`
      : `<p class="muted small" style="margin:-8px 0 12px">${esc(d.name)} department</p>`;
    root.innerHTML = `
      <div class="page-head"><h2>Manage</h2>
        <button type="button" class="primary small" id="addBtn">${icon('plus')} ${addLabel}</button></div>
      ${tab === 'external' ? '' : deptRow}
      <div class="segmented">
        <button type="button" data-tab="projects" class="${tab === 'projects' ? 'on' : ''}">Projects</button>
        <button type="button" data-tab="team" class="${tab === 'team' ? 'on' : ''}">Team</button>
        <button type="button" data-tab="external" class="${tab === 'external' ? 'on' : ''}">3rd parties</button>
      </div>
      <div id="manageBody"></div>`;
    $$('[data-tab]', root).forEach(b => b.addEventListener('click', () => { S.manageTab = b.dataset.tab; render(); }));
    $$('[data-dept]', root).forEach(b => b.addEventListener('click', () => { S.dept = b.dataset.dept; render(); }));
    $('#addBtn', root).addEventListener('click', () => tab === 'projects'
      ? projectForm({ type: d.projectTypes[0] || 'Other', status: 'In Progress', priority: 'Medium', assigned: [], departmentId: d.id })
      : tab === 'team' ? memberForm({ role: 'Member', active: true, departmentId: d.id }) : contactForm({}));
    const body = $('#manageBody', root);
    if (tab === 'projects') renderProjects(body); else if (tab === 'team') renderTeam(body); else renderContacts(body);
  }

  /** 3rd parties: people without an account who can still be assigned tasks. */
  function renderContacts(root) {
    const count = id => S.data.tasks.filter(t => t.contactIds.indexOf(id) !== -1).length;
    root.innerHTML = `<p class="muted small" style="margin:0 0 10px">People outside the team (no login) who can be assigned tasks. Anyone can add one from a task; they then appear for everyone.</p>
      <div class="grid">${S.data.contacts.map(c => `
        <button type="button" class="card list-card member" data-edit="${esc(c.id)}">
          <span class="avatar ext">${esc(initials(c.name))}</span>
          <span class="member-info"><strong>${esc(c.name)}</strong><span class="muted">${esc(c.org || '3rd party')}</span></span>
          <span class="member-side"><small class="muted">${count(c.id)} task${count(c.id) === 1 ? '' : 's'}</small></span>
        </button>`).join('') || '<div class="empty"><h3>No 3rd parties yet</h3></div>'}</div>`;
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => contactForm(S.data.contacts.find(c => c.id === b.dataset.edit))));
  }

  function contactForm(values) {
    const isNew = !values.id;
    openForm({
      title: isNew ? 'New 3rd party' : 'Edit 3rd party',
      values: values,
      fields: [
        { name: 'name', label: 'Name (e.g. Eng. Moataz)', required: true, wide: true },
        { name: 'org', label: 'Company / role (optional)', wide: true },
      ],
      onSubmit: async v => {
        if (isNew) await Api.addContact(v.name, v.org); else await Api.saveContact(Object.assign({ id: values.id }, v));
        toast('Saved');
        render();
      },
    });
    if (!isNew) {
      const body = $('#dialog .sheet-body');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'ghost danger-text block'; del.textContent = 'Delete 3rd party';
      del.addEventListener('click', async () => {
        if (!confirm('Delete ' + values.name + '? They will be removed from all tasks.')) return;
        try { await Api.deleteContact(values.id); $('#dialog').close(); toast('Deleted'); render(); }
        catch (e) { toast(e.message, true); }
      });
      body.appendChild(del);
    }
  }

  function renderProjects(root) {
    const filters = ['Open'].concat(PROJECT_STATUSES).concat(['All']);
    const q = S.projectSearch.toLowerCase();
    const all = S.data.projects.filter(p => p.departmentId === manageDept());
    const list = all.filter(p =>
      (S.projectFilter === 'All' || (S.projectFilter === 'Open' ? CLOSED.indexOf(p.status) === -1 : p.status === S.projectFilter)) &&
      (!q || (p.name + ' ' + p.client + ' ' + p.id).toLowerCase().indexOf(q) !== -1));
    root.innerHTML = `
      <input type="search" class="search" id="projectSearch" placeholder="Search projects" value="${esc(S.projectSearch)}">
      <div class="chips scroll">${filters.map(f => {
        const n = f === 'All' ? all.length : f === 'Open' ? all.filter(p => CLOSED.indexOf(p.status) === -1).length : all.filter(p => p.status === f).length;
        return `<button type="button" class="chip${S.projectFilter === f ? ' on' : ''}" data-filter="${esc(f)}">${esc(f)} <small>${n}</small></button>`;
      }).join('')}</div>
      <div class="grid">${list.map(p => {
        const team = S.data.assignments.filter(a => a.projectId === p.id).map(a => member(a.userId));
        return `
          <button type="button" class="card list-card" data-edit="${esc(p.id)}">
            <span class="row-between"><strong>${esc(p.name)}</strong><span class="prio prio-${slug(p.priority)}" title="${esc(p.priority)} priority">${esc(p.priority)}</span></span>
            <span class="meta"><span class="badge type-${slug(p.type)}">${esc(p.type)}</span>${esc(p.id)}${p.client ? ' · ' + esc(p.client) : ''}</span>
            <span class="row-between">
              <span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>
              <span class="avatars">${team.slice(0, 4).map(m => `<span class="avatar sm" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}${team.length > 4 ? `<span class="avatar sm more">+${team.length - 4}</span>` : ''}</span>
            </span>
          </button>`;
      }).join('') || '<div class="empty"><h3>No projects match</h3></div>'}</div>`;
    const search = $('#projectSearch', root);
    search.addEventListener('input', () => {
      S.projectSearch = search.value;
      const pos = search.selectionStart;
      renderProjects(root);
      const s2 = $('#projectSearch', root); s2.focus(); s2.setSelectionRange(pos, pos);
    });
    $$('[data-filter]', root).forEach(b => b.addEventListener('click', () => { S.projectFilter = b.dataset.filter; renderProjects(root); }));
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
      const p = S.data.projects.find(x => x.id === b.dataset.edit);
      projectForm(Object.assign({}, p, { assigned: S.data.assignments.filter(a => a.projectId === p.id).map(a => a.userId) }));
    }));
  }

  function projectForm(values) {
    const d = dept(values.departmentId || manageDept());
    // The department's own types first; admins can also pick another department's types.
    const types = Array.from(new Set(d.projectTypes.concat(isAdmin() ? departments().reduce((a, x) => a.concat(x.projectTypes), []) : [])
      .concat(values.type ? [values.type] : [])));
    const byDept = (a, b) => (a.departmentId !== d.id) - (b.departmentId !== d.id) || a.name.localeCompare(b.name);
    openForm({
      title: values.id ? 'Edit project' : 'New project',
      values: Object.assign({}, values, { departmentId: d.id }),
      fields: [
        { name: 'name', label: 'Project name', required: true, wide: true },
        { name: 'id', label: 'Project ID (blank = auto)', readonly: !!values.id },
        ...(isAdmin() && manyDepts() ? [{ name: 'departmentId', label: 'Department', type: 'select', options: departments().map(x => ({ value: x.id, label: x.name })) }] : []),
        { name: 'type', label: 'Type', type: 'select', options: types.length ? types : PROJECT_TYPES },
        { name: 'status', label: 'Status', type: 'chips', options: PROJECT_STATUSES },
        { name: 'priority', label: 'Priority', type: 'chips', options: PRIORITIES },
        { name: 'client', label: 'Client' },
        { name: 'manager', label: 'Project manager' },
        { name: 'startDate', label: 'Start date', type: 'date' },
        { name: 'endDate', label: 'End date', type: 'date' },
        { name: 'assigned', label: 'Assigned engineers', type: 'checklist',
          options: S.data.team.filter(m => m.active).sort(byDept)
            .map(m => ({ value: m.id, label: m.name + (manyDepts() && m.departmentId !== d.id ? ' · ' + dept(m.departmentId).name : '') })) },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      onSubmit: async v => {
        if (!v.name) throw new Error('Project name is required.');
        v.departmentId = v.departmentId || d.id;
        await Api.saveProject(v, v.assigned, values.assigned || []);
        toast('Project saved');
        render();
      },
    });
  }

  function renderTeam(root) {
    const d = dept(manageDept());
    const subTeams = d.teams.length > 1;
    const people = S.data.team.filter(m => m.departmentId === d.id);
    root.innerHTML = `<div class="grid">${people.map(m => {
      const n = S.data.assignments.filter(a => a.userId === m.id).length;
      return `
        <button type="button" class="card list-card member${m.active ? '' : ' inactive'}" data-edit="${esc(m.id)}">
          <span class="avatar">${esc(initials(m.name))}</span>
          <span class="member-info"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.username)}</span></span>
          <span class="member-side">${!subTeams ? '' : m.team ? `<span class="badge">${esc(m.team)}</span>` : '<span class="badge off">No team</span>'}${m.role !== 'Member' ? `<span class="badge">${esc(m.role)}</span>` : ''}${m.active ? '' : '<span class="badge off">Inactive</span>'}<small class="muted">${n} project${n === 1 ? '' : 's'}</small></span>
        </button>`;
    }).join('') || `<div class="empty"><h3>Nobody in ${esc(d.name)} yet</h3><p>Tap <b>+ Member</b> to add someone.</p></div>`}</div>`;
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
      const m = S.data.team.find(x => x.id === b.dataset.edit);
      if (m.role === 'Admin' && !isAdmin()) return toast('Only an admin can change an admin.', true);
      memberForm(m);
    }));
  }

  function memberForm(values) {
    const isNew = !values.id;
    const d = dept(values.departmentId || manageDept());
    openForm({
      title: isNew ? 'New member' : 'Edit member',
      values: Object.assign({}, values, { departmentId: d.id }),
      fields: [
        { name: 'name', label: 'Full name', required: true },
        { name: 'username', label: 'Username (or full email)', required: true, readonly: !isNew },
        { name: 'password', type: 'password', required: isNew,
          label: isNew ? 'Password (min. 8 characters)' : 'New password (leave blank to keep)' },
        ...(isAdmin() && manyDepts() ? [{ name: 'departmentId', label: 'Department', type: 'select', options: departments().map(x => ({ value: x.id, label: x.name })) }] : []),
        // Only departments with more than one meeting column need a team (Automation: PLC / Dev).
        ...(d.teams.length > 1 ? [{ name: 'team', label: 'Team (decides the meeting column)', type: 'chips', options: d.teams }] : []),
        { name: 'role', label: 'Role (Dept admin: manages their own department)', type: 'chips',
          options: isAdmin() ? ['Member', 'Dept admin', 'Admin'] : ['Member', 'Dept admin'] },
        { name: 'active', label: 'Active (can sign in)', type: 'checkbox' },
      ],
      onSubmit: async v => {
        v.departmentId = v.departmentId || d.id;
        // A team only counts if it is one of the (new) department's columns.
        const cols = dept(v.departmentId).teams;
        const team = 'team' in v ? v.team : values.team;
        v.team = cols.length > 1 && cols.indexOf(team) !== -1 ? team : '';
        await Api.saveMember(Object.assign({ isNew: isNew, id: values.id }, v));
        toast('Member saved');
        render();
      },
    });
  }

  // ---------- Account ----------

  function accountSheet() {
    const dlg = $('#dialog');
    dlg.innerHTML = `
      <div class="sheet account">
        <header class="sheet-head"><span></span><h3>Account</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
        <div class="sheet-body">
          <div class="account-who"><span class="avatar lg">${esc(initials(me().name))}</span>
            <div><strong>${esc(me().name)}</strong><br><span class="muted">${esc(me().username)} · ${esc(me().role)}${manyDepts() ? ' · ' + esc(dept(me().departmentId).name) : ''}</span></div></div>
          <button type="button" class="secondary block" id="pwBtn">Change password</button>
          <button type="button" class="danger block" id="outBtn">Sign out</button>
          <p class="muted small">Tip: add this app to your home screen from your browser's Share/menu → "Add to Home screen".</p>
        </div>
      </div>`;
    $('[data-close]', dlg).addEventListener('click', () => dlg.close());
    $('#pwBtn', dlg).addEventListener('click', passwordForm);
    $('#outBtn', dlg).addEventListener('click', async () => { dlg.close(); await Api.logout(); location.reload(); });
    dlg.showModal();
  }

  function passwordForm() {
    openForm({
      title: 'Change password',
      submitLabel: 'Change',
      fields: [
        { name: 'current', label: 'Current password', type: 'password', required: true, wide: true },
        { name: 'next', label: 'New password (min. 8 characters)', type: 'password', required: true, wide: true },
        { name: 'confirm', label: 'Repeat new password', type: 'password', required: true, wide: true },
      ],
      onSubmit: async v => {
        if (v.next !== v.confirm) throw new Error('The new passwords do not match.');
        await Api.changePassword(v.current, v.next);
        toast('Password changed');
      },
    });
  }

  // ---------- Shell ----------

  const TABS = [
    { id: 'projects', label: 'Weekly board', view: viewProjects },
    { id: 'manage', label: 'Manage', view: viewManage, admin: true },
  ];

  function currentTab() {
    const id = location.hash.replace(/^#\/?/, '').replace(/^(meeting|tasks)$/, 'projects');
    const allowed = TABS.filter(t => !t.admin || isManager());
    return allowed.find(t => t.id === id) || allowed[0];
  }

  function render() {
    if (!S.data) return;
    const tab = currentTab();
    // No tabs: one page for everyone; admins open Manage from the settings button.
    const gear = $('#settingsBtn');
    gear.hidden = !isManager();
    gear.innerHTML = icon('settings');
    gear.classList.toggle('on', tab.id === 'manage');
    gear.setAttribute('aria-label', tab.id === 'manage' ? 'Back to the weekly board' : 'Settings (Manage)');
    $('#avatarBtn').textContent = initials(me().name);
    $('#avatarBtn').title = me().name;
    document.body.dataset.tab = tab.id;
    // Text half-typed into an "add" box survives the redraw (e.g. ticking a task meanwhile).
    const kept = {};
    const keepSel = '#view [data-keep], #dialog[data-mode="task"] [data-keep]';
    $$(keepSel).forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    tab.view($('#view'));
    renderTaskSheet();
    $$(keepSel).forEach(i => { if (kept[i.dataset.keep] && !i.value) i.value = kept[i.dataset.keep]; });
    if (kept['add-title']) { const f = $('#addForm'); if (f) f.classList.add('expanded'); }
  }

  function showLogin(message) {
    document.body.classList.remove('signed-in');
    $('#view').innerHTML = '';
    $('#loginView').hidden = false;
    const err = $('#loginError');
    err.textContent = message || '';
    err.hidden = !message;
  }

  function bindSettings() {
    $('#settingsBtn').onclick = () => { location.hash = currentTab().id === 'manage' ? '#/' : '#/manage'; };
  }

  function showApp() {
    $('#loginView').hidden = true;
    document.body.classList.add('signed-in');
    bindSettings();
    render();
  }

  const editing = () => ($('#dialog').open && $('#dialog').dataset.mode !== 'task') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
  /** Redraw now, or once the person stops typing. */
  function softRender() { if (!S.data) return; if (editing()) S.pendingRender = true; else render(); }

  /** Fetch everything (one request). Re-renders unless the person is typing. */
  async function refresh(quiet) {
    const sync = $('#sync');
    sync.className = 'sync busy';
    try {
      S.data = await Api.refresh();
      sync.className = 'sync';
      if (!editing()) showApp(); else S.pendingRender = true;
    } catch (e) {
      sync.className = 'sync off';
      if (e.code === 401) return;
      if (!S.data) return showLogin(e.message);
      if (!quiet) toast(e.code === 0 ? 'Offline — showing saved data' : e.message, e.code !== 0);
    }
  }

  // Live updates: a teammate's change triggers one quick refresh.
  let unsubscribe = null;
  function startLive() {
    if (unsubscribe) return;
    let timer = null;
    unsubscribe = Api.subscribe((table, payload) => {
      if (table === 'status') {
        $('#sync').title = payload.status === 'SUBSCRIBED' ? 'Live' : 'Reconnecting…';
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mineJustNow = Date.now() - S.lastWrite < 2500;
        await refresh(true);
        if (!mineJustNow && table === 'tasks') toast('Updated by a teammate');
      }, 400);
    });
  }

  async function start() {
    $('#loginForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const form = ev.target;
      const btn = $('button[type=submit]', form);
      btn.disabled = true; btn.textContent = 'Signing in…';
      $('#loginError').hidden = true;
      try {
        S.data = await Api.login(form.elements.username.value.trim(), form.elements.password.value);
        form.reset();
        showApp();
        startLive();
      } catch (e) {
        showLogin(e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
    $('#avatarBtn').addEventListener('click', accountSheet);
    window.addEventListener('session-expired', e => { S.data = null; showLogin(e.detail); });
    window.addEventListener('hashchange', () => { S.project = null; S.minutes = {}; render(); window.scrollTo(0, 0); });
    document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !editing()) { S.pendingRender = false; render(); } }, 300));
    window.addEventListener('focus', () => { if (S.data && Date.now() - (S.data.loadedAt || 0) > 60000) refresh(true); });
    // A new week started while the app was open: move to it and fetch fresh data.
    const onWake = () => { if (S.data && checkWeek()) { S.minutes = {}; refresh(true); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onWake(); });
    window.addEventListener('focus', onWake);
    setInterval(onWake, 60000);

    const userId = await Api.sessionUserId().catch(() => null);
    if (!userId) return showLogin();
    const cached = Api.cached();
    if (cached && cached.me && cached.me.id === userId && cached.tasks) {
      S.data = cached;   // instant: show what we had, then refresh
      showApp();
    } else {
      $('#view').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      document.body.classList.add('signed-in');
    }
    await refresh();
    if (S.data) startLive();
  }

  // App updates: the service worker downloads a new version in the background. When it
  // takes over, reload: at once if the app has only just opened, otherwise the next time
  // the person leaves the app, so nobody loses what they are typing.
  if ('serviceWorker' in navigator) {
    const openedAt = Date.now();
    const hadWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadWorker) return;   // first install, nothing to update
      if (Date.now() - openedAt < 10000 && !editing()) return location.reload();
      document.addEventListener('visibilitychange', () => { if (document.hidden) location.reload(); });
    });
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  start();
})();
