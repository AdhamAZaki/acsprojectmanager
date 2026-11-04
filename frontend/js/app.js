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
    board: null,         // 'mine' | 'all' | 'people' (admins); remembered per device
    addFor: null,        // project whose own add box is open
    addWeek: null,       // week picked in the add box (e.g. by "Plan next week")
    collapsed: null,     // card key ('p:<project id>' / 'u:<user id>') -> true; remembered per device
    sheetTask: null,     // phone: task open in the bottom sheet
    fold: { blocked: true, quiet: true },   // phone: Blocked / No-update lists folded to one line
    dept: null,          // department whose board is shown (default: your own)
    peopleOpen: {},      // task id -> its People section is unfolded
    leadFilter: null,    // Meeting: show one team leader's projects
    unitFilter: null,    // Workload: one org-chart team
    teamOpen: false,     // project panel: Team section unfolded
    pscope: null,        // Projects: 'mine' | 'all'
    hfilter: 'all',      // Meeting: health filter
    mdetail: 'project',  // Meeting: walk through by project or by person
    qa: null,            // quick add: project and week kept between adds
    layout: null,        // board layout: 'cards' (Trello-style, default) or 'list'; remembered per device
    groupBy: null,       // cards: 'status' | 'person' | 'type' | 'priority' | 'client' | 'manager' | 'none'
    cardFilter: '',      // cards: text filter on project name / client / type
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
  /**
   * A department that works across projects (GUI) also sees other departments' projects that its
   * people are on, or have tasks in ("supported" projects). Worked out once per redraw.
   */
  const crossDept = () => !!dept(curDept()).crossProject;
  function supported() {
    const key = curDept();
    if (S.sup && S.sup.key === key && S.sup.data === S.data && S.sup.n === S.data.tasks.length + S.data.assignments.length) return S.sup.ids;
    const ids = new Set();
    if (crossDept()) {
      const ours = new Set(S.data.team.filter(m => m.departmentId === key).map(m => m.id));
      S.data.assignments.forEach(a => { if (ours.has(a.userId)) ids.add(a.projectId); });
      S.data.tasks.forEach(t => { if (ownersOf(t).some(id => ours.has(id))) ids.add(t.projectId); });
    }
    S.sup = { key: key, data: S.data, n: S.data.tasks.length + S.data.assignments.length, ids: ids };
    return ids;
  }
  const ownDept = p => (p.departmentId || 'AUTO') === curDept();
  const inDept = p => ownDept(p) || (crossDept() && supported().has(p.id));
  const deptProjects = () => S.data.projects.filter(inDept);
  /** On a supported project, the department only counts its own people's tasks. */
  const relevant = t => ownDept(project(t.projectId)) || ownersOf(t).some(id => member(id).departmentId === curDept());
  /** Small tag for another department's project shown on a cross-project board. */
  const deptTag = p => !ownDept(p) ? `<span class="badge dept-tag">${esc(dept(p.departmentId).name)}</span>` : '';
  /** Dept admins (and admins) lead the people of their department, on any project. */
  const leadsPerson = id => isAdmin() || (me().role === 'Dept admin' && member(id).departmentId === me().departmentId);
  const leadsTask = t => isAdmin() || (me().role === 'Dept admin' && (ownersOf(t).concat(t.createdBy).some(id => member(id).departmentId === me().departmentId)));
  /** Manage: admins work on the department in view, department admins on their own. */
  const manageDept = () => isAdmin() ? curDept() : me().departmentId;
  /** Can I manage what is on screen (the open project's department, or the board's)? */
  const managesHere = () => canManage(S.project ? project(S.project).departmentId : curDept()) || (S.project && canManage(curDept()) && crossDept());
  // ---------- People: title and org-chart team ----------

  /** "BMS Team Leader Engineer · B.A Execution Team B" (whatever is known). */
  const personInfo = m => [m.title, m.unit].filter(Boolean).join(' · ');
  /** The list a person is filed under in pickers: their org-chart team, else their PLC / Dev team. */
  const unitOf = m => m.unit || (m.team ? m.team + ' team' : '') || 'Other';
  /**
   * People grouped by org-chart team, for pickers: the department's own groups first, then
   * other departments' people; "Other" last in each. Returns [{ label, people }].
   */
  function groupPeople(list, deptId) {
    const d = deptId || curDept();
    const groups = {};
    list.forEach(m => {
      const k = (m.departmentId === d ? '' : '~') + unitOf(m);
      (groups[k] = groups[k] || []).push(m);
    });
    const rank = k => (k[0] === '~' ? 2 : 0) + (/Other$/.test(k) ? 1 : 0);
    return Object.keys(groups).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(k => ({
      label: k[0] === '~' ? unitOf(groups[k][0]) + ' · ' + dept(groups[k][0].departmentId).name : k,
      people: groups[k].sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }
  /** <optgroup>s of people; option text "Name — Title". */
  const peopleOptions = (list, deptId, prefix) => groupPeople(list, deptId).map(g =>
    `<optgroup label="${esc(g.label)}">${g.people.map(m => `<option value="${esc(m.id)}">${esc((prefix || '') + m.name)}${m.title ? ' — ' + esc(m.title) : ''}</option>`).join('')}</optgroup>`).join('');

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
    const cols = deptTeams(curDept());   // the columns of the board being shown
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
  /** One-tap reasons for a blocked task (the note can still be typed). */
  const BLOCK_REASONS = ['Waiting for client', 'Material', 'Site access', 'Approval', 'Another company'];
  /** Own tasks only: you change tasks you created or are on; admins of the project's department change any. */
  const canEditTask = t => canManage(project(t.projectId).departmentId) || leadsTask(t) || t.createdBy === me().id || t.assigneeIds.indexOf(me().id) !== -1;
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
    const edit = canEditTask(t), full = canManage(project(t.projectId).departmentId), admin = full || leadsTask(t);
    const owners = ownersOf(t).map(id => member(id).name).join(', ');
    return `
      <div class="t ${isDone(t) ? 'done' : ''}${edit ? '' : ' ro'}">
        <div class="t-row">
          <button type="button" class="t-check ${isDone(t) ? 'on' : ''}" data-done="${t.id}"${edit ? '' : ` disabled title="${esc(owners)}’s task"`} aria-label="${isDone(t) ? 'Mark as not done' : 'Mark as done'}">${isDone(t) ? icon('check') : ''}</button>
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
        ${open && !edit ? `
        <div class="t-open read-only">
          ${t.subtasks.length ? `<ul class="plain subs-ro">${t.subtasks.map(x => `<li class="${x.done ? 'done' : ''}">${x.done ? '✔' : '○'} ${esc(x.t)}</li>`).join('')}</ul>` : ''}
          <p class="small"><span class="muted">On it:</span> ${esc(who(t) || owners)}</p>
          ${isBlocked(t) ? `<p class="small tag-block-note">Blocked: ${esc(t.blockNote || 'no reason given')}</p>` : ''}
          <p class="muted small ro-note">This is ${esc(owners)}’s task. Only they or an admin can change it.</p>
        </div>` : ''}
        ${open && edit ? `
        <div class="t-open">
          <div class="t-actions top">
            <button type="button" class="${isDone(t) ? 'secondary' : 'primary'}" data-done="${t.id}">${isDone(t) ? '↺ Not done' : '✓ Done'}</button>
            <button type="button" class="${isBlocked(t) ? 'danger' : 'secondary'}" data-block="${t.id}">${isBlocked(t) ? 'Unblock' : '⛔ Blocked'}</button>
            <button type="button" class="secondary" data-move="${t.id}">${t.week === NEXT ? '← This week' : '→ Next week'}</button>
          </div>
          ${isBlocked(t) ? `<div class="block-box"><p class="small"><strong>What is blocking it?</strong></p>
            <div class="chips">${BLOCK_REASONS.map(r => `<button type="button" class="chip${t.blockNote === r ? ' on' : ''}" data-reason="${t.id}:${esc(r)}">${esc(r)}</button>`).join('')}</div>
            <input class="block-note${t.blockNote ? '' : ' missing'}" placeholder="Or type the reason" data-blocknote="${t.id}" value="${esc(t.blockNote)}"></div>` : ''}
          <label class="title-edit"><span class="muted small">Task</span><textarea rows="2" data-title="${t.id}" maxlength="300" aria-label="Task title">${esc(t.title)}</textarea></label>
          <div class="subs">
            ${t.subtasks.map((s, i) => `<label class="sub"><input type="checkbox" data-sub="${t.id}:${i}"${s.done ? ' checked' : ''}><span class="${s.done ? 'done' : ''}">${esc(s.t)}</span><button type="button" data-subdel="${t.id}:${i}" aria-label="Remove sub-task">×</button></label>`).join('')}
            <div class="inline"><input placeholder="Add a sub-task" data-newsub="${t.id}" data-keep="sub-${t.id}" autocomplete="off"><button type="button" class="secondary" data-addsub="${t.id}">Add</button></div>
          </div>
          <details class="people-fold"${S.peopleOpen[t.id] ? ' open' : ''} data-pfold="${t.id}">
            <summary><span class="muted small">People:</span> ${esc(who(t) || owners)} <span class="text-btn">Change</span></summary>
            <div class="people">
              ${team.concat(extra).filter(m => admin || m.id === me().id || t.assigneeIds.indexOf(m.id) !== -1).map(m => full || (admin && leadsPerson(m.id)) || m.id === me().id
                ? `<label><input type="checkbox" data-asg="${t.id}:${m.id}"${t.assigneeIds.indexOf(m.id) !== -1 ? ' checked' : ''}><span class="avatar sm">${esc(initials(m.name))}</span>${esc(shortName(m.name))}</label>`
                : `<span class="person-chip" title="Only an admin can change who is on a task"><span class="avatar sm">${esc(initials(m.name))}</span>${esc(shortName(m.name))}</span>`).join('')}
              ${S.data.contacts.map(c => `<label class="ext"><input type="checkbox" data-ext="${t.id}:${c.id}"${t.contactIds.indexOf(c.id) !== -1 ? ' checked' : ''}>${esc(c.name)}</label>`).join('')}
            </div>
            <div class="inline"><input placeholder="Add someone outside the team" data-newext="${t.id}" data-keep="ext-${t.id}" autocomplete="off"><button type="button" class="secondary" data-addext="${t.id}">Add</button></div>
          </details>
          ${admin || t.createdBy === me().id ? `<div class="t-foot"><button type="button" class="ghost danger-text small-btn" data-del="${t.id}">Delete task</button></div>` : ''}
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
    $$('[data-reason]', root).forEach(b => b.onclick = () => {
      const k = b.dataset.reason.indexOf(':'); const t = findTask(b.dataset.reason.slice(0, k));
      updateTask(t, { blockNote: b.dataset.reason.slice(k + 1) });
    });
    $$('[data-pfold]', root).forEach(d => d.ontoggle = () => { S.peopleOpen[d.dataset.pfold] = d.open; });
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
    const list = people.filter(m => m.active !== false && m.id !== me().id && leadsPerson(m.id));
    return `<option value="${esc(me().id)}">For: me</option>` + peopleOptions(list, curDept(), 'For: ');
  }
  /** Project picker: my projects first, then every other open project of the department (anyone can add to any project). */
  function projectChoices() {
    const open = p => CLOSED.indexOf(p.status) === -1 && inDept(p);
    const mine = myProjects().filter(open);
    const others = S.data.projects.filter(p => open(p) && mine.indexOf(p) === -1).sort((a, b) => a.name.localeCompare(b.name));
    if (!S.lastProject) S.lastProject = remember.get('last-project');
    const known = S.data.projects.some(p => p.id === S.lastProject && open(p));
    const opt = p => `<option value="${esc(p.id)}"${p.id === S.lastProject ? ' selected' : ''}>${esc(p.name)}</option>`;
    // Never preselect an arbitrary project: until you have used one, you pick it.
    return (known ? '' : '<option value="" disabled selected>Choose a project…</option>') + (mine.length ? `<optgroup label="My projects">${mine.map(opt).join('')}</optgroup>` : '') +
      (others.length ? `<optgroup label="${mine.length ? 'Other projects' : 'Projects'}">${others.map(opt).join('')}</optgroup>` : '');
  }
  /** `fixedProject`: add straight into that project. `week`: the week picked by default. */
  function addBar(fixedProject, people, week) {
    week = S.addWeek || week || (S.which === 'next' ? NEXT : THIS);
    if (week < shiftWeek(THIS, managesHere() ? -4 : -1) || week > shiftWeek(THIS, managesHere() ? 8 : 1)) week = THIS;
    return `
      <form class="card addbar${S.addWeek || fixedProject ? ' expanded' : ''}" id="addForm">
        <input name="title" data-keep="add-title" placeholder="${week === NEXT ? 'Next week, e.g. Loop check LCP-02 with the client' : week < THIS ? 'What did you do that week?' : 'e.g. Commission AHU-3 controller on level 2'}" autocomplete="off" required>
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
      if (!title) return;
      if (!pid) { toast('Choose the project first', true); f.elements.project.focus(); return; }
      S.lastProject = pid; remember.set('last-project', pid);
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
        S.addWeek = week;   // the next task goes in the same week until you change it
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

  // ---------- Projects ----------

  /**
   * The selected project in a side panel (Notion-style side peek) next to any screen: its tasks for
   * this or next week, its team, and an add box. Full screen on a phone. Esc or × closes it.
   */
  function renderPanel(root) {
    if (S.project && !S.data.projects.some(x => x.id === S.project)) S.project = null;   // removed meanwhile
    const old = $('.side-panel .sp-body');
    const top = old ? old.scrollTop : 0;
    document.body.classList.toggle('panel-open', !!S.project);
    if (!S.project) return;
    root.insertAdjacentHTML('beforeend', '<aside class="side-panel" aria-label="Project"><div class="sp-body"></div></aside>');
    const body = $('.side-panel .sp-body', root);
    viewProject(body, project(S.project));
    body.scrollTop = top;
  }
  function closePanel() { S.project = null; S.addWeek = null; render(); }

  function viewProject(root, p) {
    const cur = S.data.tasks.filter(t => t.projectId === p.id && inView(t, S.which));
    const byPerson = {};   // a task shared by two people shows under both
    cur.forEach(t => ownersOf(t).forEach(id => { (byPerson[id] = byPerson[id] || []).push(t); }));
    const onIt = myProjectIds().indexOf(p.id) !== -1;
    const order = Object.keys(byPerson).sort((a, b) => (a === me().id ? -1 : b === me().id ? 1 : member(a).name.localeCompare(member(b).name)));
    root.innerHTML = `
      <div class="sp-head">
        <div class="sp-tags"><span class="badge ${typeClass(p.type)}">${esc(p.type)}</span><span class="prio prio-${slug(p.priority)}">${esc(p.priority || 'Medium')}</span><span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span></div>
        <span class="sp-actions">${onIt ? '<button type="button" class="ghost small-btn" id="leaveBtn">Leave</button>' : '<button type="button" class="primary small" id="joinBtn">Join</button>'}
          <button type="button" class="icon-btn sp-close" id="backBtn" aria-label="Close">×</button></span>
      </div>
      <h2 class="sp-title">${esc(p.name)}</h2>
      <p class="muted small sp-meta">${[manyDepts() ? dept(p.departmentId).name : '', p.id, p.client, p.manager ? 'PM: ' + p.manager : '',
        p.startDate || p.endDate ? (p.startDate || '…') + ' → ' + (p.endDate || '…') : ''].filter(Boolean).map(esc).join(' · ')}</p>
      ${canManage(p.departmentId) ? '' : teamTags(p.id, { people: order.map(id => ({ id: id })) })}
      ${p.notes ? `<p class="sp-notes">${esc(p.notes)}</p>` : ''}
      ${weekSwitch(S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length, S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'next')).length)}
      ${CLOSED.indexOf(p.status) === -1 ? addBar(p.id, projectTeam(p.id).concat(S.data.team.filter(m => projectTeam(p.id).indexOf(m) === -1))) : ''}
      ${order.map(id => `<section class="card"><h3 class="card-title"><span class="avatar sm">${esc(initials(member(id).name))}</span>${esc(member(id).name)}${member(id).team ? ` <span class="badge">${esc(member(id).team)}</span>` : ''}</h3>
        ${byPerson[id].sort((a, b) => isDone(a) - isDone(b)).map(t => taskHtml(t, true)).join('')}</section>`).join('')
        || `<div class="empty"><h3>No tasks ${S.which === 'next' ? 'planned for next week' : 'this week'}</h3></div>`}
      ${canManage(p.departmentId) || isManager() ? `<details class="sp-fold"${S.teamOpen ? ' open' : ''} data-spfold="team"><summary>Team (${projectTeam(p.id).length})${projectLead(p) ? ' · lead ' + esc(shortName(projectLead(p).name)) : ''}</summary>${teamEditor(p)}</details>` : ''}
      ${historyHtml(p)}`;
    $$('[data-spfold="team"]', root).forEach(d => d.ontoggle = () => { S.teamOpen = d.open; });
    $('#backBtn', root).onclick = closePanel;
    const leave = $('#leaveBtn', root);
    if (leave) leave.onclick = async () => {
      if (!confirm('Leave ' + p.name + '? Your tasks stay on the project.')) return;
      S.lastWrite = Date.now();
      await guard(() => Api.leaveProject(p.id)); render();
    };
    const join = $('#joinBtn', root);
    if (join) join.onclick = async () => { S.lastWrite = Date.now(); await guard(() => Api.joinProject(p.id)); render(); };
    bindWeekSwitch(root); bindAddBar(root, p.id); bindTasks(root); bindTeamEditor(root, p);
  }

  /** The project's last 8 weeks: a small bar per week (tasks done), and what was done. */
  function historyHtml(p) {
    const hist = projectHistory(p, S.mtgWeek);
    const max = Math.max(1, ...hist.map(h => h.done.length));
    const total = hist.reduce((n, h) => n + h.done.length, 0);
    return `<details class="sp-fold history"><summary>History · last 8 weeks <small class="muted">${total} done</small></summary>
      <div class="hist-bars" role="img" aria-label="Tasks done per week">${hist.map(h => `<span class="hist-col" title="Week ${wnum(h.week)}: ${h.done.length} done, ${h.added} added">
        <span class="hist-bar" style="height:${Math.round(h.done.length / max * 100)}%"></span><small>${wnum(h.week)}</small><b>${h.done.length}</b></span>`).join('')}</div>
      ${hist.slice().reverse().filter(h => h.done.length).map(h => `<p class="hist-week">Week ${wnum(h.week)} <small class="muted">· ${h.done.length} done · ${h.added} added</small></p>
        <ul class="plain hist-list">${h.done.map(t => `<li>✔ ${esc(t.title)} <small class="muted">${esc(who(t) || member(t.createdBy).name)}</small></li>`).join('')}</ul>`).join('') || '<p class="muted small">Nothing done in these weeks yet.</p>'}
    </details>`;
  }

  /** Admins: who is on the project. Tap × to take someone off, or pick a person to add. */
  function teamEditor(p) {
    const team = projectTeam(p.id);
    // On another department's project, a department admin adds and removes only their own people.
    const may = m => canManage(p.departmentId) || leadsPerson(m.id);
    const others = S.data.team.filter(m => m.active && team.indexOf(m) === -1 && may(m));
    return `<div class="card team-edit"><strong class="small">Team</strong>
      <div class="avatars-row">${team.map(m => `<span class="person-chip" title="${esc(personInfo(m))}">${esc(shortName(m.name))}${may(m) ? `<button type="button" class="chip-x" data-unassign="${esc(m.id)}" aria-label="Take ${esc(m.name)} off the project">×</button>` : ''}</span>`).join('') || '<span class="muted small">Nobody yet</span>'}</div>
      ${others.length ? `<select id="assignSel" aria-label="Add a person to the project"><option value="">+ Add a person…</option>${peopleOptions(others, p.departmentId)}</select>` : ''}</div>`;
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
      const ts = S.data.tasks.filter(t => t.projectId === p.id && relevant(t));
      const pick = {
        doing: ts.filter(t => !isDone(t) && open(t)),
        done: ts.filter(t => isDone(t) && t.week === week),
        next: ts.filter(t => t.week === nextOf),
      };
      const h = healthOf(p, week);
      if (h.active) summary.moved++;   // something was added, changed or done on it this week
      if (!pick.doing.length && !pick.done.length && !pick.next.length) {
        // Open projects with nothing this week still appear in the email, as "no update".
        if (p.status === 'In Progress') rows.push({ id: p.id, name: p.name, type: p.type, status: p.status, health: 'No update this week', silent: true, cols: {}, people: [] });
        return;
      }
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
      rows.push({
        id: p.id, name: p.name, type: p.type, status: p.status, cols: cols, health: h.flags.map(f => HEALTH[f].label).join(', ') || 'On track',
        people: Object.keys(people).map(k => people[k]).sort((x, y) => x.name.localeCompare(y.name)),
      });
    });
    const blocked = S.data.tasks.filter(t => isBlocked(t) && open(t) && inDept(project(t.projectId)) && relevant(t))
      .sort((a, b) => a.week.localeCompare(b.week))
      .map(t => Object.assign(itemOf(t, 'doing'), { project: project(t.projectId).name }));
    summary.silent = rows.filter(r => r.silent).length;
    summary.blocked = blocked.length;
    return { v: 1, week: week, dept: curDept(), deptName: dept(curDept()).name, teams: teams, rows: rows, blocked: blocked, summary: summary };
  }

  /**
   * People of the department (and anyone on one of its open projects) with no update in the week:
   * none of their tasks (created by or assigned to them) was added or changed that week. A task
   * someone else created for them and nobody has touched since doesn't count as their update.
   * Returns [{ m, onProject, last }].
   */
  function quietPeople(week) {
    const openIds = deptProjects().filter(p => CLOSED.indexOf(p.status) === -1).map(p => p.id);
    const onOpen = id => S.data.assignments.some(a => a.userId === id && openIds.indexOf(a.projectId) !== -1);
    const theirs = m => S.data.tasks.filter(t => t.createdBy === m.id || t.assigneeIds.indexOf(m.id) !== -1);
    const counts = (t, m) => touchedIn(t, week) && !(t.createdBy !== m.id && t.createdRaw && t.createdRaw === t.version);
    return S.data.team.filter(m => m.active && (m.departmentId === curDept() || onOpen(m.id)))
      .filter(m => !theirs(m).some(t => counts(t, m)))
      .map(m => ({ m: m, onProject: onOpen(m.id), last: theirs(m).reduce((x, t) => t.version && t.version > x ? t.version : x, '') }))
      .sort((a, b) => a.m.name.localeCompare(b.m.name));
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
      const week = b.dataset.week;
      guard(() => Api.minutes(week, curDept())).then(rec => { if (rec && rec.snapshot) savedMinutesSheet(rec); });
    });
  }

  /** A saved copy of the minutes, read-only, exactly as saved; it can be copied as an email. */
  function savedMinutesSheet(rec) {
    const dlg = $('#dialog');
    const m = rec.snapshot;
    const draw = () => {
      const cards = projectCards(m.rows || [], rec.week, false, 'all');
      dlg.innerHTML = `<div class="sheet saved-sheet"><header class="sheet-head"><span></span><h3>Saved minutes · week ${wnum(rec.week)}</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
        <div class="sheet-body">
          <p class="muted small" style="margin:0 0 10px">${esc(weekRange(rec.week))} ${weekMonday(rec.week).getUTCFullYear()} · saved ${esc(rec.savedAt)}${rec.savedBy ? ' by ' + esc(member(rec.savedBy).name) : ''}. This copy does not change when tasks change.</p>
          <div class="actions-row"><button type="button" class="primary" id="copySaved">Copy as email</button></div>
          ${m.notes ? `<section class="card"><h3 class="card-title">Team notes</h3><p class="saved-notes">${esc(m.notes)}</p></section>` : ''}
          ${(m.blocked || []).length ? `<section class="card warn"><h3 class="card-title">Blocked (${m.blocked.length})</h3><ul class="plain">${m.blocked.map(it => `<li><span><strong>${esc(it.title)}</strong><br><span class="muted">${esc(it.project)} · ${esc(it.who)} — ${esc(it.note || 'no reason given')}</span></span></li>`).join('')}</ul></section>` : ''}
          ${cards.html}</div></div>`;
      $('[data-close]', dlg).onclick = () => dlg.close();
      $('#copySaved', dlg).onclick = () => copyEmail(m);
      $$('[data-fold]', dlg).forEach(b => b.onclick = () => { setCollapsed([b.dataset.fold], !collapsed()[b.dataset.fold]); draw(); });
    };
    delete dlg.dataset.mode;
    draw();
    if (!dlg.open) dlg.showModal();
  }

  /** Loads the saved minutes for a week once, then redraws. */
  function loadMinutes(week) {
    const d = curDept(), key = mkey(week);
    S.minutes[key] = undefined;
    Api.minutes(week, d).then(rec => { S.minutes[key] = rec; }, () => { S.minutes[key] = null; })
      .then(() => { if (currentTab().id === 'meeting' && S.mtgWeek === week && curDept() === d) softRender(); });
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
    const tag = (m, extra) => `<span class="name-tag${m.id === me().id ? ' me' : ''}${extra ? ' helping' : ''}${m.team ? ' team-' + slug(m.team) : ''}" title="${esc(m.name)}${personInfo(m) ? ' · ' + esc(personInfo(m)) : m.team ? ' · ' + esc(m.team) + ' team' : ''}${extra ? ' · has tasks here, not on the project' : ''}">
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

  /**
   * The department's projects shown in a view: My tasks (projects I have tasks on), My projects
   * (joined), All projects (open ones, plus closed ones with tasks). Mine first, then active, then A-Z.
   */
  function boardProjects(byId, mode) {
    const mineIds = myProjectIds();
    const mineHas = r => r && r.people.some(pp => pp.id === me().id);
    const shown = p => mode === 'mine' ? mineIds.indexOf(p.id) !== -1 || mineHas(byId[p.id]) : mode === 'active' ? !!byId[p.id] : (CLOSED.indexOf(p.status) === -1 || byId[p.id]);
    return deptProjects().filter(shown).sort((a, b) =>
      (mineIds.indexOf(b.id) !== -1) - (mineIds.indexOf(a.id) !== -1) || !!byId[b.id] - !!byId[a.id] || a.name.localeCompare(b.name));
  }

  // ---------- Cards layout (Trello-style columns) ----------

  /** Board layout and grouping, remembered per device. */
  function boardLayout() {
    if (!S.layout) S.layout = remember.get('layout') === 'list' ? 'list' : 'cards';
    return S.layout;
  }
  /**
   * The ways cards can be grouped. `keys(p, r)` gives the column(s) a project goes in; `order` sorts
   * the columns; `field` makes a column a drop target (admins drag a card to change that field).
   * Client and Project manager are only offered when some project has one.
   */
  function cardGroups(projects) {
    const d = dept(curDept());
    const has = f => projects.some(p => String(p[f] || '').trim());
    const people = (p, r) => {
      const ids = projectTeam(p.id).filter(m => m.active !== false).map(m => m.id);
      (r ? r.people : []).forEach(pp => { if (pp.id && ids.indexOf(pp.id) === -1) ids.push(pp.id); });
      return ids.length ? ids : [''];
    };
    const g = [
      { id: 'status', label: 'Status', keys: p => [p.status], order: PROJECT_STATUSES, field: 'status' },
      { id: 'person', label: 'Person', keys: people, name: id => id ? member(id).name : 'Nobody yet',
        order: null, sort: (a, b) => (!a) - (!b) || (b === me().id) - (a === me().id) || member(a).name.localeCompare(member(b).name) },
      { id: 'type', label: d.projectTypes.indexOf('GRMS') !== -1 ? 'Service' : 'Type', keys: p => [p.type], order: d.projectTypes, field: 'type' },
      { id: 'priority', label: 'Priority', keys: p => [p.priority || 'Medium'], order: PRIORITIES, field: 'priority' },
    ];
    if (has('client')) g.push({ id: 'client', label: 'Client', keys: p => [String(p.client || '').trim() || 'No client'] });
    if (has('manager')) g.push({ id: 'manager', label: 'Project manager', keys: p => [String(p.manager || '').trim() || 'No manager'] });
    g.push({ id: 'none', label: 'No grouping', keys: () => [''] });
    return g;
  }

  /** One compact card: this week's numbers, the first few tasks (blocked first), the team. */
  function projectCardHtml(p, r, opts) {
    const seen = {}, items = [];
    (r ? r.people : []).filter(pp => !opts.onlyId || pp.id === opts.onlyId)
      .forEach(pp => pp.items.forEach(it => { if (!seen[it.id]) { seen[it.id] = true; items.push(it); } }));
    const n = k => items.filter(k).length;
    const blocked = n(it => it.kind === 'doing' && it.blocked), doing = n(it => it.kind === 'doing' && !it.blocked);
    const done = n(it => it.kind === 'done'), next = n(it => it.kind === 'next');
    const rank = it => it.blocked ? 0 : it.kind === 'doing' ? 1 : it.kind === 'next' ? 2 : 3;
    const top = items.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 3);
    const mark = it => it.kind === 'done' ? '✔' : it.kind === 'next' ? '→' : it.blocked ? '⛔' : '•';
    const team = projectTeam(p.id).filter(m => m.active !== false);
    const stat = (v, cls, label) => v ? `<span class="pc-stat ${cls}" title="${label}">${v} ${label}</span>` : '';
    return `<article class="pcard${opts.drag ? ' draggable' : ''}${S.project === p.id ? ' selected' : ''}" data-pid="${esc(p.id)}"${opts.drag ? ' draggable="true"' : ''}>
      <div class="pc-top">${deptTag(p)}<span class="badge ${typeClass(p.type)}">${esc(p.type)}</span>${opts.group !== 'priority' ? `<span class="prio prio-${slug(p.priority)}">${esc(p.priority || 'Medium')}</span>` : ''}${opts.group !== 'status' ? `<span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>` : ''}</div>
      <button type="button" class="pc-open" data-project="${esc(p.id)}">${esc(p.name)}</button>
      ${items.length ? `<div class="pc-stats">${stat(blocked, 'bad', 'blocked')}${stat(doing, '', 'in progress')}${stat(done, 'ok', 'done')}${stat(next, 'next', 'next week')}</div>
      <ul class="pc-tasks">${top.map(it => `<li class="${it.blocked ? 'blk' : ''}${it.kind === 'done' ? ' done' : ''}"><span class="mk">${mark(it)}</span><span>${esc(it.title)}</span></li>`).join('')}</ul>
      ${items.length > 3 ? `<p class="pc-more">+${items.length - 3} more</p>` : ''}`
      : '<p class="pc-empty">No tasks this week or next</p>'}
      <div class="pc-foot">${team.length ? `<span class="avatars" aria-label="Team">${team.slice(0, 5).map(m => `<span class="avatar sm${m.id === me().id ? ' me' : ''}" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}${team.length > 5 ? `<span class="avatar sm more">+${team.length - 5}</span>` : ''}</span>` : '<span class="muted small">Nobody on it yet</span>'}</div>
    </article>`;
  }

  /** Trello-style board: one column per group (status, person, …), compact project cards in each. */
  function cardsBoard(rows, week, mode) {
    const byId = {}; rows.forEach(r => { if (r.id) byId[r.id] = r; });
    const q = S.cardFilter.trim().toLowerCase();
    const all = boardProjects(byId, mode);
    const projects = all.filter(p => !q || (p.name + ' ' + p.client + ' ' + p.type + ' ' + p.id).toLowerCase().indexOf(q) !== -1);
    const groups = cardGroups(all);
    if (!S.groupBy) S.groupBy = remember.get('group') || 'status';
    const g = groups.find(x => x.id === S.groupBy) || groups[0];
    const drag = !!g.field && canManage(curDept());
    // Columns: every project goes in the column(s) its key(s) name.
    const cols = {};
    projects.forEach(p => g.keys(p, byId[p.id]).forEach(k => { (cols[k] = cols[k] || []).push(p); }));
    let keys = Object.keys(cols);
    if (g.order) {
      // Admins also see empty columns, to drag a card into.
      keys = g.order.filter(k => cols[k] || drag).concat(keys.filter(k => g.order.indexOf(k) === -1));
    } else keys.sort(g.sort || ((a, b) => a.localeCompare(b)));
    const title = k => g.name ? g.name(k) : k;
    const head = k => g.id === 'person' ? `<span class="avatar xs">${esc(k ? initials(member(k).name) : '?')}</span>${esc(title(k))}${k === me().id ? ' <small>(You)</small>' : ''}`
      : g.id === 'status' ? `<span class="pstatus ps-${slug(k)}">${esc(k)}</span>`
      : g.id === 'priority' ? `<span class="prio prio-${slug(k)}">${esc(k)}</span>` : esc(title(k) || 'All projects');
    // In a person's column (and in My tasks) a card shows only that person's tasks.
    const cardOpts = k => ({ group: g.id, drag: drag, onlyId: g.id === 'person' ? k : null });
    const columns = keys.map(k => `<section class="lane${g.id === 'none' ? ' wide' : ''}${(cols[k] || []).length ? '' : ' empty'}" data-lane="${esc(k)}">
        ${g.id === 'none' ? '' : `<header class="lane-head"><span class="lane-title">${head(k)}</span><span class="lane-count">${(cols[k] || []).length}</span></header>`}
        <div class="lane-body">${(cols[k] || []).map(p => projectCardHtml(p, byId[p.id], cardOpts(k))).join('') || '<p class="lane-empty">Drop here</p>'}</div>
      </section>`).join('');
    const empty = !projects.length ? `<div class="empty"><h3>${q ? 'No projects match “' + esc(S.cardFilter) + '”' : mode === 'mine' ? `Nothing of yours in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))} yet` : 'No projects to show'}</h3>${mode === 'mine' && !q ? '<p>Add a task above, or join a project from <b>All projects</b>.</p>' : ''}</div>` : '';
    return {
      tools: `<div class="cards-tools no-print">
          <label class="group-by">Group by <select id="groupBy">${groups.map(x => `<option value="${x.id}"${x.id === g.id ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
          <input type="search" id="cardFilter" class="search" placeholder="Find a project" value="${esc(S.cardFilter)}" data-keep="card-filter" autocomplete="off">
        </div>`,
      html: empty || `<div class="lanes${g.id === 'none' ? ' grid-mode' : ''}" data-group="${g.id}">${columns}</div>`,
      field: g.field, keys: [],
    };
  }

  function bindCards(root, field) {
    const gb = $('#groupBy', root);
    if (gb) gb.onchange = () => { S.groupBy = gb.value; remember.set('group', S.groupBy); render(); };
    const f = $('#cardFilter', root);
    if (f) f.oninput = () => {
      S.cardFilter = f.value;
      const pos = f.selectionStart;
      render();
      const f2 = $('#cardFilter'); if (f2) { f2.focus(); f2.setSelectionRange(pos, pos); }
    };
    // Admins: drag a card to another column to change its status / priority / type.
    if (!field) return;
    $$('.pcard[draggable]', root).forEach(c => {
      c.ondragstart = e => { e.dataTransfer.setData('text/plain', c.dataset.pid); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); };
      c.ondragend = () => c.classList.remove('dragging');
    });
    $$('.lane', root).forEach(l => {
      l.ondragover = e => { e.preventDefault(); l.classList.add('drop'); };
      l.ondragleave = () => l.classList.remove('drop');
      l.ondrop = async e => {
        e.preventDefault(); l.classList.remove('drop');
        const p = project(e.dataTransfer.getData('text/plain'));
        const to = l.dataset.lane;
        if (!p || !to || p[field] === to) return;
        const team = S.data.assignments.filter(a => a.projectId === p.id).map(a => a.userId);
        const before = p[field];
        p[field] = to; S.lastWrite = Date.now(); render();   // show it at once
        const saved = await guard(() => Api.saveProject(Object.assign({}, p), team, team));
        if (saved) toast(p.name + ' → ' + to); else { p[field] = before; render(); }
      };
    });
  }

  /** One card per project (My tasks / My projects / All projects views). */
  function projectCards(rows, week, live, mode) {
    const byId = {}; rows.forEach(r => { if (r.id) byId[r.id] = r; });
    const mineIds = myProjectIds();
    let list;
    // Saved minutes: find each project again by id, or by name for minutes saved before ids were kept.
    const savedProject = r => S.data.projects.find(x => x.id === r.id) || S.data.projects.find(x => x.name === r.name);
    if (!live) list = rows.map(r => ({ r: r, p: savedProject(r) || { id: r.id || r.name, name: r.name, type: r.type, status: r.status } }));
    else list = boardProjects(byId, mode).map(p => ({ r: byId[p.id], p: p }));
    const card = ({ r, p }) => {
      const key = 'p:' + p.id;
      const exists = project(p.id).id === p.id;   // saved minutes may name a project that was removed since
      const isReal = live && exists;
      const on = mineIds.indexOf(p.id) !== -1;
      const open = CLOSED.indexOf(p.status) === -1;
      return `<section class="card board-card${collapsed()[key] ? ' folded' : ''}${S.project === p.id ? ' selected' : ''}">
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
          ${r ? weekGrid(r, week, live, mode === 'mine' ? me().id : null) : `<p class="muted small" style="margin:8px 0 0">No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))}.</p>`}
        </div>
      </section>`;
    };
    const empty = mode === 'mine'
      ? `<div class="empty"><h3>No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))} yet</h3><p>Add one above, on any project.</p></div>`
      : '<div class="empty"><h3>No projects to show</h3></div>';
    return { html: list.map(card).join('') || empty, keys: list.map(x => 'p:' + x.p.id) };
  }

  /** Admins: one card per person in the department (or with tasks in it), their tasks grouped by project. */
  /** By person: only people on one of the department's projects, or with tasks in it that week. */
  function personCards(rows, week, live) {
    const onDeptProject = id => S.data.assignments.some(a => a.userId === id && inDept(project(a.projectId)));
    const people = S.data.team.filter(m => m.active && (onDeptProject(m.id) || rows.some(r => r.people.some(pp => pp.id === m.id))))
      .sort((a, b) => unitOf(a).localeCompare(unitOf(b)) || a.name.localeCompare(b.name));
    const html = people.map(m => {
      const key = 'u:' + m.id;
      const mine = rows.filter(r => r.people.some(pp => pp.id === m.id));
      const onProjects = S.data.assignments.filter(a => a.userId === m.id && inDept(project(a.projectId))).length;
      const count = mine.reduce((n, r) => n + r.people.find(pp => pp.id === m.id).items.length, 0);
      return `<section class="card board-card${collapsed()[key] ? ' folded' : ''}">
        <div class="board-head">${chevron(key, m.name)}
          <div class="board-name"><span class="board-title"><span class="avatar sm">${esc(initials(m.name))}</span><strong>${esc(m.name)}</strong>${m.team ? ` <span class="badge">${esc(m.team)}</span>` : ''}</span>
          ${personInfo(m) ? `<p class="team-line person-info">${esc(personInfo(m))}</p>` : ''}
          <p class="team-line muted">${count} ${count === 1 ? 'task' : 'tasks'} this week · on ${onProjects} ${onProjects === 1 ? 'project' : 'projects'}</p></div></div>
        <div class="board-body">${mine.map(r => `<h4 class="person-project">${esc(r.name)}</h4>${weekGrid(r, week, live, m.id)}`).join('') || `<p class="muted small" style="margin:8px 0 0">No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))}.</p>`}</div>
      </section>`;
    }).join('');
    return { html: html || '<div class="empty"><h3>Nobody is on a project yet</h3><p>Add people to projects from each project’s page.</p></div>', keys: people.map(m => 'u:' + m.id) };
  }

  // ---------- Shared: compact header (department ▾ · week ‹ ›) ----------

  /** One sticky bar: the department (if there is more than one) and the week. */
  function weekBar() {
    const week = S.mtgWeek;
    const deptSel = manyDepts() ? `<select class="dept-pick" id="deptPick" aria-label="Department">${departments().map(d =>
      `<option value="${esc(d.id)}"${d.id === curDept() ? ' selected' : ''}>${esc(d.name)}${d.id === me().departmentId ? '' : ' (view)'}</option>`).join('')}</select>` : '';
    return `<div class="weekbar">
        ${deptSel}
        <button type="button" class="icon-btn" data-mw="-1" aria-label="Previous week">${icon('left')}</button>
        <div class="weekbar-label"><strong>Week ${wnum(week)}${week === THIS ? ' · this week' : ''}</strong><span>${esc(weekRange(week))}</span></div>
        <button type="button" class="icon-btn" data-mw="1" aria-label="Next week"${week >= shiftWeek(THIS, 8) ? ' disabled' : ''}>${icon('chevron')}</button>
        ${week !== THIS ? '<button type="button" class="text-btn" id="toToday">This week</button>' : ''}
      </div>`;
  }
  function bindWeekBar(root) {
    const d = $('#deptPick', root);
    if (d) d.onchange = () => { S.dept = d.value; S.project = null; S.addWeek = null; render(); };
    $$('[data-mw]', root).forEach(b => b.onclick = () => { S.mtgWeek = shiftWeek(S.mtgWeek, Number(b.dataset.mw)); S.addWeek = null; render(); });
    const t = $('#toToday', root); if (t) t.onclick = () => { S.mtgWeek = THIS; render(); };
  }

  /** Opens a project in the side panel (from any screen); tapping the open one again closes it. */
  function bindProjectLinks(root) {
    $$('[data-project]', root).forEach(b => b.onclick = e => {
      e.preventDefault();
      const same = S.project === b.dataset.project;
      S.project = same ? null : b.dataset.project; S.addWeek = null;
      if (!same) { S.which = S.mtgWeek > THIS ? 'next' : 'this'; const o = $('.side-panel .sp-body'); if (o) o.scrollTop = 0; }
      render();
    });
  }

  // ---------- Project health (the manager's view of a project in a week) ----------

  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const touchedIn = (t, week) => !!t.version && isoWeek(new Date(t.version)) === week;
  /**
   * For one project in a week: counts, last activity and flags.
   *   blocked: a blocked task · late: past its end date and not closed · stale: a task carried 2+ weeks
   *   quiet: In Progress but no task added or changed that week · ok: none of these
   */
  function healthOf(p, week) {
    const ts = S.data.tasks.filter(t => t.projectId === p.id && relevant(t));
    const inWeek = t => t.week === week || (week === THIS && t.week < week && !isDone(t));
    const open = ts.filter(t => !isDone(t) && inWeek(t));
    const h = {
      blocked: open.filter(isBlocked).length,
      doing: open.filter(t => !isBlocked(t)).length,
      done: ts.filter(t => isDone(t) && t.week === week).length,
      next: ts.filter(t => t.week === shiftWeek(week, 1)).length,
      stale: open.filter(t => t.week <= shiftWeek(week, -2)).length,
      active: ts.some(t => touchedIn(t, week)),
      last: ts.reduce((m, t) => t.version && t.version > m ? t.version : m, ''),
      closed: CLOSED.indexOf(p.status) !== -1,
    };
    h.late = !h.closed && !!p.endDate && p.endDate < today();
    h.quiet = p.status === 'In Progress' && !h.active;
    h.flags = [h.blocked && 'blocked', h.late && 'late', h.stale && 'stale', h.quiet && 'quiet'].filter(Boolean);
    h.key = h.flags[0] || 'ok';
    return h;
  }
  const HEALTH = {
    blocked: { label: 'Blocked', rank: 0 }, late: { label: 'Past end date', rank: 1 }, stale: { label: 'Carried 2+ weeks', rank: 2 },
    quiet: { label: 'No update', rank: 3 }, ok: { label: 'On track', rank: 4 },
  };
  /**
   * The project's team leader, worked out from its team (no extra data to keep up to date): the
   * Dept admin (else admin) on the team whose org-chart team matches most of the others on it.
   */
  function projectLead(p) {
    const team = projectTeam(p.id).filter(m => m.active !== false);
    const leads = team.filter(m => m.role === 'Dept admin' || m.role === 'Admin');
    if (!leads.length) return null;
    const units = {};
    team.filter(m => leads.indexOf(m) === -1 && m.unit).forEach(m => { units[m.unit] = (units[m.unit] || 0) + 1; });
    return leads.slice().sort((a, b) => (units[b.unit] || 0) - (units[a.unit] || 0) ||
      (a.role === 'Dept admin' ? 0 : 1) - (b.role === 'Dept admin' ? 0 : 1) || a.name.localeCompare(b.name))[0];
  }
  /** Last 8 weeks of a project: tasks done and added per week (from the tasks already loaded). */
  function projectHistory(p, upTo) {
    const ts = S.data.tasks.filter(t => t.projectId === p.id);
    const out = [];
    for (let n = 7; n >= 0; n--) {
      const w = shiftWeek(upTo, -n);
      out.push({ week: w, done: ts.filter(t => isDone(t) && t.week === w),
        added: ts.filter(t => t.createdRaw && isoWeek(new Date(t.createdRaw)) === w).length });
    }
    return out;
  }
  const healthBadge = h => h.flags.length ? h.flags.map(f => `<span class="hb hb-${f}">${HEALTH[f].label}</span>`).join('') : '<span class="hb hb-ok">On track</span>';
  const ago = v => {
    if (!v) return '—';
    const days = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? days + ' days ago' : 'week ' + wnum(isoWeek(new Date(v)));
  };

  /** A compact project row (phone project list, manager table): health, counts, team. */
  function projectRowHtml(p, h) {
    const team = projectTeam(p.id).filter(m => m.active !== false);
    const n = (v, cls, label) => `<span class="pr-n ${cls}${v ? '' : ' zero'}" title="${label}">${v}<small>${label}</small></span>`;
    return `<button type="button" class="prow hk-${h.key}${S.project === p.id ? ' selected' : ''}" data-project="${esc(p.id)}">
      <span class="pr-main"><span class="pr-dot" aria-hidden="true"></span><strong>${esc(p.name)}</strong>
        <span class="pr-tags">${deptTag(p)}<span class="badge ${typeClass(p.type)}">${esc(p.type)}</span>${h.closed || p.status !== 'In Progress' ? `<span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>` : ''}${healthBadge(h)}</span></span>
      <span class="pr-nums">${n(h.blocked, 'bad', 'blocked')}${n(h.doing, '', 'open')}${n(h.done, 'ok', 'done')}${n(h.next, 'nx', 'next wk')}</span>
      <span class="pr-meta muted small">${projectLead(p) ? 'Lead: ' + esc(shortName(projectLead(p).name)) + ' · ' : ''}${team.length ? team.length + (team.length === 1 ? ' person' : ' people') : 'Nobody yet'} · ${ago(h.last)}${p.endDate ? ' · ends ' + esc(p.endDate) : ''}</span>
    </button>`;
  }

  // ---------- My week (the employee's home) ----------

  /** My tasks for the week (this week also shows my unfinished older tasks) and next week, grouped by project. */
  function viewWeek(root) {
    const week = S.mtgWeek, next = shiftWeek(week, 1);
    // Mine = assigned to me (or created by me with nobody assigned): the same rule as the meeting.
    const mine = S.data.tasks.filter(t => ownersOf(t).indexOf(me().id) !== -1 && inDept(project(t.projectId)));
    const inWeek = t => t.week === week || (week === THIS && t.week < week && !isDone(t));
    const rank = t => isBlocked(t) ? 0 : !isDone(t) && t.week < week ? 1 : isDone(t) ? 3 : 2;
    const section = (list, title, sub, empty) => {
      const groups = {};
      list.forEach(t => { (groups[t.projectId] = groups[t.projectId] || []).push(t); });
      const order = Object.keys(groups).sort((a, b) =>
        Math.min(...groups[a].map(rank)) - Math.min(...groups[b].map(rank)) || project(a).name.localeCompare(project(b).name));
      const open = list.filter(t => !isDone(t)).length;
      return `<section class="mw-sec"><h2 class="mw-title">${title} <small>${sub} · ${open} open${list.length - open ? ' · ' + (list.length - open) + ' done' : ''}</small></h2>
        ${order.map(pid => `<div class="card mw-group">
            <button type="button" class="mw-project" data-project="${esc(pid)}"><strong>${esc(project(pid).name)}</strong><span class="badge ${typeClass(project(pid).type)}">${esc(project(pid).type)}</span>${icon('chevron')}</button>
            ${groups[pid].sort((a, b) => rank(a) - rank(b)).map(t => taskHtml(t, true)).join('')}
          </div>`).join('') || `<div class="empty small-empty"><p>${empty}</p></div>`}
      </section>`;
    };
    // Carried 2+ weeks: one tap each to keep (moves it to this week), finish or drop it.
    const review = week === THIS ? mine.filter(t => !isDone(t) && t.week <= shiftWeek(THIS, -2)).sort((a, b) => a.week.localeCompare(b.week)) : [];
    const day = new Date().getDay();
    const planHint = week === THIS && (day === 0 || day >= 4) && !mine.some(t => t.week === next) && remember.get('plan-dismissed') !== next;
    root.innerHTML = `
      ${weekBar()}
      ${planHint ? `<div class="nudge" id="planNudge"><span><strong>Plan next week</strong><br>Nothing planned for week ${wnum(next)} yet. It goes straight into next week’s meeting.</span>
        <span class="nudge-actions"><button type="button" class="primary small" id="planNext">Plan week ${wnum(next)}</button><button type="button" class="text-btn" id="planLater">Later</button></span></div>` : ''}
      ${review.length ? `<section class="card review"><h3 class="card-title">Carried over 2+ weeks (${review.length})</h3>
        <p class="muted small" style="margin:0 0 8px">Still doing these? Keep them for this week, mark them done, or drop them.</p>
        ${review.map(t => `<div class="rv-row"><div class="rv-text"><strong>${esc(t.title)}</strong><small class="muted">${esc(project(t.projectId).name)} · since week ${wnum(t.week)}</small></div>
          <div class="rv-actions"><button type="button" class="secondary small-btn" data-keep-task="${t.id}">Keep</button><button type="button" class="primary small-btn" data-done-task="${t.id}">✓ Done</button>${t.createdBy === me().id || canManage(project(t.projectId).departmentId) ? `<button type="button" class="ghost danger-text small-btn" data-drop-task="${t.id}">Drop</button>` : ''}</div></div>`).join('')}
      </section>` : ''}
      <div class="mw-cols">
        ${section(mine.filter(inWeek), week === THIS ? 'This week' : 'Week ' + wnum(week), 'week ' + wnum(week), 'Nothing yet. Tap <b>Add a task</b> below.')}
        ${section(mine.filter(t => t.week === next), week === THIS ? 'Next week' : 'Week ' + wnum(next), 'plan · week ' + wnum(next), 'Nothing planned yet.')}
      </div>
      ${quickAddBar()}`;
    bindWeekBar(root); bindTasks(root); bindProjectLinks(root); bindQuickAdd(root);
    $$('[data-keep-task]', root).forEach(b => b.onclick = () => { updateTask(findTask(b.dataset.keepTask), { week: THIS }); toast('Kept for this week'); });
    $$('[data-done-task]', root).forEach(b => b.onclick = () => { updateTask(findTask(b.dataset.doneTask), { status: 'Done', week: THIS }); toast('Done ✔'); });
    $$('[data-drop-task]', root).forEach(b => b.onclick = async () => {
      if (!confirm('Drop this task? It is deleted.')) return;
      S.lastWrite = Date.now();
      if (await guard(() => Api.deleteTask(b.dataset.dropTask).then(() => true))) toast('Dropped');
      render();
    });
    const plan = $('#planNext', root); if (plan) plan.onclick = () => quickAddSheet({ week: next });
    const later = $('#planLater', root); if (later) later.onclick = () => { remember.set('plan-dismissed', next); render(); };
  }

  // ---------- Quick add (bottom bar → sheet) ----------

  /** The project ids used last on this device, most recent first. */
  function recentProjects() {
    let ids = [];
    try { ids = JSON.parse(remember.get('recent-projects') || '[]'); } catch (e) { ids = []; }
    return ids.filter(id => S.data.projects.some(p => p.id === id && inDept(p) && CLOSED.indexOf(p.status) === -1));
  }
  function rememberProject(id) {
    const ids = [id].concat(recentProjects().filter(x => x !== id)).slice(0, 6);
    remember.set('recent-projects', JSON.stringify(ids)); remember.set('last-project', id);
  }
  const quickAddBar = () => deptProjects().some(p => CLOSED.indexOf(p.status) === -1)
    ? `<div class="qa-bar no-print"><button type="button" class="qa-open" id="qaOpen">${icon('plus')} Add a task…</button></div>` : '';
  function bindQuickAdd(root) { const b = $('#qaOpen', root); if (b) b.onclick = () => quickAddSheet({}); }

  /**
   * The add sheet: what (title), where (project chips: recent ones, then "Other…"), when (this / next
   * week) and "already done". The project and week stay chosen for the next task ("Add" keeps the
   * sheet open), so logging several tasks is: type, Add, type, Add.
   */
  function quickAddSheet(opts) {
    const dlg = $('#dialog');
    const openP = p => (inDept(p) || crossDept()) && CLOSED.indexOf(p.status) === -1;   // a cross-project team can add to any project
    const qa = S.qa = S.qa || {};
    const recent = recentProjects();
    const chips = recent.concat(myProjects().filter(p => openP(p) && recent.indexOf(p.id) === -1).map(p => p.id)).slice(0, 4);
    if (opts.week) qa.week = opts.week;
    if (!qa.week || (qa.week !== THIS && qa.week !== NEXT)) qa.week = THIS;
    if (!qa.pid || !S.data.projects.some(p => p.id === qa.pid && openP(p))) qa.pid = recent[0] || (chips.length === 1 ? chips[0] : '');
    const others = S.data.projects.filter(p => openP(p) && chips.indexOf(p.id) === -1).sort((a, b) => a.name.localeCompare(b.name));
    const manager = canManage(curDept());
    const draw = () => {
      dlg.innerHTML = `<form class="sheet qa-sheet" id="qaForm">
        <header class="sheet-head"><button type="button" class="text-btn" data-close>Close</button><h3>Add a task</h3><button type="submit" class="text-btn strong">Add</button></header>
        <div class="sheet-body">
          <textarea name="title" rows="2" maxlength="300" placeholder="${qa.week === NEXT ? 'Next week, e.g. Loop check LCP-02 with the client' : 'e.g. Commission AHU-3 controller on level 2'}" aria-label="Task" required></textarea>
          <p class="qa-label">Project</p>
          <div class="chips qa-chips">${chips.map(id => `<button type="button" class="chip${qa.pid === id ? ' on' : ''}" data-qp="${esc(id)}">${esc(project(id).name)}</button>`).join('')}
            <select class="qa-other${qa.pid && chips.indexOf(qa.pid) === -1 ? ' on' : ''}" name="other" aria-label="Other project"><option value="">${chips.length ? 'Other…' : 'Choose a project…'}</option>${others.map(p => `<option value="${esc(p.id)}"${p.id === qa.pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
          <p class="qa-label">When</p>
          <div class="chips qa-chips">
            <button type="button" class="chip${qa.week === THIS ? ' on' : ''}" data-qw="${THIS}">This week · ${wnum(THIS)}</button>
            <button type="button" class="chip${qa.week === NEXT ? ' on' : ''}" data-qw="${NEXT}">Next week · ${wnum(NEXT)}</button>
            ${qa.week === THIS ? `<button type="button" class="chip done-chip${qa.done ? ' on' : ''}" data-qd>✓ Already done</button>` : ''}
          </div>
          ${manager ? `<select class="qa-for" name="person" aria-label="Who the task is for">${personChoices(S.data.team)}</select>` : ''}
          <p class="muted small qa-hint">Tap <b>Add</b> and type the next one. The project and week stay chosen.</p>
        </div></form>`;
      const f = $('#qaForm', dlg);
      const keep = () => ({ title: f.elements.title.value, person: f.elements.person ? f.elements.person.value : '' });
      const redraw = () => { const k = keep(); draw(); const f2 = $('#qaForm', dlg); f2.elements.title.value = k.title; if (f2.elements.person) f2.elements.person.value = k.person || me().id; f2.elements.title.focus(); };
      $$('[data-qp]', f).forEach(b => b.onclick = () => { qa.pid = b.dataset.qp; redraw(); });
      f.elements.other.onchange = () => { if (f.elements.other.value) { qa.pid = f.elements.other.value; redraw(); } };
      $$('[data-qw]', f).forEach(b => b.onclick = () => { qa.week = b.dataset.qw; if (qa.week !== THIS) qa.done = false; redraw(); });
      const dn = $('[data-qd]', f); if (dn) dn.onclick = () => { qa.done = !qa.done; redraw(); };
      $('[data-close]', f).onclick = () => dlg.close();
      f.onsubmit = async e => {
        e.preventDefault();
        const title = f.elements.title.value.replace(/\s+/g, ' ').trim();
        if (!title) { f.elements.title.focus(); return; }
        if (!qa.pid) { toast('Choose the project', true); return; }
        const forId = f.elements.person ? f.elements.person.value : me().id;
        const btn = $('button[type=submit]', f); btn.disabled = true;
        S.lastWrite = Date.now();
        const saved = await guard(() => Api.addTask({ projectId: qa.pid, week: qa.week, title: title, status: qa.done ? 'Done' : 'To Do',
          team: member(forId).team || '', assigneeIds: [forId], contactIds: [], subtasks: [],
          createdBy: forId === me().id ? undefined : forId }));
        btn.disabled = false;
        if (!saved) return;
        rememberProject(qa.pid);
        toast((qa.done ? 'Logged as done' : 'Added') + ' · ' + project(qa.pid).name + (forId === me().id ? '' : ' · for ' + shortName(member(forId).name)));
        f.elements.title.value = '';
        f.elements.title.focus();
        softRender();
      };
    };
    delete dlg.dataset.mode;
    dlg.dataset.mode = 'add';
    draw();
    if (!dlg.open) dlg.showModal();
    $('#qaForm textarea', dlg).focus();
  }

  // ---------- Projects (browse; open one in the side panel) ----------

  function viewProjectList(root) {
    const week = S.mtgWeek;
    const m = buildMinutes(week);
    const scope = S.pscope || (remember.get('pscope') === 'all' || !myProjectIds().some(id => inDept(project(id))) ? 'all' : 'mine');
    const wide = !isPhone();
    const layout = wide ? boardLayout() : 'list';
    document.body.dataset.layout = layout === 'cards' ? 'cards' : 'list';
    const q = S.cardFilter.trim().toLowerCase();
    let body, tools = '', field = null;
    if (layout === 'cards') {
      const c = cardsBoard(m.rows, week, scope);
      body = c.html; tools = c.tools; field = c.field;
    } else {
      const byId = {}; m.rows.forEach(r => { byId[r.id] = r; });
      const list = boardProjects(byId, scope).filter(p => !q || (p.name + ' ' + p.client + ' ' + p.type + ' ' + p.id).toLowerCase().indexOf(q) !== -1);
      const withH = list.map(p => ({ p: p, h: healthOf(p, week) }));
      withH.sort((a, b) => HEALTH[a.h.key].rank - HEALTH[b.h.key].rank || a.p.name.localeCompare(b.p.name));
      tools = `<div class="cards-tools no-print"><input type="search" id="cardFilter" class="search" placeholder="Find a project" value="${esc(S.cardFilter)}" data-keep="card-filter" autocomplete="off"></div>`;
      body = `<div class="prows">${withH.map(x => projectRowHtml(x.p, x.h)).join('') || `<div class="empty"><h3>${q ? 'No projects match' : 'No projects to show'}</h3></div>`}</div>`;
    }
    root.innerHTML = `
      ${weekBar()}
      <div class="board-tools no-print">
        <div class="seg board-seg"><button type="button" data-scope="mine" class="${scope === 'mine' ? 'on' : ''}">My projects</button><button type="button" data-scope="all" class="${scope === 'all' ? 'on' : ''}">All projects</button></div>
        ${wide ? `<div class="seg layout-seg" aria-label="Layout"><button type="button" data-layout="cards" class="${layout === 'cards' ? 'on' : ''}">Board</button><button type="button" data-layout="list" class="${layout === 'list' ? 'on' : ''}">List</button></div>` : ''}
      </div>
      ${tools}
      ${body}
      ${S.project ? '' : quickAddBar()}`;
    bindWeekBar(root);
    $$('[data-scope]', root).forEach(b => b.onclick = () => { S.pscope = b.dataset.scope; remember.set('pscope', S.pscope); render(); });
    $$('[data-layout]', root).forEach(b => b.onclick = () => { S.layout = b.dataset.layout; remember.set('layout', S.layout); render(); });
    if (layout === 'cards') bindCards(root, field);
    else {
      const f = $('#cardFilter', root);
      if (f) f.oninput = () => { S.cardFilter = f.value; const pos = f.selectionStart; render(); const f2 = $('#cardFilter'); if (f2) { f2.focus(); f2.setSelectionRange(pos, pos); } };
    }
    bindProjectLinks(root); bindQuickAdd(root);
  }

  // ---------- Workload (managers): who carries how much ----------

  /**
   * One row per person in the department (or on one of its open projects): open projects, this
   * week's open / blocked / carried tasks, next week planned, last update. Overloaded = on at least
   * 10 open projects and twice the team's median.
   */
  function workloadHtml(week) {
    const openP = deptProjects().filter(p => CLOSED.indexOf(p.status) === -1);
    const openIds = openP.map(p => p.id);
    const people = S.data.team.filter(m => m.active && (m.departmentId === curDept() || S.data.assignments.some(a => a.userId === m.id && openIds.indexOf(a.projectId) !== -1)));
    const rows = people.map(m => {
      const ts = S.data.tasks.filter(t => ownersOf(t).indexOf(m.id) !== -1 && inDept(project(t.projectId)));
      const cur = ts.filter(t => !isDone(t) && (t.week === week || (week === THIS && t.week < week)));
      return { m: m, projects: S.data.assignments.filter(a => a.userId === m.id && openIds.indexOf(a.projectId) !== -1).length,
        open: cur.length, blocked: cur.filter(isBlocked).length, carried: cur.filter(t => t.week < week).length,
        done: ts.filter(t => isDone(t) && t.week === week).length, next: ts.filter(t => t.week === shiftWeek(week, 1)).length,
        last: ts.reduce((x, t) => t.version && t.version > x ? t.version : x, '') };
    });
    const sorted = rows.map(r => r.projects).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const heavy = r => r.projects >= 10 && r.projects >= 2 * Math.max(1, median);
    const units = Array.from(new Set(rows.map(r => r.m.unit || 'Other'))).sort();
    const shown = rows.filter(r => !S.unitFilter || (r.m.unit || 'Other') === S.unitFilter)
      .sort((a, b) => b.projects - a.projects || b.open - a.open || a.m.name.localeCompare(b.m.name));
    const n = (v, cls) => `<td class="${cls || ''}${v ? '' : ' zero'}">${v}</td>`;
    return { keys: [], html: `<div class="card workload">
      <div class="wl-head"><p class="muted small">Sorted by open projects. ${rows.filter(heavy).length ? `<b class="wl-heavy-note">${rows.filter(heavy).length} overloaded</b> (10+ projects and twice the team’s usual ${median}).` : `Team’s usual: ${median} projects each.`}</p>
        ${units.length > 1 ? `<select id="unitFilter" aria-label="Team"><option value="">All teams</option>${units.map(u => `<option${S.unitFilter === u ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}</div>
      <div class="wl-scroll"><table class="wl-table"><thead><tr><th>Person</th><th>Projects</th><th>Open</th><th>Blocked</th><th>Carried</th><th>Done</th><th>Next week</th><th>Last update</th></tr></thead>
      <tbody>${shown.map(r => `<tr class="${heavy(r) ? 'heavy' : ''}"><td><strong>${esc(r.m.name)}</strong>${heavy(r) ? ' <span class="hb hb-blocked">Overloaded</span>' : ''}<br><small class="muted">${esc(personInfo(r.m) || '')}</small></td>
        ${n(r.projects, 'big')}${n(r.open)}${n(r.blocked, 'bad')}${n(r.carried, 'warn')}${n(r.done, 'ok')}${n(r.next)}<td class="muted small">${ago(r.last)}</td></tr>`).join('')}</tbody></table></div></div>` };
  }

  // ---------- Meeting (managers): health, blocked, no update, minutes ----------

  function viewMeeting(root) {
    const week = S.mtgWeek;
    const key = mkey(week);
    if (!(key in S.minutes)) loadMinutes(week);
    const saved = S.minutes[key];
    const hasSaved = !!(saved && saved.snapshot);
    const manager = canManage(curDept());
    const m = buildMinutes(week);
    const projects = deptProjects().filter(p => CLOSED.indexOf(p.status) === -1 || m.rows.some(r => r.id === p.id && !r.silent))
      .map(p => ({ p: p, h: healthOf(p, week) }));
    const count = f => projects.filter(x => !S.leadFilter || (projectLead(x.p) || {}).id === S.leadFilter).filter(x => f === 'all' ? true : f === 'ok' ? !x.h.flags.length : x.h.flags.indexOf(f) !== -1).length;
    const filter = S.hfilter || 'all';
    const leads = Array.from(new Set(projects.map(x => projectLead(x.p)).filter(Boolean))).sort((a, b) => a.name.localeCompare(b.name));
    const byLead = x => !S.leadFilter || (projectLead(x.p) || {}).id === S.leadFilter;
    const shown = projects.filter(byLead).filter(x => filter === 'all' || (filter === 'ok' ? !x.h.flags.length : x.h.flags.indexOf(filter) !== -1))
      .sort((a, b) => HEALTH[a.h.key].rank - HEALTH[b.h.key].rank || (a.h.last < b.h.last ? 1 : -1));
    const quiet = week <= THIS ? quietPeople(week) : [];
    const chip = (f, label, cls) => `<button type="button" class="hchip${filter === f ? ' on' : ''} ${cls || ''}" data-hf="${f}"><b>${count(f)}</b> ${label}</button>`;
    const savedBy = hasSaved ? `${esc(saved.savedAt)}${saved.savedBy ? ' by ' + esc(member(saved.savedBy).name) : ''}` : '';
    const note = hasSaved
      ? `<div class="mtg-note saved"><span>Minutes for week ${wnum(week)} saved ${savedBy}</span><button type="button" class="secondary small-btn" id="viewSaved">View saved copy</button></div>`
      : week < THIS && saved === null ? '<div class="mtg-note warn"><span>Not saved. This is rebuilt from today’s tasks, so it may differ from what was discussed.</span></div>' : '';
    const pr = { High: 0, Medium: 1, Low: 2 };
    const blocked = S.data.tasks.filter(t => isBlocked(t) && inDept(project(t.projectId)) && relevant(t) && (t.week === week || (week === THIS && t.week < week)))
      .sort((a, b) => a.week.localeCompare(b.week) || (pr[project(a.projectId).priority] || 1) - (pr[project(b.projectId).priority] || 1));
    const units = {};
    quiet.forEach(q => { (units[q.m.unit || 'Other'] = units[q.m.unit || 'Other'] || []).push(q); });
    const detail = S.mdetail || 'project';
    const rowsWithTasks = m.rows.filter(r => !r.silent);
    const cards = detail === 'person' ? personCards(rowsWithTasks, week, true) : detail === 'load' ? workloadHtml(week) : projectCards(rowsWithTasks, week, true, 'active');
    root.innerHTML = `
      ${weekBar()}
      <div class="actions-row no-print"><button type="button" class="primary" id="copyEmail">Copy as email</button><button type="button" class="secondary" id="printMom">Print / PDF</button>${manager && week <= THIS ? `<button type="button" class="secondary" id="saveMins">${hasSaved ? 'Update saved minutes' : 'Save minutes'}</button>` : ''}<button type="button" class="ghost" id="archiveBtn">Past minutes</button></div>
      ${note}
      <div class="mtg-layout">
        <div class="mtg-main">
          ${leads.length > 1 ? `<label class="lead-filter no-print">Lead <select id="leadFilter"><option value="">Everyone</option>${leads.map(l => `<option value="${esc(l.id)}"${S.leadFilter === l.id ? ' selected' : ''}>${esc(l.name)} (${projects.filter(x => (projectLead(x.p) || {}).id === l.id).length})</option>`).join('')}</select></label>` : ''}
          <div class="hchips no-print">${chip('all', 'projects')}${chip('blocked', 'blocked', 'bad')}${chip('late', 'past end date', 'bad')}${chip('stale', 'carried 2+ weeks', 'warn')}${chip('quiet', 'no update', 'warn')}${chip('ok', 'on track', 'ok')}</div>
          <p class="muted small mtg-sum-line">${m.summary.moved} ${m.summary.moved === 1 ? 'project' : 'projects'} moved this week · ${m.summary.done} ${m.summary.done === 1 ? 'task' : 'tasks'} done · ${m.summary.blocked} blocked · ${quiet.length} ${quiet.length === 1 ? 'person' : 'people'} with no update</p>
          <div class="prows htable">${shown.map(x => projectRowHtml(x.p, x.h)).join('') || '<div class="empty"><h3>Nothing here</h3></div>'}</div>
        </div>
        <aside class="mtg-side">
          <section class="card warn"><h3 class="card-title">Blocked (${blocked.length})</h3>
            ${blocked.length ? `<ul class="plain blk-list">${blocked.slice(0, S.blockedAll ? blocked.length : 6).map(t => `<li><button type="button" class="blk-item" data-project="${esc(t.projectId)}" data-open-task="${esc(t.id)}">
              <strong>${esc(t.title)}</strong><span class="muted small">${esc(project(t.projectId).name)} · ${esc(who(t) || member(t.createdBy).name)}</span>
              <span class="small"><span class="since">since week ${wnum(t.week)}</span> · ${t.blockNote ? esc(t.blockNote) : '<span class="no-reason">no reason given</span>'}</span></button></li>`).join('')}</ul>
              ${blocked.length > 6 ? `<button type="button" class="text-btn" id="blockedAll">${S.blockedAll ? 'Show fewer' : 'Show all ' + blocked.length}</button>` : ''}` : '<p class="muted small">Nothing blocked.</p>'}
          </section>
          ${week <= THIS ? `<section class="card quiet"><h3 class="card-title">No update ${week === THIS ? 'yet' : ''} (${quiet.length})</h3>
            ${quiet.length ? `<p class="muted small" style="margin:0 0 8px">Nothing of theirs added or changed in week ${wnum(week)}.</p>
              ${Object.keys(units).sort().map(u => `<p class="q-unit">${esc(u)}</p><ul class="plain q-list">${units[u].map(q => `<li><span>${esc(q.m.name)}${q.onProject ? '' : ' <small class="muted">· on no project</small>'}</span><small class="muted">${q.last ? 'last ' + ago(q.last) : 'never'}</small></li>`).join('')}</ul>`).join('')}
              ${week === THIS ? '<button type="button" class="secondary small-btn" id="copyReminder">Copy reminder</button>' : ''}` : '<p class="muted small">Everyone has updated.</p>'}
          </section>` : ''}
        </aside>
      </div>
      <div class="board-tools no-print mtg-detail-tools">
        <h3 class="mtg-detail-title">Walk through the week</h3>
        <div class="seg board-seg"><button type="button" data-detail="project" class="${detail === 'project' ? 'on' : ''}">By project</button><button type="button" data-detail="person" class="${detail === 'person' ? 'on' : ''}">By person</button><button type="button" data-detail="load" class="${detail === 'load' ? 'on' : ''}">Workload</button></div>
        ${detail === 'load' ? '' : '<span class="fold-all"><button type="button" class="text-btn" id="unfoldAll">Expand all</button><button type="button" class="text-btn" id="foldAll">Collapse all</button></span>'}
      </div>
      ${detail === 'load' ? cards.html : `<div class="board-grid">${cards.html}</div>`}`;
    document.body.dataset.layout = 'list';
    bindWeekBar(root);
    $$('[data-hf]', root).forEach(b => b.onclick = () => { S.hfilter = b.dataset.hf === S.hfilter ? 'all' : b.dataset.hf; render(); });
    $$('[data-detail]', root).forEach(b => b.onclick = () => { S.mdetail = b.dataset.detail; render(); });
    $$('[data-fold]', root).forEach(b => b.onclick = () => { setCollapsed([b.dataset.fold], !collapsed()[b.dataset.fold]); render(); });
    const fa = $('#foldAll', root); if (fa) fa.onclick = () => { setCollapsed(cards.keys, true); render(); };
    const ua = $('#unfoldAll', root); if (ua) ua.onclick = () => { setCollapsed(cards.keys, false); render(); };
    const lf = $('#leadFilter', root); if (lf) lf.onchange = () => { S.leadFilter = lf.value || null; render(); };
    const uf = $('#unitFilter', root); if (uf) uf.onchange = () => { S.unitFilter = uf.value || null; render(); };
    const ba = $('#blockedAll', root); if (ba) ba.onclick = () => { S.blockedAll = !S.blockedAll; render(); };
    $$('[data-open-task]', root).forEach(b => b.addEventListener('click', () => { S.open[b.dataset.openTask] = true; }, true));
    // Phone: tabs above each project's two weeks jump between them; the tab follows a swipe
    $$('.wk2', root).forEach(g => {
      const tabs = g.previousElementSibling && g.previousElementSibling.classList.contains('wk-tabs') ? $$('button', g.previousElementSibling) : [];
      if (!tabs.length) return;
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
    const remind = $('#copyReminder', root);
    if (remind) remind.onclick = () => copyText(
      'Hi ' + quiet.map(x => x.m.name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0]).join(', ') +
      ' — please add your tasks for week ' + wnum(week) + ' in Weekly Tasks before the meeting: ' + location.origin + location.pathname,
      'Reminder copied — paste it into your team chat');
    const view = $('#viewSaved', root); if (view) view.onclick = () => savedMinutesSheet(saved);
    const save = $('#saveMins', root);
    if (save) save.onclick = async () => {
      if (hasSaved && !confirm('Replace the saved minutes for week ' + wnum(week) + ' with today’s tasks?')) return;
      save.disabled = true;
      const rec = await guard(() => Api.saveMinutes(week, buildMinutes(week), curDept()));
      save.disabled = false;
      if (rec) { S.minutes[key] = rec; toast('Minutes saved'); render(); }
    };
    bindProjectLinks(root); bindTasks(root);
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
    const since = it => it.kind === 'doing' && it.week && it.week < week ? ' (since week ' + wnum(it.week) + ')' : '';
    const item = (it, prefix) => `<li style="margin-bottom:6px">${prefix}${esc(it.title)} "${esc(it.who)}"${esc(since(it))}${it.blocked ? ' <b style="color:#CB2150">(blocked: ' + esc(it.note || 'no reason given') + ')</b>' : ''}</li>`;
    const sm = m.summary || {};
    const summary = sm.moved !== undefined ? `${sm.moved} projects moved · ${sm.done} tasks done · ${sm.blocked} blocked` + (sm.silent ? ` · ${sm.silent} with no update` : '') : '';
    const blocked = m.blocked || [];
    const status = r => (r.health ? r.health + ' · ' : '') + r.status;
    // Projects with an update first; projects with no update at the end.
    const ordered = rows.filter(r => !r.silent).concat(rows.filter(r => r.silent));
    const list = c => {
      const items = c.done.map(it => item(it, '✔ ')).concat(c.doing.map(it => item(it, ''))).concat(c.next.map(it => item(it, 'Next week: ')));
      return '<ul style="margin:0;padding-left:18px">' + (items.length ? items.join('') : '<li>-</li>') + '</ul>';
    };
    const html = `<div style="max-width:1100px;font-family:Arial,Helvetica,sans-serif;color:#191919">
      <h2 style="text-align:center;margin:0 0 4px">${esc(title)}</h2>
      <p style="text-align:center;margin:0 0 6px;color:#6B6862;font-weight:bold">Week ${wnum(week)} · ${esc(weekRange(week))} ${weekMonday(week).getUTCFullYear()}</p>
      ${summary ? `<p style="text-align:center;margin:0 0 16px;color:#191919">${esc(summary)}</p>` : ''}
      ${blocked.length ? `<div style="border:1px solid #F3C2CF;background:#FCEEF2;border-radius:8px;padding:10px 14px;margin:0 0 16px"><b style="color:#CB2150">Blocked (${blocked.length})</b>
        <ul style="margin:6px 0 0;padding-left:18px">${blocked.map(it => `<li style="margin-bottom:4px"><b>${esc(it.title)}</b> — ${esc(it.project)} — ${esc(it.who)} — since week ${wnum(it.week)} — ${esc(it.note || 'no reason given')}</li>`).join('')}</ul></div>` : ''}
      <table style="width:100%;border-collapse:collapse" width="100%">
        <thead><tr><th style="${head}">Project Name</th>${teams.map(k => `<th style="${head}">${esc(k)} Team Action Plan</th>`).join('')}<th style="${head}width:15%">Overall Status</th></tr></thead>
        <tbody>${ordered.map((r, i) => `<tr style="background:${i % 2 ? '#F7F5F2' : '#ffffff'}"><td style="${cell}font-weight:bold;color:#CB2150">${esc(r.name)}</td>
          ${r.silent ? `<td style="${cell}color:#B4560F" colspan="${teams.length}"><i>No update this week</i></td>` : teams.map(k => `<td style="${cell}">${list(r.cols[k] || none)}</td>`).join('')}<td style="${cell}font-weight:bold">${esc(status(r))}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const text = [title + ' — ' + weekLabel(week)].concat(summary ? [summary] : [], [''],
      blocked.length ? ['Blocked (' + blocked.length + '):'].concat(blocked.map(it => '  - ' + it.title + ' — ' + it.project + ' — ' + it.who + ' — since week ' + wnum(it.week) + ' — ' + (it.note || 'no reason given')), ['']) : [])
      .concat(ordered.map(r => r.silent ? r.name + ' — ' + status(r) : [r.name + ' — ' + status(r)].concat(teams.map(k => {
      const c = r.cols[k] || none;
      const items = c.done.map(it => '✔ ' + it.title).concat(c.doing.map(it => it.title + since(it) + (it.blocked ? ' (blocked: ' + (it.note || '-') + ')' : ''))).concat(c.next.map(it => 'Next week: ' + it.title));
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
        // Options may carry a `group` (shown as a sub-heading) and a `hint` (shown under the name).
        let last = null;
        const items = f.options.length ? f.options.map(o => {
          const head = o.group !== undefined && o.group !== last ? `<p class="check-group">${esc(o.group)}</p>` : '';
          last = o.group;
          return `${head}<label class="check row"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"${sel.indexOf(o.value) !== -1 ? ' checked' : ''}>
            <span class="avatar sm">${esc(initials(o.label))}</span><span class="check-label">${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`;
        }).join('') : '<p class="muted">Nobody on the team yet.</p>';
        return `<fieldset class="field${wide}"><legend>${esc(f.label)}</legend><div class="checklist">${items}</div></fieldset>`;
      }
      // f.list: suggest the values other people already have (e.g. org-chart teams), so they stay consistent.
      const dl = f.list ? `<datalist id="${f.list}">${Array.from(new Set(S.data.team.map(m => m[f.name]).filter(Boolean))).sort().map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : '';
      return `<label class="field${wide}" for="${id}">${esc(f.label)}<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}"${req}${f.readonly ? ' readonly' : ''}${f.list ? ` list="${f.list}" autocomplete="off"` : ''}${f.type === 'password' ? ' autocomplete="new-password"' : ''}>${dl}</label>`;
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
          options: groupPeople(S.data.team.filter(m => m.active), d.id)
            .reduce((a, g) => a.concat(g.people.map(m => ({ value: m.id, label: m.name, hint: m.title, group: g.label }))), []) },
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
    const q = (S.teamSearch || '').toLowerCase();
    const people = S.data.team.filter(m => m.departmentId === d.id &&
      (!q || (m.name + ' ' + m.username + ' ' + m.title + ' ' + m.unit).toLowerCase().indexOf(q) !== -1));
    const card = m => {
      const n = S.data.assignments.filter(a => a.userId === m.id).length;
      return `
        <button type="button" class="card list-card member${m.active ? '' : ' inactive'}" data-edit="${esc(m.id)}">
          <span class="avatar">${esc(initials(m.name))}</span>
          <span class="member-info"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.title || m.username)}</span></span>
          <span class="member-side">${!subTeams ? '' : m.team ? `<span class="badge">${esc(m.team)}</span>` : '<span class="badge off">No team</span>'}${m.role !== 'Member' ? `<span class="badge">${esc(m.role)}</span>` : ''}${m.active ? '' : '<span class="badge off">Inactive</span>'}<small class="muted">${n} project${n === 1 ? '' : 's'}</small></span>
        </button>`;
    };
    // One section per org-chart team (e.g. "B.A Execution Team B", "Back Office").
    root.innerHTML = `<input type="search" class="search" id="teamSearch" placeholder="Search people, titles or teams" value="${esc(S.teamSearch || '')}">
      ${groupPeople(people, d.id).map(g => `<h4 class="team-group">${esc(g.label)} <span>${g.people.length}</span></h4>
        <div class="grid">${g.people.map(card).join('')}</div>`).join('')
      || `<div class="empty"><h3>${q ? 'Nobody matches' : 'Nobody in ' + esc(d.name) + ' yet'}</h3>${q ? '' : '<p>Tap <b>+ Member</b> to add someone.</p>'}</div>`}`;
    const search = $('#teamSearch', root);
    search.addEventListener('input', () => {
      S.teamSearch = search.value;
      const pos = search.selectionStart;
      renderTeam(root);
      const s2 = $('#teamSearch', root); s2.focus(); s2.setSelectionRange(pos, pos);
    });
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
        { name: 'title', label: 'Job title (e.g. BMS Engineer)' },
        { name: 'unit', label: 'Org-chart team (groups people in lists)', list: 'unitList' },
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
            <div><strong>${esc(me().name)}</strong><br><span class="muted">${me().title ? esc(me().title) + '<br>' : ''}${esc(me().username)} · ${esc(me().role)}${manyDepts() ? ' · ' + esc(dept(me().departmentId).name) : ''}</span></div></div>
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

  // Three screens (bottom bar on a phone, tabs on a computer); Manage is behind the settings button.
  const TABS = [
    { id: 'week', label: 'My week', icon: 'tasks', view: viewWeek },
    { id: 'projects', label: 'Projects', icon: 'projects', view: viewProjectList },
    { id: 'meeting', label: 'Meeting', icon: 'meeting', view: viewMeeting, manager: true },
    { id: 'manage', label: 'Manage', view: viewManage, manager: true, hidden: true },
  ];

  /** The screen in the address (#/week, #/projects, #/meeting, #/manage); managers start on Meeting. */
  function currentTab() {
    const allowed = TABS.filter(t => !t.manager || isManager());
    const id = location.hash.replace(/^#\/?/, '').replace(/^tasks$/, 'week') || (isManager() ? 'meeting' : 'week');
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
    $('#appnav').innerHTML = TABS.filter(t => !t.hidden && (!t.manager || isManager())).map(t =>
      `<a href="#/${t.id}" class="${t.id === tab.id ? 'on' : ''}"${t.id === tab.id ? ' aria-current="page"' : ''}>${icon(t.icon)}<span>${t.label}</span></a>`).join('');
    // Text half-typed into an "add" box survives the redraw (e.g. ticking a task meanwhile).
    const kept = {};
    const keepSel = '#view [data-keep], #dialog[data-mode="task"] [data-keep]';
    $$(keepSel).forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    tab.view($('#view'));
    if (tab.id !== 'manage') renderPanel($('#view')); else document.body.classList.remove('panel-open');
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
    // Esc closes the project panel (unless a form or sheet is open over it).
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.project && !$('#dialog').open) { e.preventDefault(); closePanel(); }
    });
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
