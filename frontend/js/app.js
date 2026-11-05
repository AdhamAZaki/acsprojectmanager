// ACS Weekly Tasks: UI. Plain JS, no build step. Mobile-first.
// Three pages, nothing in two places:
//   My tasks  (everyone): your own tasks, this week and next, by project or as a board.
//   Team      (admins and department admins): the weekly meeting. Filter by week, team, person;
//             look at it by project, as a board, by person or as a table; email and save minutes.
//   Projects  (everyone): every project and the teams on it; join one or add a task to it.
//   Manage    (admins and department admins): people, projects, departments, 3rd parties.
// Projects are shared by every team (PLC, AVEVA, BMS, UI/UX, Dev, ...). Employees see only their
// own tasks (the database enforces it); admins see everything, department admins their department
// first and the rest one filter away.
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
    which: 'this',       // project panel: 'this' or 'next' week
    open: {},            // expanded task rows
    project: null,       // project open in the side panel
    mtgWeek: THIS,       // the week the project panel's history ends on
    manageTab: 'people',
    projectFilter: 'open',
    lastProject: null,
    lastWrite: 0,
    minutes: {},         // saved minutes per department and week: record, null (none saved) or undefined (loading)
    addWeek: null,       // week picked in the project panel's add box
    collapsed: null,
    sheetTask: null,     // task open in the bottom sheet (phone, board, table)
    peopleOpen: {},      // task id -> its People section is unfolded
    teamOpen: false,     // project panel: Team section unfolded
    qa: null,            // quick add: project and week kept between adds
    search: {},          // search box text per page
    myWeek: 'now',       // My tasks: 'now' (this + next week) or one week
    myLayout: null,      // My tasks: 'project' | 'board'; remembered per device
    teamWeek: 'now',     // Team: 'now' or one week
    teamLayout: null,    // Team: 'project' | 'board' | 'person' | 'table'; remembered per device
    tfilter: null,       // Team: 'all' | 'dept:<id>' | 'team:<dept>:<team>' | 'team:MGMT'
    who: 'all',          // Team: one person
    tscope: 'ours',      // Team: 'ours' (projects the filter's people are on) | 'all'
    showOthers: {},      // project id -> other teams' tasks unfolded
    showQuiet: false,    // projects with no tasks unfolded
    sort: 'project',     // Team table
    pstatus: 'open',     // Projects: 'open' | 'closed' | 'all'
    mteam: 'all',        // Manage › People: one team
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

  // ---------- Departments and teams ----------

  /** Admins manage every department; a "Dept admin" only their own. */
  const canManage = deptId => isAdmin() || (!!S.data && me().role === 'Dept admin' && me().departmentId === deptId);
  const isManager = () => isAdmin() || (!!S.data && me().role === 'Dept admin');
  const departments = () => S.data.departments && S.data.departments.length ? S.data.departments
    : [{ id: 'AUTO', name: 'Automation', teams: ['PLC', 'Dev'], projectTypes: PROJECT_TYPES }];
  const dept = id => departments().find(d => d.id === id) || departments()[0];
  const manyDepts = () => departments().length > 1;
  /** A department's teams (the columns of its meeting email); one column named after it if it has none. */
  const deptTeams = id => dept(id).teams.length ? dept(id).teams : [dept(id).name];
  /**
   * Teams are "<department>:<team>" keys, e.g. AUTO:PLC, AUTO:Dev (shown as AVEVA), BMS:BMS,
   * GUI:UI/UX, GUI:Dev. Admins are in their own "Management" team.
   */
  const MGMT = 'MGMT';
  const teamKeys = () => departments().reduce((a, d) => a.concat(deptTeams(d.id).map(c => d.id + ':' + c)), []).concat(MGMT);
  function teamKeyOf(m) {
    if (m.role === 'Admin') return MGMT;
    const cols = deptTeams(m.departmentId);
    return dept(m.departmentId).id + ':' + (cols.indexOf(m.team) !== -1 ? m.team : cols[0]);
  }
  function teamLabel(key) {
    if (key === MGMT) return 'Management';
    const d = key.slice(0, key.indexOf(':')), t = key.slice(key.indexOf(':') + 1);
    return d === 'AUTO' && t === 'Dev' ? 'AVEVA' : t;   // Automation's Dev team is the AVEVA team
  }
  const teamChip = (key, mine) => `<span class="tchip tc-${slug(teamLabel(key))}${mine ? ' mine' : ''}"><i></i>${esc(teamLabel(key))}</span>`;
  const myTeamKey = () => teamKeyOf(me());
  /** A task's team: the team of the person it belongs to. */
  const taskTeam = t => teamKeyOf(member(ownersOf(t)[0]));
  /** Teams on a project: the teams of the people on it and of the people with tasks in it. */
  function teamsOnProject(pid) {
    const keys = new Set(projectTeam(pid).filter(m => m.active !== false && m.id).map(teamKeyOf));
    S.data.tasks.forEach(t => { if (t.projectId === pid) keys.add(taskTeam(t)); });
    return teamKeys().filter(k => keys.has(k));
  }

  /** The Team page's filter: admins start on every team, a department admin on their department. */
  const teamFilter = () => S.tfilter || (isAdmin() ? 'all' : 'dept:' + me().departmentId);
  function teamMatch(key) {
    const f = teamFilter();
    if (f === 'all') return true;
    if (f.indexOf('dept:') === 0) return key.indexOf(f.slice(5) + ':') === 0;
    return key === f.slice(5);
  }
  /** The department whose minutes the Team page shows: the one picked in the Team filter, if any. */
  function filterDept() {
    const f = teamFilter();
    if (f.indexOf('dept:') === 0) return f.slice(5);
    if (f.indexOf('team:') === 0 && f !== 'team:' + MGMT) return f.slice(5, f.indexOf(':', 5));
    return null;
  }
  /** The department of the minutes being built or shown. */
  const curDept = () => filterDept() || me().departmentId;
  /** In a department's minutes, only its own people's tasks count. */
  const relevant = t => ownersOf(t).some(id => member(id).departmentId === curDept());
  /** A department's projects: first entered by it, or its people are on it or have tasks in it. */
  function deptProjects() {
    const d = curDept();
    const ids = new Set(S.data.projects.filter(p => p.departmentId === d).map(p => p.id));
    S.data.assignments.forEach(a => { if (member(a.userId).departmentId === d) ids.add(a.projectId); });
    S.data.tasks.forEach(t => { if (relevant(t)) ids.add(t.projectId); });
    return S.data.projects.filter(p => ids.has(p.id));
  }
  /** Dept admins (and admins) lead the people of their department, on any project. */
  const leadsPerson = id => isAdmin() || (me().role === 'Dept admin' && member(id).departmentId === me().departmentId);
  const leadsTask = t => isAdmin() || (me().role === 'Dept admin' && (ownersOf(t).concat(t.createdBy).some(id => member(id).departmentId === me().departmentId)));

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
  /** Own tasks only: you change tasks you created or are on; a department admin their people's; admins any. */
  const canEditTask = t => leadsTask(t) || t.createdBy === me().id || t.assigneeIds.indexOf(me().id) !== -1;
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
    const edit = canEditTask(t), full = isAdmin(), admin = full || leadsTask(t);
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
    if (!t) {
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
    const [from, to] = isManager() ? [-4, 8] : [-1, 1];
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
    return `<option value="${esc(me().id)}">Me</option>` + peopleOptions(list, curDept());
  }
  /** Project picker: my projects first, then every other open project of the department (anyone can add to any project). */
  function projectChoices() {
    const open = p => CLOSED.indexOf(p.status) === -1;
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
    if (week < shiftWeek(THIS, isManager() ? -4 : -1) || week > shiftWeek(THIS, isManager() ? 8 : 1)) week = THIS;
    return `
      <form class="card addbar${S.addWeek || fixedProject ? ' expanded' : ''}" id="addForm">
        <input name="title" data-keep="add-title" placeholder="${week === NEXT ? 'Next week, e.g. Loop check LCP-02 with the client' : week < THIS ? 'What did you do that week?' : 'e.g. Commission AHU-3 controller on level 2'}" autocomplete="off" required>
        <div class="addbar-row">
          ${fixedProject ? '' : `<select name="project" aria-label="Project">${projectChoices()}</select>`}
          <select name="week" aria-label="Week">${weekChoices(week)}</select>
          <button type="submit" class="primary small">${icon('plus')} Add</button>
        </div>
        ${isManager() ? `<div class="addbar-row admin-row"><select name="person" aria-label="For">${personChoices(people || S.data.team)}</select></div>` : ''}
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
        const shown = forId === me().id && week === (S.which === 'next' ? NEXT : THIS);
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
      <p class="muted small sp-meta">${[p.id, p.client, p.manager ? 'PM: ' + p.manager : '',
        p.startDate || p.endDate ? (p.startDate || '…') + ' → ' + (p.endDate || '…') : ''].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="tchips sp-teams">${teamsOnProject(p.id).map(k => teamChip(k, myTeamKey() === k)).join('')}</div>
      ${teamTags(p.id, { people: order.map(id => ({ id: id })) })}
      ${p.notes ? `<p class="sp-notes">${esc(p.notes)}</p>` : ''}
      ${weekSwitch(S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length, S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'next')).length)}
      ${CLOSED.indexOf(p.status) === -1 ? addBar(p.id, projectTeam(p.id).concat(S.data.team.filter(m => projectTeam(p.id).indexOf(m) === -1))) : ''}
      ${order.map(id => `<section class="card"><h3 class="card-title"><span class="avatar sm">${esc(initials(member(id).name))}</span>${esc(member(id).name)}${member(id).team ? ` <span class="badge">${esc(member(id).team)}</span>` : ''}</h3>
        ${byPerson[id].sort((a, b) => isDone(a) - isDone(b)).map(t => taskHtml(t, true)).join('')}</section>`).join('')
        || `<div class="empty"><h3>No tasks ${S.which === 'next' ? 'planned for next week' : 'this week'}</h3></div>`}
      ${isManager() ? `<details class="sp-fold"${S.teamOpen ? ' open' : ''} data-spfold="team"><summary>Team (${projectTeam(p.id).length})${projectLead(p) ? ' · lead ' + esc(shortName(projectLead(p).name)) : ''}</summary>${teamEditor(p)}</details>` : ''}
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
    const may = m => leadsPerson(m.id);
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
    const blocked = S.data.tasks.filter(t => isBlocked(t) && open(t) && relevant(t))
      .sort((a, b) => a.week.localeCompare(b.week))
      .map(t => Object.assign(itemOf(t, 'doing'), { project: project(t.projectId).name }));
    summary.silent = rows.filter(r => r.silent).length;
    summary.blocked = blocked.length;
    return { v: 1, week: week, dept: curDept(), deptName: dept(curDept()).name, teams: teams, rows: rows, blocked: blocked, summary: summary };
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
      : '<div class="empty"><h3>No saved minutes yet</h3><p>Save them from the Team page after each meeting.</p></div>';
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
      dlg.innerHTML = `<div class="sheet saved-sheet"><header class="sheet-head"><span></span><h3>Saved minutes · week ${wnum(rec.week)}</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
        <div class="sheet-body">
          <p class="muted small" style="margin:0 0 10px">${esc(weekRange(rec.week))} ${weekMonday(rec.week).getUTCFullYear()} · saved ${esc(rec.savedAt)}${rec.savedBy ? ' by ' + esc(member(rec.savedBy).name) : ''}. This copy does not change when tasks change.</p>
          <div class="actions-row"><button type="button" class="primary" id="copySaved">Copy as email</button></div>
          ${m.notes ? `<section class="card"><h3 class="card-title">Team notes</h3><p class="saved-notes">${esc(m.notes)}</p></section>` : ''}
          ${(m.blocked || []).length ? `<section class="card warn"><h3 class="card-title">Blocked (${m.blocked.length})</h3><ul class="plain">${m.blocked.map(it => `<li><span><strong>${esc(it.title)}</strong><br><span class="muted">${esc(it.project)} · ${esc(it.who)} — ${esc(it.note || 'no reason given')}</span></span></li>`).join('')}</ul></section>` : ''}
          ${savedRowsHtml(m)}</div></div>`;
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
      .then(() => { if (currentTab().id === 'team' && curDept() === d) softRender(); });
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
  const ago = v => {
    if (!v) return '—';
    const days = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? days + ' days ago' : 'week ' + wnum(isoWeek(new Date(v)));
  };

  // ---------- Quick add (bottom bar → sheet) ----------

  /** The project ids used last on this device, most recent first. */
  function recentProjects() {
    let ids = [];
    try { ids = JSON.parse(remember.get('recent-projects') || '[]'); } catch (e) { ids = []; }
    return ids.filter(id => S.data.projects.some(p => p.id === id && CLOSED.indexOf(p.status) === -1));
  }
  function rememberProject(id) {
    const ids = [id].concat(recentProjects().filter(x => x !== id)).slice(0, 6);
    remember.set('recent-projects', JSON.stringify(ids)); remember.set('last-project', id);
  }

  /**
   * The add sheet: what (title), where (project chips: recent ones, then "Other…"), when (this / next
   * week) and "already done". The project and week stay chosen for the next task ("Add" keeps the
   * sheet open), so logging several tasks is: type, Add, type, Add.
   */
  function quickAddSheet(opts) {
    const dlg = $('#dialog');
    const openP = p => CLOSED.indexOf(p.status) === -1;   // projects are shared: anyone adds to any project
    const qa = S.qa = S.qa || {};
    const recent = recentProjects();
    const chips = recent.concat(myProjects().filter(p => openP(p) && recent.indexOf(p.id) === -1).map(p => p.id)).slice(0, 4);
    if (opts.week) qa.week = opts.week;
    if (opts.pid) qa.pid = opts.pid;
    if (!qa.week || (qa.week !== THIS && qa.week !== NEXT)) qa.week = THIS;
    if (!qa.pid || !S.data.projects.some(p => p.id === qa.pid && openP(p))) qa.pid = recent[0] || (chips.length === 1 ? chips[0] : '');
    const others = S.data.projects.filter(p => openP(p) && chips.indexOf(p.id) === -1).sort((a, b) => a.name.localeCompare(b.name));
    const manager = isManager();
    const draw = () => {
      dlg.innerHTML = `<form class="sheet qa-sheet" id="qaForm">
        <header class="sheet-head"><button type="button" class="text-btn" data-close>Close</button><h3>Add a task</h3><button type="submit" class="text-btn strong">Add</button></header>
        <div class="sheet-body">
          ${manager ? `<p class="qa-label">For</p><select class="qa-for" name="person" aria-label="Who the task is for">${personChoices(S.data.team)}</select>` : ''}
          ${manager ? '<p class="qa-label">Task</p>' : ''}<textarea name="title" rows="2" maxlength="300" placeholder="${qa.week === NEXT ? 'Next week, e.g. Loop check LCP-02 with the client' : 'e.g. Commission AHU-3 controller on level 2'}" aria-label="Task" required></textarea>
          <p class="qa-label">Project</p>
          <div class="chips qa-chips">${chips.map(id => `<button type="button" class="chip${qa.pid === id ? ' on' : ''}" data-qp="${esc(id)}">${esc(project(id).name)}</button>`).join('')}
            <select class="qa-other${qa.pid && chips.indexOf(qa.pid) === -1 ? ' on' : ''}" name="other" aria-label="Other project"><option value="">${chips.length ? 'Other…' : 'Choose a project…'}</option>${others.map(p => `<option value="${esc(p.id)}"${p.id === qa.pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
          <p class="qa-label">When</p>
          <div class="chips qa-chips">
            <button type="button" class="chip${qa.week === THIS ? ' on' : ''}" data-qw="${THIS}">This week · ${wnum(THIS)}</button>
            <button type="button" class="chip${qa.week === NEXT ? ' on' : ''}" data-qw="${NEXT}">Next week · ${wnum(NEXT)}</button>
            ${qa.week === THIS ? `<button type="button" class="chip done-chip${qa.done ? ' on' : ''}" data-qd>✓ Already done</button>` : ''}
          </div>
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

  // ---------- Shared pieces of the three pages ----------

  /** Week choices: "This + next week" (the default) or one week; `back` = how many past weeks. */
  function weekSelect(id, value, back) {
    const opts = [{ value: 'now', label: 'This + next week' }, { value: THIS, label: 'This week · ' + wnum(THIS) }, { value: NEXT, label: 'Next week · ' + wnum(NEXT) }];
    for (let n = 1; n <= back; n++) {
      const w = shiftWeek(THIS, -n);
      opts.push({ value: w, label: (n === 1 ? 'Last week · ' : 'Week ') + wnum(w) + (n === 1 ? '' : ' · ' + weekRange(w)) });
    }
    return `<label class="f${value !== 'now' ? ' set' : ''}"><span>Week</span><select id="${id}">${options(opts, value)}</select></label>`;
  }
  const weeksOf = v => v === 'now' ? [THIS, NEXT] : [v];
  /** A task is in a week; this week also holds unfinished tasks from earlier weeks. */
  const inWeeks = (t, ws) => ws.some(w => w === THIS ? inView(t, 'this') : t.week === w);
  /** The week a task shows in: an unfinished task from an earlier week is still open this week. */
  const shownWeek = t => !isDone(t) && t.week < THIS ? THIS : t.week;
  const searchOk = (t, q) => !q || (t.title + ' ' + project(t.projectId).name + ' ' + who(t) + ' ' + member(t.createdBy).name).toLowerCase().indexOf(q.toLowerCase()) !== -1;
  /** Task rank inside a list: blocked, carried over, open, done. */
  const rank = t => isBlocked(t) ? 0 : !isDone(t) && t.week < THIS ? 1 : isDone(t) ? 3 : 2;
  function searchBox(key, placeholder) {
    return `<input type="search" class="search f-search" id="q-${key}" data-search="${key}" placeholder="${esc(placeholder)}" value="${esc(S.search[key] || '')}" autocomplete="off">`;
  }
  function layoutSeg(list, value) {
    return `<div class="seg layout-seg" role="group" aria-label="Layout">${list.map(l => `<button type="button" data-layout="${l[0]}" class="${value === l[0] ? 'on' : ''}">${l[1]}</button>`).join('')}</div>`;
  }
  /** Filters and searches: change the state and draw again (the search box keeps its cursor). */
  function bindFilters(root, onChange) {
    $$('[data-search]', root).forEach(i => i.oninput = () => {
      S.search[i.dataset.search] = i.value;
      const pos = i.selectionStart; render();
      const again = $('#q-' + i.dataset.search); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
    $$('.filters select', root).forEach(s => s.onchange = () => { onChange(s.id, s.value); render(); });
  }
  function bindJoin(root) {
    $$('[data-join]', root).forEach(b => b.onclick = async e => {
      e.stopPropagation();
      S.lastWrite = Date.now();
      if (await guard(() => Api.joinProject(b.dataset.join).then(() => true))) toast('You joined ' + project(b.dataset.join).name);
      render();
    });
    $$('[data-addto]', root).forEach(b => b.onclick = e => { e.stopPropagation(); quickAddSheet({ pid: b.dataset.addto }); });
    $$('[data-sheet]', root).forEach(b => b.onclick = () => { S.open[b.dataset.sheet] = true; S.sheetTask = b.dataset.sheet; render(); });
  }
  const statusPill = p => `<span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>`;
  const joined = pid => myProjectIds().indexOf(pid) !== -1;

  /**
   * Tasks grouped by project. opts.byTeam: inside each project, one group per team (PLC, AVEVA,
   * BMS, ...). opts.others(p): tasks of other teams on the same project (shown when unfolded).
   * Two weeks: each group is split into "This week" and "Next week".
   */
  function byProjectHtml(tasks, ws, opts) {
    const groups = {};
    tasks.forEach(t => { (groups[t.projectId] = groups[t.projectId] || []).push(t); });
    const order = Object.keys(groups).sort((a, b) =>
      Math.min(...groups[a].map(rank)) - Math.min(...groups[b].map(rank)) || project(a).name.localeCompare(project(b).name));
    const rows = list => {
      const sorted = list.slice().sort((a, b) => rank(a) - rank(b));
      if (ws.length < 2) return sorted.map(t => taskHtml(t, opts.showOwner)).join('');
      return ws.map(w => {
        const inW = sorted.filter(t => shownWeek(t) === w);
        return inW.length ? `<p class="wk-label">${w === THIS ? 'This week' : 'Next week'} · ${wnum(w)}</p>${inW.map(t => taskHtml(t, opts.showOwner)).join('')}` : '';
      }).join('');
    };
    const card = pid => {
      const p = project(pid);
      const own = groups[pid];
      const extra = opts.others && S.showOthers[pid] ? opts.others(p) : [];
      const all = own.concat(extra);
      const otherCount = opts.others ? opts.others(p).length : 0;
      const body = opts.byTeam
        ? teamKeys().filter(k => all.some(t => taskTeam(t) === k)).map(k => {
          const list = all.filter(t => taskTeam(t) === k);
          return `<div class="tgroup"><h4 class="tgroup-head">${teamChip(k)}<small>${list.length} ${list.length === 1 ? 'task' : 'tasks'}</small></h4>${rows(list)}</div>`;
        }).join('')
        : `<div class="tgroup">${rows(own)}</div>`;
      return `<section class="pcard${S.project === pid ? ' selected' : ''}">
        <header class="pcard-head"><button type="button" class="pcard-name" data-project="${esc(pid)}">${esc(p.name)}</button>${statusPill(p)}
          <span class="tchips">${teamsOnProject(pid).map(k => teamChip(k, myTeamKey() === k)).join('')}</span>
          <span class="pcard-actions no-print">${joined(pid) ? '' : `<button type="button" class="ghost small-btn" data-join="${esc(pid)}">Join</button>`}${CLOSED.indexOf(p.status) === -1 ? `<button type="button" class="secondary small-btn" data-addto="${esc(pid)}">${icon('plus')} Task</button>` : ''}</span></header>
        ${body}
        ${otherCount ? `<p class="others no-print">Other teams on this project: ${Array.from(new Set(opts.others(p).map(taskTeam))).map(k => teamChip(k) + ' ' + opts.others(p).filter(t => taskTeam(t) === k).length).join(' ')}
          <button type="button" class="text-btn" data-others="${esc(pid)}">${S.showOthers[pid] ? 'Hide' : 'Show'}</button></p>` : ''}
      </section>`;
    };
    return order.map(card).join('');
  }
  function bindOthers(root) {
    $$('[data-others]', root).forEach(b => b.onclick = () => { S.showOthers[b.dataset.others] = !S.showOthers[b.dataset.others]; render(); });
  }

  /** Projects in view with no tasks: folded into one line at the bottom, with Join and + Task. */
  function quietProjectsHtml(list, label) {
    if (!list.length) return '';
    const open = !!S.showQuiet;
    return `<section class="quiet-projects">
      <button type="button" class="quiet-toggle" id="quietToggle" aria-expanded="${open}">${icon(open ? 'down' : 'chevron')}<span>${esc(label)} <small>(${list.length} ${list.length === 1 ? 'project' : 'projects'})</small></span></button>
      ${open ? list.map(p => `<div class="qrow"><button type="button" class="pcard-name" data-project="${esc(p.id)}">${esc(p.name)}</button>${statusPill(p)}
        <span class="tchips">${teamsOnProject(p.id).map(k => teamChip(k)).join('') || '<span class="muted small">No team on it yet</span>'}</span>
        <span class="pcard-actions">${joined(p.id) ? '' : `<button type="button" class="ghost small-btn" data-join="${esc(p.id)}">Join</button>`}<button type="button" class="secondary small-btn" data-addto="${esc(p.id)}">${icon('plus')} Task</button></span></div>`).join('') : ''}
    </section>`;
  }
  function bindQuiet(root) { const q = $('#quietToggle', root); if (q) q.onclick = () => { S.showQuiet = !S.showQuiet; render(); }; }

  /** Board: one column per status; drag a task you may change to another column. */
  const BOARD = [['To Do', 'To do'], ['In Progress', 'Doing'], ['Blocked', 'Blocked'], ['Done', 'Done']];
  function boardHtml(tasks, showTeam) {
    return `<div class="board4">${BOARD.map(([s, label]) => {
      const list = tasks.filter(t => t.status === s).sort((a, b) => rank(a) - rank(b) || project(a.projectId).name.localeCompare(project(b.projectId).name));
      return `<section class="bcol" data-col="${s}"><h3 class="bcol-head">${label}<small>${list.length}</small></h3>
        ${list.map(t => `<button type="button" class="bcard" data-sheet="${esc(t.id)}"${canEditTask(t) ? ` draggable="true" data-drag="${esc(t.id)}"` : ''}>
          <span class="bcard-title">${esc(t.title)}</span>
          <span class="bcard-meta">${showTeam ? teamChip(taskTeam(t)) : ''}<span class="grow">${esc(project(t.projectId).name)}</span>${t.week < THIS && !isDone(t) ? `<span class="tag-carry">wk ${wnum(t.week)}</span>` : ''}${showTeam ? `<span class="avatar xs" title="${esc(member(ownersOf(t)[0]).name)}">${esc(initials(member(ownersOf(t)[0]).name))}</span>` : ''}</span>
        </button>`).join('') || '<p class="muted small bcol-empty">Nothing here</p>'}</section>`;
    }).join('')}</div>`;
  }
  function bindBoard(root) {
    $$('[data-drag]', root).forEach(c => {
      c.ondragstart = e => { e.dataTransfer.setData('text/plain', c.dataset.drag); c.classList.add('dragging'); };
      c.ondragend = () => c.classList.remove('dragging');
    });
    $$('.bcol', root).forEach(col => {
      col.ondragover = e => { e.preventDefault(); col.classList.add('drop'); };
      col.ondragleave = () => col.classList.remove('drop');
      col.ondrop = e => {
        e.preventDefault(); col.classList.remove('drop');
        const t = findTask(e.dataTransfer.getData('text/plain'));
        if (!t || !canEditTask(t) || t.status === col.dataset.col) return;
        updateTask(t, x => Object.assign({ status: col.dataset.col }, x.week < THIS ? { week: THIS } : {}));
      };
    });
  }

  /** By person: each person (in the filter) and their tasks, grouped by project. */
  function byPersonHtml(tasks, people) {
    const cards = people.map(m => {
      const mine = tasks.filter(t => ownersOf(t).indexOf(m.id) !== -1);
      if (!mine.length) return '';
      const pids = Array.from(new Set(mine.map(t => t.projectId))).sort((a, b) => project(a).name.localeCompare(project(b).name));
      return `<section class="card person-card"><h3 class="card-title"><span class="avatar sm">${esc(initials(m.name))}</span>${esc(m.name)}${teamChip(teamKeyOf(m))}</h3>
        ${personInfo(m) ? `<p class="muted small person-info">${esc(personInfo(m))}</p>` : ''}
        ${pids.map(pid => `<p class="wk-label"><button type="button" class="link-btn" data-project="${esc(pid)}">${esc(project(pid).name)}</button></p>${mine.filter(t => t.projectId === pid).sort((a, b) => rank(a) - rank(b)).map(t => taskHtml(t, true)).join('')}`).join('')}
      </section>`;
    }).join('');
    const none = people.filter(m => !tasks.some(t => ownersOf(t).indexOf(m.id) !== -1));
    return `<div class="people-grid">${cards}</div>${none.length ? `<p class="muted small no-tasks">No tasks: ${none.map(m => esc(m.name)).join(', ')}</p>` : ''}`;
  }

  /** Table: one row per task; click a column heading to sort. */
  function tableHtml(tasks) {
    const keys = {
      task: t => t.title.toLowerCase(), project: t => project(t.projectId).name.toLowerCase(), team: t => teamLabel(taskTeam(t)),
      person: t => member(ownersOf(t)[0]).name, week: t => shownWeek(t), status: t => BOARD.findIndex(b => b[0] === t.status),
    };
    const k = keys[S.sort] ? S.sort : 'project';
    const list = tasks.slice().sort((a, b) => keys[k](a) < keys[k](b) ? -1 : keys[k](a) > keys[k](b) ? 1 : 0);
    const th = (id, label) => `<th><button type="button" class="th-btn${k === id ? ' on' : ''}" data-sort="${id}">${label}${k === id ? ' ↓' : ''}</button></th>`;
    return `<div class="table-wrap"><table class="ttable"><thead><tr>${th('task', 'Task')}${th('project', 'Project')}${th('team', 'Team')}${th('person', 'Person')}${th('week', 'Week')}${th('status', 'Status')}</tr></thead>
      <tbody>${list.map(t => `<tr class="${isDone(t) ? 'done' : ''}"><td class="tt"><button type="button" class="link-btn" data-sheet="${esc(t.id)}">${esc(t.title)}</button></td>
        <td><button type="button" class="link-btn muted-link" data-project="${esc(t.projectId)}">${esc(project(t.projectId).name)}</button></td><td>${teamChip(taskTeam(t))}</td>
        <td>${esc(ownersOf(t).map(id => member(id).name).join(', '))}</td><td class="num">${wnum(shownWeek(t))}${t.week < shownWeek(t) ? ' <span class="tag-carry">from ' + wnum(t.week) + '</span>' : ''}</td>
        <td><span class="st st-${slug(t.status)}">${esc((BOARD.find(b => b[0] === t.status) || [t.status, t.status])[1])}</span></td></tr>`).join('')}</tbody></table></div>
      ${list.length ? '' : '<div class="empty"><h3>No tasks match these filters</h3></div>'}`;
  }
  function bindTable(root) { $$('[data-sort]', root).forEach(b => b.onclick = () => { S.sort = b.dataset.sort; render(); }); }

  // ---------- My tasks (everyone) ----------

  function viewMy(root) {
    if (!S.myLayout) S.myLayout = remember.get('my-layout') === 'board' ? 'board' : 'project';
    const wsel = S.myWeek || 'now';
    const ws = weeksOf(wsel);
    const mine = S.data.tasks.filter(t => ownersOf(t).indexOf(me().id) !== -1);
    const tasks = mine.filter(t => inWeeks(t, ws) && searchOk(t, S.search.my));
    // Carried 2+ weeks: one tap each to keep (moves it to this week), finish or drop it.
    const review = ws.indexOf(THIS) !== -1 ? mine.filter(t => !isDone(t) && t.week <= shiftWeek(THIS, -2)).sort((a, b) => a.week.localeCompare(b.week)) : [];
    const day = new Date().getDay();
    const planHint = ws.indexOf(THIS) !== -1 && (day === 0 || day >= 4) && !mine.some(t => t.week === NEXT) && remember.get('plan-dismissed') !== NEXT;
    const body = S.myLayout === 'board' ? boardHtml(tasks, false) : (byProjectHtml(tasks, ws, { showOwner: true }) ||
      `<div class="empty"><h3>No tasks ${wsel === 'now' ? 'this week or next' : 'in week ' + wnum(wsel)}${S.search.my ? ' match' : ''}</h3><p>Tap <b>+ Add task</b> to add one, on any project.</p></div>`);
    root.innerHTML = `
      <div class="page-title"><h2>My tasks</h2><p class="muted">Your tasks this week and next.</p></div>
      <div class="filters">${weekSelect('myWeek', wsel, 1)}${searchBox('my', 'Search my tasks or projects')}${layoutSeg([['project', 'By project'], ['board', 'Board']], S.myLayout)}</div>
      ${planHint ? `<div class="nudge" id="planNudge"><span><strong>Plan next week</strong><br>Nothing planned for week ${wnum(NEXT)} yet. It goes straight into next week’s meeting.</span>
        <span class="nudge-actions"><button type="button" class="primary small" id="planNext">Plan week ${wnum(NEXT)}</button><button type="button" class="text-btn" id="planLater">Later</button></span></div>` : ''}
      ${review.length ? `<section class="card review"><h3 class="card-title">Carried over 2+ weeks (${review.length})</h3>
        <p class="muted small" style="margin:0 0 8px">Still doing these? Keep them for this week, mark them done, or drop them.</p>
        ${review.map(t => `<div class="rv-row"><div class="rv-text"><strong>${esc(t.title)}</strong><small class="muted">${esc(project(t.projectId).name)} · since week ${wnum(t.week)}</small></div>
          <div class="rv-actions"><button type="button" class="secondary small-btn" data-keep-task="${t.id}">Keep</button><button type="button" class="primary small-btn" data-done-task="${t.id}">✓ Done</button>${t.createdBy === me().id || canEditTask(t) ? `<button type="button" class="ghost danger-text small-btn" data-drop-task="${t.id}">Drop</button>` : ''}</div></div>`).join('')}
      </section>` : ''}
      <div class="plist">${body}</div>`;
    bindFilters(root, (id, v) => { if (id === 'myWeek') S.myWeek = v; });
    $$('[data-layout]', root).forEach(b => b.onclick = () => { S.myLayout = b.dataset.layout; remember.set('my-layout', S.myLayout); render(); });
    bindTasks(root); bindProjectLinks(root); bindJoin(root); bindBoard(root);
    $$('[data-keep-task]', root).forEach(b => b.onclick = () => { updateTask(findTask(b.dataset.keepTask), { week: THIS }); toast('Kept for this week'); });
    $$('[data-done-task]', root).forEach(b => b.onclick = () => { updateTask(findTask(b.dataset.doneTask), { status: 'Done', week: THIS }); toast('Done ✔'); });
    $$('[data-drop-task]', root).forEach(b => b.onclick = async () => {
      if (!confirm('Drop this task? It is deleted.')) return;
      S.lastWrite = Date.now();
      if (await guard(() => Api.deleteTask(b.dataset.dropTask).then(() => true))) toast('Dropped');
      render();
    });
    const plan = $('#planNext', root); if (plan) plan.onclick = () => quickAddSheet({ week: NEXT });
    const later = $('#planLater', root); if (later) later.onclick = () => { remember.set('plan-dismissed', NEXT); render(); };
  }

  // ---------- Team (admins and department admins): the weekly meeting ----------

  /** The Team filter: everyone, a department, or one team (PLC, AVEVA, BMS, UI/UX, Dev, Management). */
  function teamFilterSelect() {
    const opts = [{ value: 'all', label: 'All teams' }];
    departments().forEach(d => {
      const cols = deptTeams(d.id);
      opts.push({ value: 'dept:' + d.id, label: d.name + (cols.length > 1 ? ' (all)' : '') });
      if (cols.length > 1) cols.forEach(c => opts.push({ value: 'team:' + d.id + ':' + c, label: '  ' + teamLabel(d.id + ':' + c) }));
    });
    opts.push({ value: 'team:' + MGMT, label: 'Management' });
    return `<label class="f${teamFilter() !== 'all' ? ' set' : ''}"><span>Team</span><select id="teamFilter">${options(opts, teamFilter())}</select></label>`;
  }
  /** People in the Team filter (active ones). */
  const filterPeople = () => S.data.team.filter(m => m.active && teamMatch(teamKeyOf(m))).sort((a, b) => a.name.localeCompare(b.name));
  function personSelect(people) {
    const v = people.some(m => m.id === S.who) ? S.who : 'all';
    return `<label class="f${v !== 'all' ? ' set' : ''}"><span>Person</span><select id="whoFilter"><option value="all">Everyone</option>${people.map(m =>
      `<option value="${esc(m.id)}"${m.id === v ? ' selected' : ''}>${esc(m.name)}${m.id === me().id ? ' (me)' : ''}</option>`).join('')}</select></label>`;
  }
  /**
   * People in the filter with no update in the week: none of their tasks (created by or assigned
   * to them) was added or changed that week. A task someone else created for them and nobody has
   * touched since doesn't count as their update.
   */
  function quietPeople(week, people) {
    const theirs = m => S.data.tasks.filter(t => t.createdBy === m.id || t.assigneeIds.indexOf(m.id) !== -1);
    const counts = (t, m) => touchedIn(t, week) && !(t.createdBy !== m.id && t.createdRaw && t.createdRaw === t.version);
    return people.filter(m => m.role !== 'Admin' && !theirs(m).some(t => counts(t, m)))
      .map(m => ({ m: m, last: theirs(m).reduce((x, t) => t.version && t.version > x ? t.version : x, '') }));
  }

  function viewTeam(root) {
    if (!S.teamLayout) S.teamLayout = ['board', 'person', 'table'].indexOf(remember.get('team-layout')) !== -1 ? remember.get('team-layout') : 'project';
    const wsel = S.teamWeek || 'now';
    const ws = weeksOf(wsel);
    const week = wsel === 'now' ? THIS : wsel;   // the week of the minutes
    const people = filterPeople();
    const whoOk = id => S.who === 'all' || !people.some(m => m.id === S.who) || id === S.who;
    const inFilter = t => teamMatch(taskTeam(t)) && whoOk(ownersOf(t)[0]);
    const tasks = S.data.tasks.filter(t => inWeeks(t, ws) && inFilter(t) && searchOk(t, S.search.team));
    // Projects in view: "Our projects" = the filter's people are on it or have tasks in it.
    const ours = p => tasks.some(t => t.projectId === p.id) || projectTeam(p.id).some(m => m.active !== false && teamMatch(teamKeyOf(m)) && whoOk(m.id));
    const pool = S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1 && (S.tscope === 'all' || ours(p)))
      .filter(p => !S.search.team || (p.name + ' ' + p.client).toLowerCase().indexOf(S.search.team.toLowerCase()) !== -1 || tasks.some(t => t.projectId === p.id));
    const quietP = pool.filter(p => !tasks.some(t => t.projectId === p.id)).sort((a, b) => a.name.localeCompare(b.name));
    const filtered = teamFilter() !== 'all' || S.who !== 'all';
    const others = p => filtered ? S.data.tasks.filter(t => t.projectId === p.id && inWeeks(t, ws) && !inFilter(t)) : [];
    // Meeting numbers and minutes (minutes are per department: pick one in the Team filter)
    const d = filterDept();
    const key = d ? d + ':' + week : null;
    if (key && !(key in S.minutes)) loadMinutes(week);
    const saved = key ? S.minutes[key] : undefined;
    const hasSaved = !!(saved && saved.snapshot);
    const weekTasks = S.data.tasks.filter(t => inWeeks(t, [week]) && inFilter(t));
    const blocked = weekTasks.filter(isBlocked).length, done = weekTasks.filter(isDone).length;
    const quiet = week <= THIS ? quietPeople(week, people.filter(m => whoOk(m.id))) : [];
    const lay = S.teamLayout;
    const body = lay === 'board' ? boardHtml(tasks, true)
      : lay === 'person' ? byPersonHtml(tasks, people.filter(m => whoOk(m.id)))
        : lay === 'table' ? tableHtml(tasks)
          : (byProjectHtml(tasks, ws, { byTeam: true, showOwner: false, others: filtered ? others : null }) || '<div class="empty"><h3>No tasks match these filters</h3></div>') +
            quietProjectsHtml(quietP, 'No tasks ' + (wsel === 'now' ? 'this week or next' : 'in week ' + wnum(wsel)));
    const scopeSeg = `<div class="seg scope-seg" role="group" aria-label="Which projects"><button type="button" data-scope="ours" class="${S.tscope !== 'all' ? 'on' : ''}">Our projects</button><button type="button" data-scope="all" class="${S.tscope === 'all' ? 'on' : ''}">All projects</button></div>`;
    root.innerHTML = `
      <div class="page-title"><h2>${d ? esc(dept(d).name) + ' team' : teamFilter() === 'team:' + MGMT ? 'Management' : 'All teams'}${teamFilter().indexOf('team:') === 0 && teamFilter() !== 'team:' + MGMT ? ' · ' + esc(teamLabel(teamFilter().slice(5))) : ''}</h2>
        <p class="muted">The weekly meeting: walk through each project, then save the minutes.</p></div>
      <div class="filters">${weekSelect('teamWeek', wsel, 8)}${teamFilterSelect()}${personSelect(people)}${scopeSeg}${searchBox('team', 'Search tasks or projects')}
        ${layoutSeg([['project', 'By project'], ['board', 'Board'], ['person', 'By person'], ['table', 'Table']], lay)}</div>
      <div class="meetbar">
        <span class="stat bad"><b>${blocked}</b> blocked</span><span class="stat ok"><b>${done}</b> done</span><span class="stat"><b>${weekTasks.length - done}</b> open</span>
        ${week <= THIS ? `<details class="stat warn quiet-names"><summary><b>${quiet.length}</b> no update</summary>${quiet.length ? `<ul class="plain">${quiet.map(q => `<li>${esc(q.m.name)} <small class="muted">${q.last ? 'last ' + ago(q.last) : 'never'}</small></li>`).join('')}</ul>
          ${week === THIS ? '<button type="button" class="secondary small-btn" id="copyReminder">Copy reminder</button>' : ''}` : '<p class="muted small">Everyone has updated.</p>'}</details>` : ''}
        <span class="meet-actions no-print">${d ? `<button type="button" class="secondary small-btn" id="copyEmail">Copy as email</button>
          ${canManage(d) && week <= THIS ? `<button type="button" class="primary small" id="saveMins">${hasSaved ? 'Update saved minutes' : 'Save minutes'}</button>` : ''}
          <button type="button" class="ghost small-btn" id="archiveBtn">Past minutes</button>` : '<span class="muted small">Pick a department in <b>Team</b> to email or save its minutes.</span>'}</span>
      </div>
      ${hasSaved ? `<div class="mtg-note saved"><span>Minutes for week ${wnum(week)} saved ${esc(saved.savedAt)}${saved.savedBy ? ' by ' + esc(member(saved.savedBy).name) : ''}</span><button type="button" class="secondary small-btn" id="viewSaved">View saved copy</button></div>`
        : d && week < THIS && saved === null ? '<div class="mtg-note warn"><span>Not saved. This is rebuilt from today’s tasks, so it may differ from what was discussed.</span></div>' : ''}
      <div class="plist">${body}</div>`;
    bindFilters(root, (id, v) => {
      if (id === 'teamWeek') S.teamWeek = v;
      if (id === 'teamFilter') { S.tfilter = v; S.who = 'all'; }
      if (id === 'whoFilter') S.who = v;
    });
    $$('[data-layout]', root).forEach(b => b.onclick = () => { S.teamLayout = b.dataset.layout; remember.set('team-layout', S.teamLayout); render(); });
    $$('[data-scope]', root).forEach(b => b.onclick = () => { S.tscope = b.dataset.scope; render(); });
    bindTasks(root); bindProjectLinks(root); bindJoin(root); bindOthers(root); bindQuiet(root); bindBoard(root); bindTable(root);
    const remind = $('#copyReminder', root);
    if (remind) remind.onclick = () => copyText(
      'Hi ' + quiet.map(x => x.m.name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0]).join(', ') +
      ' — please add your tasks for week ' + wnum(week) + ' in Weekly Tasks before the meeting: ' + location.origin + location.pathname,
      'Reminder copied — paste it into your team chat');
    if (!d) return;
    $('#copyEmail', root).onclick = () => copyEmail(buildMinutes(week));
    $('#archiveBtn', root).onclick = minutesArchive;
    const view = $('#viewSaved', root); if (view) view.onclick = () => savedMinutesSheet(saved);
    const save = $('#saveMins', root);
    if (save) save.onclick = async () => {
      if (hasSaved && !confirm('Replace the saved minutes for week ' + wnum(week) + ' with today’s tasks?')) return;
      save.disabled = true;
      const rec = await guard(() => Api.saveMinutes(week, buildMinutes(week), d));
      save.disabled = false;
      if (rec) { S.minutes[key] = rec; toast('Minutes saved'); render(); }
    };
  }

  // ---------- Projects (everyone): find a project, join it, add a task ----------

  function viewProjects(root) {
    const st = S.pstatus || 'open';
    const q = (S.search.projects || '').toLowerCase();
    const list = S.data.projects.filter(p => (st === 'all' || (st === 'closed') === (CLOSED.indexOf(p.status) !== -1)) &&
      (!q || (p.name + ' ' + p.client + ' ' + p.id + ' ' + p.type).toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => joined(b.id) - joined(a.id) || a.name.localeCompare(b.name));
    const count = pid => S.data.tasks.filter(t => t.projectId === pid && inView(t, 'this')).length;
    const row = p => {
      const team = projectTeam(p.id).filter(m => m.active !== false);
      return `<div class="prow2${S.project === p.id ? ' selected' : ''}">
        <button type="button" class="prow2-main" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><small class="muted">${esc([p.id, p.client].filter(Boolean).join(' · '))}</small></button>
        ${statusPill(p)}
        <span class="tchips">${teamsOnProject(p.id).map(k => teamChip(k, myTeamKey() === k)).join('') || '<span class="muted small">No team yet</span>'}</span>
        <span class="prow2-nums muted small">${team.length} ${team.length === 1 ? 'person' : 'people'} · ${count(p.id)} ${isManager() ? '' : 'of my '}${count(p.id) === 1 ? 'task' : 'tasks'} this week</span>
        <span class="pcard-actions">${joined(p.id) ? '<span class="joined">✓ Joined</span>' : `<button type="button" class="ghost small-btn" data-join="${esc(p.id)}">Join</button>`}${CLOSED.indexOf(p.status) === -1 ? `<button type="button" class="secondary small-btn" data-addto="${esc(p.id)}">${icon('plus')} Task</button>` : ''}</span>
      </div>`;
    };
    root.innerHTML = `
      <div class="page-title"><h2>Projects</h2><p class="muted">${isManager() ? 'Every project and the teams on it. Join one, or add a task to it.' : 'Every project. Join one or add a task to it; you see your own tasks.'}</p></div>
      <div class="filters">${searchBox('projects', 'Find a project')}
        <div class="seg" role="group" aria-label="Status">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(s => `<button type="button" data-pstatus="${s[0]}" class="${st === s[0] ? 'on' : ''}">${s[1]}</button>`).join('')}</div></div>
      <div class="prows2">${list.map(row).join('') || '<div class="empty"><h3>No projects match</h3></div>'}</div>`;
    bindFilters(root, () => {});
    $$('[data-pstatus]', root).forEach(b => b.onclick = () => { S.pstatus = b.dataset.pstatus; render(); });
    bindProjectLinks(root); bindJoin(root);
  }

  // ---------- Manage (admins: everything · department admins: their own department) ----------

  function viewManage(root) {
    const tabs = [['people', 'People'], ['projects', 'Projects']].concat(isAdmin() ? [['depts', 'Departments & teams']] : []).concat([['external', '3rd parties']]);
    if (!tabs.some(t => t[0] === S.manageTab)) S.manageTab = 'people';
    const tab = S.manageTab;
    root.innerHTML = `
      <div class="page-title"><h2>Manage</h2><p class="muted">${isAdmin() ? 'Everything, in every department.' : esc(dept(me().departmentId).name) + ' department.'}</p></div>
      <div class="mtabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" data-tab="${t[0]}" class="${tab === t[0] ? 'on' : ''}" aria-selected="${tab === t[0]}">${t[1]}</button>`).join('')}</div>
      <div id="manageBody"></div>`;
    $$('[data-tab]', root).forEach(b => b.onclick = () => { S.manageTab = b.dataset.tab; render(); });
    const body = $('#manageBody', root);
    if (tab === 'people') renderPeople(body); else if (tab === 'projects') renderProjects(body);
    else if (tab === 'depts') renderDepts(body); else renderContacts(body);
  }

  /** The people this manager manages: admins everyone, a department admin their own department. */
  const managedPeople = () => S.data.team.filter(m => isAdmin() || m.departmentId === me().departmentId);
  /** "Automation · PLC" choices for a person's team; a department admin only has their own department. */
  function teamChoices(m) {
    const ds = isAdmin() ? departments() : [dept(me().departmentId)];
    return ds.reduce((a, d) => a.concat(deptTeams(d.id).map(c => ({ value: d.id + ':' + c, label: (ds.length > 1 ? d.name + ' · ' : '') + teamLabel(d.id + ':' + c) }))), []);
  }
  const lastTaskWeek = id => S.data.tasks.filter(t => ownersOf(t).indexOf(id) !== -1).reduce((w, t) => t.week > w ? t.week : w, '');

  function renderPeople(root) {
    const scope = managedPeople();
    const keys = Array.from(new Set(scope.map(teamKeyOf))).sort((a, b) => teamKeys().indexOf(a) - teamKeys().indexOf(b));
    const mt = keys.indexOf(S.mteam) !== -1 ? S.mteam : 'all';
    const q = (S.search.people || '').toLowerCase();
    const people = scope.filter(m => (mt === 'all' || teamKeyOf(m) === mt) && (!q || (m.name + ' ' + m.username + ' ' + m.title + ' ' + m.unit).toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => keys.indexOf(teamKeyOf(a)) - keys.indexOf(teamKeyOf(b)) || a.name.localeCompare(b.name));
    const roles = isAdmin() ? ['Member', 'Dept admin', 'Admin'] : ['Member', 'Dept admin'];
    const row = m => {
      const locked = m.id === me().id || (m.role === 'Admin' && !isAdmin());
      const tc = teamChoices(m);
      const lw = lastTaskWeek(m.id);
      return `<tr class="${m.active ? '' : 'off'}">
        <td class="tt"><span class="who"><span class="avatar sm">${esc(initials(m.name))}</span><span><strong>${esc(m.name)}</strong><small class="muted">${esc(m.title || m.username)}</small></span></span></td>
        <td>${tc.length > 1 && !locked ? `<select class="cell" data-pteam="${esc(m.id)}" aria-label="Team of ${esc(m.name)}">${options(tc, m.departmentId + ':' + (deptTeams(m.departmentId).indexOf(m.team) !== -1 ? m.team : deptTeams(m.departmentId)[0]))}</select>` : teamChip(teamKeyOf(m))}</td>
        <td>${locked ? esc(m.role) : `<select class="cell" data-prole="${esc(m.id)}" aria-label="Role of ${esc(m.name)}">${options(roles, m.role)}</select>`}</td>
        <td class="num">${S.data.assignments.filter(a => a.userId === m.id).length}</td>
        <td class="num">${lw ? wnum(lw) + (lw < THIS ? ' <span class="tag-carry">quiet</span>' : '') : '—'}</td>
        <td><button type="button" class="switch${m.active ? ' on' : ''}" data-pactive="${esc(m.id)}" aria-label="${esc(m.name)} can sign in" aria-pressed="${m.active}"${locked ? ' disabled' : ''}><i></i></button></td>
        <td>${locked && m.id !== me().id ? '' : `<button type="button" class="ghost small-btn" data-pedit="${esc(m.id)}">${m.id === me().id ? 'Edit' : 'Edit · password'}</button>`}</td></tr>`;
    };
    root.innerHTML = `<div class="filters"><label class="f${mt !== 'all' ? ' set' : ''}"><span>Team</span><select id="mteam"><option value="all">All${isAdmin() ? ' teams' : ''}</option>${keys.map(k => `<option value="${esc(k)}"${k === mt ? ' selected' : ''}>${esc(teamLabel(k))}</option>`).join('')}</select></label>
        ${searchBox('people', 'Search people, titles or teams')}<span class="grow"></span><button type="button" class="primary small" id="addPerson">${icon('plus')} Add person</button></div>
      <div class="table-wrap"><table class="ttable mtable"><thead><tr><th>Name</th><th>Team</th><th>Role</th><th>Projects</th><th>Last task (wk)</th><th>Can sign in</th><th></th></tr></thead>
        <tbody>${people.map(row).join('')}</tbody></table></div>
      ${people.length ? '' : '<div class="empty"><h3>Nobody matches</h3></div>'}
      <p class="muted small m-note">${isAdmin() ? 'You see everyone. Department admins see only their own department and cannot make anyone Admin.' : 'You see the people in ' + esc(dept(me().departmentId).name) + '. Ask an admin to move someone to another department.'}</p>`;
    bindFilters(root, (id, v) => { if (id === 'mteam') S.mteam = v; });
    $('#addPerson', root).onclick = () => memberForm({ role: 'Member', active: true, departmentId: me().departmentId });
    const save = async (m, change, msg) => {
      const rec = Object.assign({}, m, change, { isNew: false });
      if (await guard(() => Api.saveMember(rec).then(() => true))) toast(msg);
      render();
    };
    $$('[data-pteam]', root).forEach(s => s.onchange = () => {
      const m = member(s.dataset.pteam); const [d, t] = [s.value.split(':')[0], s.value.slice(s.value.indexOf(':') + 1)];
      save(m, { departmentId: d, team: dept(d).teams.length > 1 ? t : '' }, m.name + ' → ' + teamLabel(s.value));
    });
    $$('[data-prole]', root).forEach(s => s.onchange = () => { const m = member(s.dataset.prole); save(m, { role: s.value }, m.name + ' is now ' + s.value); });
    $$('[data-pactive]', root).forEach(b => b.onclick = () => {
      const m = member(b.dataset.pactive);
      save(m, { active: !m.active }, m.name + (m.active ? ' can no longer sign in' : ' can sign in again'));
    });
    $$('[data-pedit]', root).forEach(b => b.onclick = () => memberForm(member(b.dataset.pedit)));
  }

  function renderProjects(root) {
    const st = S.projectFilter || 'open';
    const q = (S.search.mprojects || '').toLowerCase();
    const list = S.data.projects.filter(p => (st === 'all' || (st === 'closed') === (CLOSED.indexOf(p.status) !== -1)) &&
      (!q || (p.name + ' ' + p.client + ' ' + p.id).toLowerCase().indexOf(q) !== -1)).sort((a, b) => a.name.localeCompare(b.name));
    root.innerHTML = `<div class="filters">${searchBox('mprojects', 'Search projects')}
        <div class="seg" role="group" aria-label="Status">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(s => `<button type="button" data-mstatus="${s[0]}" class="${st === s[0] ? 'on' : ''}">${s[1]}</button>`).join('')}</div>
        <span class="grow"></span><button type="button" class="primary small" id="addProject">${icon('plus')} Add project</button></div>
      <div class="table-wrap"><table class="ttable mtable"><thead><tr><th>Project</th><th>Status</th><th>Client</th><th>Teams on it</th><th>People</th><th>Tasks this week</th><th></th></tr></thead>
        <tbody>${list.map(p => `<tr><td class="tt"><button type="button" class="link-btn" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong></button><small class="muted block-small">${esc(p.id)}</small></td>
          <td><select class="cell" data-pstat="${esc(p.id)}" aria-label="Status of ${esc(p.name)}">${options(PROJECT_STATUSES, p.status)}</select></td>
          <td>${esc(p.client)}</td><td><span class="tchips">${teamsOnProject(p.id).map(k => teamChip(k)).join('') || '<span class="muted small">none yet</span>'}</span></td>
          <td class="num">${S.data.assignments.filter(a => a.projectId === p.id).length}</td><td class="num">${S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length}</td>
          <td><button type="button" class="ghost small-btn" data-medit="${esc(p.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>
      ${list.length ? '' : '<div class="empty"><h3>No projects match</h3></div>'}
      <p class="muted small m-note">Projects are shared by every team: teams appear on a project when their people join it or add tasks. Admins and department admins add and edit projects; only an admin deletes one.</p>`;
    bindFilters(root, () => {});
    $$('[data-mstatus]', root).forEach(b => b.onclick = () => { S.projectFilter = b.dataset.mstatus; render(); });
    $('#addProject', root).onclick = () => projectForm({ type: 'Other', status: 'In Progress', priority: 'Medium', assigned: [] });
    $$('[data-pstat]', root).forEach(s => s.onchange = async () => {
      const p = project(s.dataset.pstat);
      if (await guard(() => Api.saveProject(Object.assign({}, p, { status: s.value }), [], []).then(() => true))) toast(p.name + ' → ' + s.value);
      render();
    });
    $$('[data-medit]', root).forEach(b => b.onclick = () => {
      const p = project(b.dataset.medit);
      projectForm(Object.assign({}, p, { assigned: S.data.assignments.filter(a => a.projectId === p.id).map(a => a.userId) }));
    });
    bindProjectLinks(root);
  }

  function renderDepts(root) {
    root.innerHTML = `<div class="depts">${departments().map(d => {
      const ppl = S.data.team.filter(m => m.departmentId === d.id && m.active);
      const leads = ppl.filter(m => m.role === 'Dept admin');
      return `<section class="card dept-card"><h3 class="card-title">${esc(d.name)} <small class="muted">${ppl.length} people</small></h3>
        <h4>Teams (the columns of its meeting email)</h4><div class="tchips">${deptTeams(d.id).map(c => teamChip(d.id + ':' + c)).join('')}</div>
        <h4>Department admins</h4><p class="small">${leads.map(m => esc(m.name)).join(', ') || '<span class="muted">None yet</span>'}</p></section>`;
    }).join('')}
      <section class="card dept-card"><h3 class="card-title">Management <small class="muted">${S.data.team.filter(m => m.role === 'Admin' && m.active).length} admins</small></h3>
        <p class="small muted">Admins manage every department. Their own tasks show under the Management team.</p></section></div>
      <p class="muted small m-note">To add a department or rename a team, ask for it to be set up in the database (it changes the meeting email columns).</p>`;
  }

  /** Saved minutes, read-only: one block per project, one column per team. */
  function savedRowsHtml(m) {
    const teams = m.teams || ['PLC', 'Dev'];   // minutes saved before departments: PLC | Dev
    const li = it => `<li class="${it.blocked ? 'blk' : ''}">${it.kind === 'done' ? '✔ ' : it.kind === 'next' ? '→ ' : ''}${esc(it.title)} <small class="muted">${esc(it.who)}</small>${it.blocked ? ` <span class="tag-block">blocked: ${esc(it.note || 'no reason given')}</span>` : ''}</li>`;
    return (m.rows || []).map(r => `<section class="card saved-row"><h3 class="card-title">${esc(r.name)} ${r.status ? `<span class="pstatus ps-${slug(r.status)}">${esc(r.status)}</span>` : ''}</h3>
      ${r.silent ? '<p class="muted small">No update this week</p>' : `<div class="saved-cols">${teams.map(k => {
        const c = (r.cols || {})[k] || { done: [], doing: [], next: [] };
        const items = c.done.concat(c.doing, c.next);
        return `<div><h4>${esc(k)}</h4>${items.length ? `<ul class="plain saved-list">${items.map(li).join('')}</ul>` : '<p class="muted small">—</p>'}</div>`;
      }).join('')}</div>`}</section>`).join('') || '<div class="empty"><h3>Nothing in these minutes</h3></div>';
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

  function projectForm(values) {
    // Projects are shared: every department's project types, your own department's first.
    const d = dept(values.departmentId || me().departmentId);
    const types = Array.from(new Set(dept(me().departmentId).projectTypes.concat(departments().reduce((a, x) => a.concat(x.projectTypes), []))
      .concat(values.type ? [values.type] : [])));
    // A department admin puts only their own people on a project (and takes only them off).
    const original = (values.assigned || []).filter(leadsPerson);
    openForm({
      title: values.id ? 'Edit project' : 'New project',
      values: Object.assign({}, values, { assigned: original }),
      fields: [
        { name: 'name', label: 'Project name', required: true, wide: true },
        { name: 'id', label: 'Project ID (blank = auto)', readonly: !!values.id },
        { name: 'type', label: 'Type', type: 'select', options: types.length ? types : PROJECT_TYPES },
        { name: 'status', label: 'Status', type: 'chips', options: PROJECT_STATUSES },
        { name: 'priority', label: 'Priority', type: 'chips', options: PRIORITIES },
        { name: 'client', label: 'Client' },
        { name: 'manager', label: 'Project manager' },
        { name: 'startDate', label: 'Start date', type: 'date' },
        { name: 'endDate', label: 'End date', type: 'date' },
        { name: 'assigned', label: isAdmin() ? 'People on the project' : 'Your people on the project', type: 'checklist',
          options: groupPeople(S.data.team.filter(m => m.active && leadsPerson(m.id)), d.id)
            .reduce((a, g) => a.concat(g.people.map(m => ({ value: m.id, label: m.name, hint: m.title, group: g.label }))), []) },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      onSubmit: async v => {
        if (!v.name) throw new Error('Project name is required.');
        v.departmentId = values.departmentId || '';
        await Api.saveProject(v, v.assigned, original);
        toast('Project saved');
        render();
      },
    });
  }

  function memberForm(values) {
    const isNew = !values.id;
    const d = dept(values.departmentId || me().departmentId);
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

  // Left side on a computer, bottom bar on a phone. Each page has one job.
  const TABS = [
    { id: 'my', label: 'My tasks', icon: 'tasks', view: viewMy },
    { id: 'team', label: 'Team', icon: 'meeting', view: viewTeam, manager: true },
    { id: 'projects', label: 'Projects', icon: 'projects', view: viewProjects },
    { id: 'manage', label: 'Manage', icon: 'manage', view: viewManage, manager: true },
  ];
  const OLD_ROUTES = { week: 'my', tasks: 'my', meeting: 'team' };

  /** The page in the address (#/my, #/team, #/projects, #/manage); managers start on Team. */
  function currentTab() {
    const allowed = TABS.filter(t => !t.manager || isManager());
    let id = location.hash.replace(/^#\/?/, '') || (isManager() ? 'team' : 'my');
    id = OLD_ROUTES[id] || id;
    return allowed.find(t => t.id === id) || allowed[0];
  }

  function render() {
    if (!S.data) return;
    const tab = currentTab();
    $('#avatarBtn').textContent = initials(me().name);
    $('#avatarBtn').title = me().name;
    $('#addTaskBtn').hidden = tab.id === 'manage';
    document.body.dataset.tab = tab.id;
    $('#appnav').innerHTML = TABS.filter(t => !t.manager || isManager()).map(t =>
      `<a href="#/${t.id}" class="${t.id === tab.id ? 'on' : ''}"${t.id === tab.id ? ' aria-current="page"' : ''}>${icon(t.icon)}<span>${t.label}</span></a>`).join('');
    // Text half-typed into an "add" box survives the redraw (e.g. ticking a task meanwhile).
    const kept = {};
    const keepSel = '#view [data-keep], #dialog[data-mode="task"] [data-keep]';
    $$(keepSel).forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    tab.view($('#view'));
    if (tab.id !== 'manage' || S.project) renderPanel($('#view')); else document.body.classList.remove('panel-open');
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

  function showApp() {
    $('#loginView').hidden = true;
    document.body.classList.add('signed-in');
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
    $('#addTaskBtn').addEventListener('click', () => quickAddSheet({}));
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
