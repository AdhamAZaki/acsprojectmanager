// ACS Weekly Tasks: UI. Plain JS, no build step. Mobile-first.
// One page for everyone, nothing in two places:
//   Filter     one search box. Type to find a task; pick a week, status, person, team or project and
//              it becomes a tag in the box.
//   View       List · Board · Table (only the shape), Group by, Sort, Show empty groups.
//   Shortcuts  one-tap filters: My tasks, Open, Blocked, Done, Carried over, No update, the teams.
//   A task or a project opens in the panel on the right; + Task, + Project, Meeting (email and save
//   the minutes) and Manage (people and passwords, projects, departments, 3rd parties) are at the top.
//   A task may have no project. Each task has comments: who wrote each one, and when.
// The page is the same for an employee, a department admin and an admin: what a person may not do is
// hidden or switched off. Projects are shared by every team (PLC, AVEVA, BMS, UI/UX, Dev, ...).
// Employees see only their own tasks (the database enforces it); admins see everything, department
// admins their department first and the rest one filter away.
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
    task: null,          // task open in the panel on the right
    project: null,       // project open in the panel on the right
    mtgWeek: THIS,       // the week a project's history ends on
    lastWrite: 0,
    minutes: {},         // saved minutes per department and week: record, null (none saved) or undefined (loading)
    collapsed: null,     // saved minutes: folded projects
    qa: null,            // add a task: project, person and week kept between adds
    // The page
    layout: null,        // 'list' | 'board' | 'table'; remembered per device
    group: null,         // 'project' | 'person' | 'team' | 'status' | 'week' | 'none'; remembered per device
    sort: null,          // 'added' | 'title' | 'status' | 'changed'; remembered per device
    showEmpty: null,     // also show the groups with no tasks; remembered per device
    q: '',               // what is typed in the search box
    searchOpen: false,   // the list under the search box is showing
    week: 'now',         // filter: 'now' (this + next week) or one week
    fStatus: 'all',      // filter: 'all' | 'open' | 'carried' | a status
    fProject: 'all',     // filter: one project
    who: 'all',          // filter (managers): 'all' | 'me' | one person
    tfilter: null,       // filter (managers): 'all' | 'dept:<id>' | 'team:<dept>:<team>' | 'team:MGMT'
    subsOpen: {},        // task id -> its sub-tasks are showing in the row or card
    folded: {},          // group -> folded
    quiet: false,        // the "No update" names are showing
    // Manage window
    manageTab: 'people', projectFilter: 'open', mteam: 'all',
    search: {},          // search box text per Manage tab
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
  const typeClass = t => 'type-' + slug(t === 'AVEVA + PLC' ? 'aveva' : t);
  const isAdmin = () => S.data && S.data.me.role === 'Admin';
  const me = () => S.data.me;
  const member = id => S.data.team.find(m => m.id === id) || { name: 'Unknown', username: '', team: '' };
  /** A task may have no project: its projectId is ''. */
  const NO_PROJECT = { id: '', name: 'No project', type: '', status: '' };
  const project = id => !id ? NO_PROJECT : S.data.projects.find(p => p.id === id) || { id: id, name: '(removed project)', type: '', status: '' };
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
    return S.data.projects.filter(p => ids.has(p.id)).concat(ids.has('') ? [NO_PROJECT] : []);   // tasks without a project are in the minutes too
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

  // ---------- Pieces of a task, shared by every layout ----------

  const STATUSES = [['To Do', 'To do'], ['In Progress', 'Doing'], ['Blocked', 'Blocked'], ['Done', 'Done']];
  const statusLabel = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];
  /** A new status; a task carried over from an earlier week moves to this week when it is done. */
  const statusChange = (t, s) => Object.assign({ status: s }, s === 'Done' && t.week < THIS ? { week: THIS } : {});
  /** A person's initials in their team's colour. */
  const av = (id, cls) => {
    const m = member(id), team = teamLabel(teamKeyOf(m));
    return `<span class="w-av tc-${slug(team)}${cls ? ' ' + cls : ''}" title="${esc(m.name)} · ${esc(team)}">${esc(initials(m.name))}</span>`;
  };
  const avatars = t => ownersOf(t).map(id => av(id)).join('') +
    liveContacts(t).map(id => `<span class="w-av ext" title="${esc(contact(id).name)} · 3rd party">${esc(initials(contact(id).name))}</span>`).join('');
  const statusSel = t => canEditTask(t)
    ? `<select class="w-st st-${slug(t.status)}" id="st-${t.id}" data-chg="status" data-id="${t.id}" aria-label="Status">${STATUSES.map(s => `<option value="${s[0]}"${s[0] === t.status ? ' selected' : ''}>${s[1]}</option>`).join('')}</select>`
    : `<span class="w-st st-${slug(t.status)}">${esc(statusLabel(t.status))}</span>`;
  /** Small tags under a task's title: its project (unless grouped by project), carried over, a later week, blocked and why. */
  function tagsHtml(t, gid) {
    return [
      gid === 'project' ? '' : t.projectId ? `<button type="button" class="w-plink" data-act="project" data-id="${esc(t.projectId)}">${esc(project(t.projectId).name)}</button>` : '<span>No project</span>',
      t.week < THIS && !isDone(t) ? `<span class="tag-carry">from week ${wnum(t.week)}</span>`
        : gid !== 'week' && t.week > THIS ? `<span class="w-pill">${t.week === NEXT ? 'next week' : 'week ' + wnum(t.week)}</span>` : '',
      isBlocked(t) ? `<span class="tag-block">Blocked${t.blockNote ? ': ' + esc(t.blockNote) : ''}</span>` : '',
    ].join('');
  }
  const commentsOf = id => (S.data.comments || []).filter(c => c.taskId === id);
  const cmtChip = t => { const n = commentsOf(t.id).length; return n ? `<button type="button" class="w-chip" data-act="open" data-id="${t.id}" title="Comments">💬 ${n}</button>` : ''; };
  /** The comments on a task: who wrote each one and when, newest last, and a box to add one. Whoever can see the task can comment. */
  function commentsHtml(t) {
    const list = commentsOf(t.id);
    return `<div><span class="w-label">Comments${list.length ? ' · ' + list.length : ''}</span>
      ${list.map(c => `<div class="w-cmt">${av(c.author)}<span><b>${esc(member(c.author).name)}</b> <span class="muted small">${esc(c.createdAt)}</span></span>
        ${c.author === me().id || isAdmin() ? `<button type="button" class="w-x" data-act="cmtdel" data-cid="${esc(c.id)}" aria-label="Delete this comment">×</button>` : '<span></span>'}<p>${esc(c.body)}</p></div>`).join('') || '<p class="muted small">No comments yet.</p>'}
      <form class="w-cmt-form" data-form="comment" data-id="${t.id}"><textarea id="p-cmt" data-keep="cmt-${t.id}" rows="2" maxlength="2000" placeholder="Write a comment as ${esc(me().name)}" aria-label="Write a comment"></textarea><button class="primary small" type="submit">Send</button></form></div>`;
  }
  const subsChip = t => t.subtasks.length ? `<button type="button" class="w-chip${S.subsOpen[t.id] ? ' on' : ''}" data-act="subs" data-id="${t.id}" title="Show sub-tasks" aria-expanded="${!!S.subsOpen[t.id]}">☑ ${t.subtasks.filter(s => s.done).length}/${t.subtasks.length} ${S.subsOpen[t.id] ? '▴' : '▾'}</button>` : '';
  /**
   * Sub-tasks: tick, edit the text in place, remove (read-only for someone else's task).
   * `where` keeps the box ids apart (r = in a row or card, p = in the task panel).
   */
  function subsHtml(t, where, withAdd) {
    const edit = canEditTask(t);
    return `<div class="w-subs">${t.subtasks.map((s, i) => edit
      ? `<div class="w-sub${s.done ? ' done' : ''}"><input type="checkbox" id="${where}c-${t.id}-${i}" data-chg="subc" data-id="${t.id}" data-i="${i}"${s.done ? ' checked' : ''} aria-label="Done">
        <input type="text" id="${where}s-${t.id}-${i}" data-txt="sub" data-id="${t.id}" data-i="${i}" value="${esc(s.t)}" maxlength="300" aria-label="Sub-task"><button type="button" class="w-x" data-act="subdel" data-id="${t.id}" data-i="${i}" aria-label="Remove sub-task">×</button></div>`
      : `<div class="w-sub ro${s.done ? ' done' : ''}"><span>${s.done ? '✔' : '○'}</span><span>${esc(s.t)}</span></div>`).join('')}
      ${withAdd && edit ? `<form class="w-inline" data-form="sub" data-id="${t.id}"><input id="newsub-${t.id}" data-keep="sub-${t.id}" placeholder="Add a sub-task" maxlength="300" autocomplete="off"><button class="secondary small-btn" type="submit">Add</button></form>` : ''}</div>`;
  }
  /** Changes sub-task i (found again by its text, in case a teammate changed the list): fn(sub) returns the new one, or null to remove it. */
  function subEdit(t, i, fn) {
    const text = t.subtasks[i].t;
    return x => {
      const k = subIndex(x, i, text);
      if (k === -1) return {};
      const n = fn(x.subtasks[k]);
      return { subtasks: n ? x.subtasks.map((s, j) => j === k ? n : s) : x.subtasks.filter((s, j) => j !== k) };
    };
  }
  /**
   * A text edit (title, sub-task, blocked reason): saved in the background. The page is drawn again
   * once the person leaves the boxes, so typing is never interrupted.
   */
  function quietUpdate(t, change) {
    const fn = typeof change === 'function' ? change : () => change;
    S.data.tasks = S.data.tasks.map(x => x.id === t.id ? Object.assign({}, x, fn(x)) : x);
    S.lastWrite = Date.now();
    S.pendingRender = true;
    Api.patchTask(t.id, fn).catch(e => toast(e.message, true));
  }

  /** Weeks a task can go in: last, this and next week; managers 4 back to 8 ahead. `selected` is always offered. */
  function weekChoices(selected) {
    const [from, to] = isManager() ? [-4, 8] : [-1, 1];
    const names = { '-1': 'last week', 0: 'this week', 1: 'next week' };
    const weeks = [];
    for (let n = from; n <= to; n++) weeks.push([shiftWeek(THIS, n), n]);
    if (selected && !weeks.some(w => w[0] === selected)) weeks.unshift([selected, null]);
    return weeks.map(([w, n]) => `<option value="${w}"${w === selected ? ' selected' : ''}>Week ${wnum(w)} · ${names[n] || esc(weekRange(w))}</option>`).join('');
  }

  // ---------- Dropdown with a search box inside (for the long lists: projects, people, 3rd parties) ----------

  const pickerBtn = (kind, id, label, cls) => `<button type="button" class="w-pick${cls ? ' ' + cls : ''}" data-act="picker" data-kind="${kind}" data-id="${esc(id || '')}"><span>${esc(label)}</span><span class="muted">▾</span></button>`;
  const openProjects = () => S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1).sort((a, b) => a.name.localeCompare(b.name));
  /** People this person may put on a task: an admin anyone, a department admin their own people, everyone themselves. */
  const mayAssign = (t, m) => isAdmin() || (leadsTask(t) && leadsPerson(m.id)) || m.id === me().id;
  /** The choices of a picker: [value, name, small note, person id (for the avatar)]. */
  function pickerOptions(kind, id) {
    const t = id && findTask(id);
    if (kind === 'project' || kind === 'qa-project') {
      return [NO_PROJECT].concat(openProjects(), t && t.projectId && !openProjects().some(p => p.id === t.projectId) ? [project(t.projectId)] : []).map(p => [p.id, p.name, p.client || '']);
    }
    if (kind === 'addperson') {
      return S.data.team.filter(m => m.active && t.assigneeIds.indexOf(m.id) === -1 && mayAssign(t, m)).sort((a, b) => a.name.localeCompare(b.name))
        .map(m => [m.id, m.name, teamLabel(teamKeyOf(m)) + (m.title ? ' · ' + m.title : ''), m.id]);
    }
    if (kind === 'addext') return S.data.contacts.filter(c => t.contactIds.indexOf(c.id) === -1).map(c => [c.id, c.name, c.org || '']);
    // qa-person: who a new task is for
    return [[me().id, 'Me', '', me().id]].concat(S.data.team.filter(m => m.active !== false && m.id !== me().id && leadsPerson(m.id)).sort((a, b) => a.name.localeCompare(b.name))
      .map(m => [m.id, m.name, teamLabel(teamKeyOf(m)) + (m.title ? ' · ' + m.title : ''), m.id]));
  }
  function closePicker() { const p = $('#pop'); if (p) p.remove(); }
  function openPicker(btn) {
    const again = openPicker.btn === btn && $('#pop');
    closePicker();
    if (again) return;
    openPicker.btn = btn;
    const kind = btn.dataset.kind, id = btn.dataset.id, opts = pickerOptions(kind, id);
    const pop = document.createElement('div');
    pop.className = 'w-pop'; pop.id = 'pop';
    pop.innerHTML = `<input id="pop-q" type="search" placeholder="Search…" autocomplete="off" aria-label="Search this list">
      <div class="w-pop-list">${opts.map(o => `<button type="button" class="w-pop-item" data-act="pick" data-kind="${kind}" data-id="${esc(id)}" data-v="${esc(o[0])}" data-label="${esc(o[1])}">${o[3] ? av(o[3]) : ''}<span>${esc(o[1])}</span>${o[2] ? `<small>${esc(o[2])}</small>` : ''}</button>`).join('')}</div>
      <p class="muted small" id="pop-none"${opts.length ? ' hidden' : ''}>Nothing to choose</p>`;
    (btn.closest('dialog') || document.body).appendChild(pop);
    const r = btn.getBoundingClientRect(), w = Math.min(Math.max(r.width, 300), window.innerWidth - 16), h = pop.offsetHeight;
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = (r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    $('#pop-q').focus();
  }
  /** A choice was picked in a picker. */
  function picked(b) {
    const kind = b.dataset.kind, v = b.dataset.v, t = b.dataset.id && findTask(b.dataset.id);
    closePicker();
    if (kind === 'qa-project' || kind === 'qa-person') {
      if (kind === 'qa-project') S.qa.pid = v; else S.qa.forId = v;
      if (openPicker.btn && openPicker.btn.isConnected) openPicker.btn.firstElementChild.textContent = b.dataset.label;
      return;
    }
    if (!t) return;
    if (kind === 'project') updateTask(t, { projectId: v });
    else if (kind === 'addperson') updateTask(t, x => ({ assigneeIds: addId(x.assigneeIds, v) }));
    else if (kind === 'addext') updateTask(t, x => ({ contactIds: addId(x.contactIds, v) }));
  }

  // ---------- The task panel: one place to see and change a task, from every layout ----------

  function taskPanelHtml(t) {
    const p = project(t.projectId), owners = ownersOf(t).map(id => member(id).name).join(', ');
    const head = `<header class="w-phead"><span class="muted small w-grow">${esc(p.name)} · week ${wnum(t.week)}</span><button type="button" class="secondary small-btn" data-act="close">Close ✕</button></header>`;
    if (!canEditTask(t)) {
      return head + `<div class="w-pbody">
        <h3 class="w-ro-title">${esc(t.title)}</h3>
        <p>${statusSel(t)}${isBlocked(t) ? ` <span class="tag-block">${esc(t.blockNote || 'no reason given')}</span>` : ''}</p>
        <div><span class="w-label">People</span><div class="w-pchips">${avatars(t)} ${esc(who(t) || owners)}</div></div>
        ${t.subtasks.length ? `<div><span class="w-label">Sub-tasks</span>${subsHtml(t, 'p', false)}</div>` : ''}
        <p class="muted small">This is ${esc(owners)}’s task. Only they, their department admin or an admin can change it. You can comment on it.</p>
        ${commentsHtml(t)}</div>`;
    }
    const lead = isAdmin() || leadsTask(t);
    const on = t.assigneeIds.map(member).filter(m => m.id);
    const canAdd = S.data.team.some(m => m.active && t.assigneeIds.indexOf(m.id) === -1 && mayAssign(t, m));
    return head + `<div class="w-pbody">
      <p class="muted small">Created ${esc(t.createdAt)} · last changed ${esc(t.updatedAt)}</p>
      <div><span class="w-label">Task</span><textarea class="w-title-in" id="p-title" rows="2" maxlength="300" data-txt="title" data-id="${t.id}" aria-label="Task title">${esc(t.title)}</textarea></div>
      <div><span class="w-label">Status</span><div class="w-seg" role="group" aria-label="Status">${STATUSES.map(s => `<button type="button" data-act="pstatus" data-id="${t.id}" data-k="${s[0]}" class="${t.status === s[0] ? 'on' : ''}" aria-pressed="${t.status === s[0]}">${s[1]}</button>`).join('')}</div>
        ${isBlocked(t) ? `<div class="w-block"><div class="w-pchips">${BLOCK_REASONS.map(r => `<button type="button" class="w-chip${t.blockNote === r ? ' on' : ''}" data-act="reason" data-id="${t.id}" data-k="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          <input id="p-block" data-txt="block" data-id="${t.id}" value="${esc(t.blockNote)}" placeholder="Or type what is blocking it" aria-label="What is blocking it"></div>` : ''}</div>
      <div class="w-two"><div><span class="w-label">Project</span>${pickerBtn('project', t.id, p.name, 'wide')}</div>
        <div><span class="w-label">Week</span><select id="p-week" data-chg="week" data-id="${t.id}" aria-label="Week">${weekChoices(t.week)}</select></div></div>
      <div><span class="w-label">People</span><div class="w-pchips">
        ${on.map(m => `<span class="w-pchip" title="${esc(personInfo(m))}">${av(m.id)}${esc(m.name)} ${teamChip(teamKeyOf(m))}${mayAssign(t, m) ? `<button type="button" class="w-x" data-act="unasg" data-id="${t.id}" data-k="${esc(m.id)}" aria-label="Take ${esc(m.name)} off this task">×</button>` : ''}</span>`).join('')}
        ${liveContacts(t).map(id => `<span class="w-pchip ext"><span class="w-av ext">${esc(initials(contact(id).name))}</span>${esc(contact(id).name)} <small class="muted">3rd party</small><button type="button" class="w-x" data-act="unext" data-id="${t.id}" data-k="${esc(id)}" aria-label="Take ${esc(contact(id).name)} off this task">×</button></span>`).join('')}
        ${on.length || liveContacts(t).length ? '' : `<span class="muted small">${esc(owners)} (added it)</span>`}</div>
        <div class="w-pchips" style="margin-top:6px">${canAdd ? pickerBtn('addperson', t.id, '+ Add a person') : ''}${pickerBtn('addext', t.id, '+ Add a 3rd party')}</div>
        <form class="w-inline" data-form="ext" data-id="${t.id}" style="margin-top:6px"><input id="newext-${t.id}" data-keep="ext-${t.id}" placeholder="Or type a new 3rd party (e.g. Eng. Moataz)" autocomplete="off"><button class="secondary small-btn" type="submit">Add</button></form></div>
      <div><span class="w-label">Sub-tasks${t.subtasks.length ? ' · ' + t.subtasks.filter(s => s.done).length + '/' + t.subtasks.length : ''}</span>${subsHtml(t, 'p', true)}</div>
      ${commentsHtml(t)}
      ${lead || t.createdBy === me().id ? `<div class="w-pfoot"><button type="button" class="ghost danger-text small-btn" data-act="del" data-id="${t.id}">Delete task</button></div>` : ''}
    </div>`;
  }

  // ---------- My tasks ----------

  /** Small per-device memory (e.g. a dismissed nudge). Never required: storage may be blocked. */
  const remember = {
    get(k) { try { return localStorage.getItem('acs-' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('acs-' + k, v); } catch (e) { /* blocked */ } },
  };

  // ---------- A project, in the same panel as a task ----------

  /**
   * Opened by tapping a project's name: its status, teams, the people on it (managers add and
   * take off people here), Join / Leave, its notes and its last 8 weeks.
   */
  function projectPanelHtml(p) {
    const onIt = myProjectIds().indexOf(p.id) !== -1;
    const withTasks = Array.from(new Set(S.data.tasks.filter(t => t.projectId === p.id && inWeeks(t, [THIS, NEXT])).reduce((a, t) => a.concat(ownersOf(t)), [])));
    const closed = CLOSED.indexOf(p.status) !== -1;
    return `<header class="w-phead"><span class="sp-tags w-grow"><span class="badge ${typeClass(p.type)}">${esc(p.type)}</span><span class="prio prio-${slug(p.priority)}">${esc(p.priority || 'Medium')}</span><span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span></span>
        ${onIt ? '<button type="button" class="ghost small-btn" data-act="leavep" data-id="' + esc(p.id) + '">Leave</button>' : '<button type="button" class="primary small" data-act="joinp" data-id="' + esc(p.id) + '">Join</button>'}
        <button type="button" class="secondary small-btn" data-act="close">Close ✕</button></header>
      <div class="w-pbody w-project">
        <h2 class="sp-title">${esc(p.name)}</h2>
        <p class="muted small sp-meta">${[p.id, p.client, p.manager ? 'PM: ' + p.manager : '',
          p.startDate || p.endDate ? (p.startDate || '…') + ' → ' + (p.endDate || '…') : ''].filter(Boolean).map(esc).join(' · ')}</p>
        <div class="tchips sp-teams">${teamsOnProject(p.id).map(k => teamChip(k, myTeamKey() === k)).join('')}</div>
        <div class="w-pchips">
          ${closed ? '' : `<button type="button" class="primary small" data-act="addto" data-id="${esc(p.id)}">${icon('plus')} Task</button>`}
          <button type="button" class="secondary small-btn" data-act="onlyproject" data-id="${esc(p.id)}">Show only its tasks</button>
          ${isManager() ? `<button type="button" class="secondary small-btn" data-act="editproject" data-id="${esc(p.id)}">Edit project</button>` : ''}</div>
        ${isManager() ? teamEditor(p) : teamTags(p.id, { people: withTasks.map(id => ({ id: id })) })}
        ${p.notes ? `<p class="sp-notes">${esc(p.notes)}</p>` : ''}
        ${historyHtml(p)}
      </div>`;
  }
  const editProject = id => { const p = project(id); projectForm(Object.assign({}, p, { assigned: S.data.assignments.filter(a => a.projectId === p.id).map(a => a.userId) })); };

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

  /**
   * Admins and team leaders (department admins): who is on the project, at the top of its panel.
   * Tap × to take someone off, or pick anyone in the company to add. Employees only see the names.
   */
  function teamEditor(p) {
    const team = projectTeam(p.id);
    const others = S.data.team.filter(m => m.active && team.indexOf(m) === -1);
    return `<div class="card team-edit"><strong class="small">People on this project (${team.length})${projectLead(p) ? ' · lead ' + esc(shortName(projectLead(p).name)) : ''}</strong>
      <div class="avatars-row">${team.map(m => `<span class="person-chip" title="${esc(personInfo(m))}">${esc(shortName(m.name))} ${teamChip(teamKeyOf(m))}<button type="button" class="chip-x" data-unassign="${esc(m.id)}" aria-label="Take ${esc(m.name)} off the project">×</button></span>`).join('') || '<span class="muted small">Nobody yet</span>'}</div>
      ${others.length ? `<select id="assignSel" aria-label="Add a person to the project"><option value="">+ Add a person to this project…</option>${peopleOptions(others, p.departmentId)}</select>` : ''}</div>`;
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
      : '<div class="empty"><h3>No saved minutes yet</h3><p>Save them from the Meeting menu after each meeting.</p></div>';
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
      .then(() => { if (curDept() === d) softRender(); });
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

  // ---------- Add a task (+ Task → sheet) ----------

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
  /** The person a new task is for when nothing says otherwise: the person in the filter if you lead them, else you. */
  const defaultFor = () => { const w = whoId(); return isManager() && w && leadsPerson(w) ? w : me().id; };
  const canAddFor = id => id === me().id || (isManager() && leadsPerson(id));
  /** Saves a new task. Returns it, or undefined (the reason is shown). */
  async function addTask(v) {
    S.lastWrite = Date.now();
    const saved = await guard(() => Api.addTask({ projectId: v.projectId, week: v.week, title: v.title, status: v.status || 'To Do',
      team: member(v.forId).team || '', assigneeIds: [v.forId], contactIds: [], subtasks: [],
      createdBy: v.forId === me().id ? undefined : v.forId }));
    if (saved && v.projectId) rememberProject(v.projectId);
    return saved;
  }

  /**
   * The add sheet: what (title), where (a project or none, from a list with a search box), who for (managers), when (week)
   * and "already done". The project, person and week stay chosen for the next task ("Add" keeps the
   * sheet open), so logging several tasks is: type, Add, type, Add.
   * opts: { pid, week, forId, status, title } to start from.
   */
  function quickAddSheet(opts) {
    opts = opts || {};
    const dlg = $('#dialog');
    const isOpen = id => S.data.projects.some(p => p.id === id && CLOSED.indexOf(p.status) === -1);
    const qa = S.qa = S.qa || {};
    const lo = shiftWeek(THIS, isManager() ? -4 : -1), hi = shiftWeek(THIS, isManager() ? 8 : 1);
    if (opts.week) qa.week = opts.week;
    if (!qa.week || qa.week < lo || qa.week > hi) qa.week = THIS;
    if (opts.pid) qa.pid = opts.pid;
    if (!qa.pid || !isOpen(qa.pid)) qa.pid = isOpen(S.fProject) ? S.fProject : '';   // no project, unless one is chosen
    qa.forId = opts.forId && canAddFor(opts.forId) ? opts.forId : defaultFor();
    closePicker();
    dlg.innerHTML = `<form class="sheet qa-sheet" id="qaForm">
      <header class="sheet-head"><button type="button" class="text-btn" data-close>Close</button><h3>Add a task</h3><button type="submit" class="text-btn strong">Add</button></header>
      <div class="sheet-body">
        <p class="qa-label" style="margin-top:0">Task</p>
        <textarea name="title" rows="2" maxlength="300" placeholder="${qa.week > THIS ? 'e.g. Loop check LCP-02 with the client' : 'e.g. Commission AHU-3 controller on level 2'}" aria-label="Task" required>${esc(opts.title || '')}</textarea>
        <p class="qa-label">Project</p>${pickerBtn('qa-project', '', project(qa.pid).name, 'wide')}
        ${isManager() ? `<p class="qa-label">For</p>${pickerBtn('qa-person', '', qa.forId === me().id ? 'Me' : member(qa.forId).name, 'wide')}` : ''}
        <p class="qa-label">When</p><select name="week" aria-label="Week">${weekChoices(qa.week)}</select>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="done"${opts.status === 'Done' ? ' checked' : ''}> Already done</label>
        <p class="muted small qa-hint">Tap <b>Add</b> and type the next one. The project${isManager() ? ', person' : ''} and week stay chosen.</p>
      </div></form>`;
    const f = $('#qaForm', dlg);
    $('[data-close]', f).onclick = () => dlg.close();
    f.elements.week.onchange = () => { qa.week = f.elements.week.value; };
    f.onsubmit = async e => {
      e.preventDefault();
      const title = f.elements.title.value.replace(/\s+/g, ' ').trim();
      if (!title) { f.elements.title.focus(); return; }
      const btn = $('button[type=submit]', f); btn.disabled = true;
      const done = f.elements.done.checked;
      const saved = await addTask({ projectId: qa.pid, week: qa.week, title: title, forId: qa.forId,
        status: done ? 'Done' : opts.status && opts.status !== 'Done' ? opts.status : 'To Do' });
      btn.disabled = false;
      if (!saved) return;
      toast((done ? 'Logged as done' : 'Added') + ' · ' + project(qa.pid).name + (qa.forId === me().id ? '' : ' · for ' + shortName(member(qa.forId).name)));
      f.elements.title.value = '';
      f.elements.title.focus();
      softRender();
    };
    dlg.dataset.mode = 'add';
    dlg.onclose = () => { delete dlg.dataset.mode; dlg.onclose = null; closePicker(); render(); };
    if (!dlg.open) dlg.showModal();
    f.elements.title.focus();
  }

  // ---------- Weeks, search and people (shared by the page, the minutes and Manage) ----------

  const weeksOf = v => v === 'now' ? [THIS, NEXT] : [v];
  /** A task is in a week; this week also holds unfinished tasks from earlier weeks. */
  const inWeeks = (t, ws) => ws.some(w => w === THIS ? inView(t, 'this') : t.week === w);
  /** The week a task shows in: an unfinished task from an earlier week is still open this week. */
  const shownWeek = t => !isDone(t) && t.week < THIS ? THIS : t.week;
  const searchOk = (t, q) => !q || (t.title + ' ' + project(t.projectId).name + ' ' + who(t) + ' ' + member(t.createdBy).name).toLowerCase().indexOf(q.toLowerCase()) !== -1;
  /** Manage: a search box per tab. */
  function searchBox(key, placeholder) {
    return `<input type="search" class="search f-search" id="q-${key}" data-search="${key}" placeholder="${esc(placeholder)}" value="${esc(S.search[key] || '')}" autocomplete="off">`;
  }
  /** Manage: filters and searches change the state and draw again (the search box keeps its cursor). */
  function bindFilters(root, onChange) {
    $$('[data-search]', root).forEach(i => i.oninput = () => {
      S.search[i.dataset.search] = i.value;
      const pos = i.selectionStart; render();
      const again = $('#q-' + i.dataset.search); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
    $$('.filters select', root).forEach(s => s.onchange = () => { onChange(s.id, s.value); render(); });
  }
  const statusPill = p => `<span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>`;
  /** People in the Team filter (active ones). */
  const filterPeople = () => S.data.team.filter(m => m.active && teamMatch(teamKeyOf(m))).sort((a, b) => a.name.localeCompare(b.name));
  /**
   * People with no update in the week: none of their tasks (created by or assigned to them) was
   * added or changed that week. A task someone else created for them and nobody has touched since
   * doesn't count as their update.
   */
  function quietPeople(week, people) {
    const theirs = m => S.data.tasks.filter(t => t.createdBy === m.id || t.assigneeIds.indexOf(m.id) !== -1);
    const counts = (t, m) => touchedIn(t, week) && !(t.createdBy !== m.id && t.createdRaw && t.createdRaw === t.version);
    return people.filter(m => m.role !== 'Admin' && !theirs(m).some(t => counts(t, m)))
      .map(m => ({ m: m, last: theirs(m).reduce((x, t) => t.version && t.version > x ? t.version : x, '') }));
  }
  /** Opens a project in the panel (from a task, a group heading or Manage); tapping the open one again closes it. */
  function openProject(id) {
    if ($('#manageDlg').open) $('#manageDlg').close();
    S.project = S.project === id ? null : id;
    S.task = null;
    render();
  }
  function bindProjectLinks(root) {
    $$('[data-project]', root).forEach(b => b.onclick = e => { e.preventDefault(); openProject(b.dataset.project); });
  }

  // ---------- The page: one page for everyone. What a person may not do is hidden or switched off. ----------
  //
  //   Filter      one search box; every filter picked (week, status, person, team, project) is a tag inside it
  //   View        List · Board · Table (only the shape), Group by, Sort, Show empty groups
  //   Shortcuts   one-tap filters: My tasks, Open, Blocked, Done, Carried over, No update, the teams
  //   Employees see their own tasks (the database enforces it); the Person and Team filters, grouping by
  //   person or team, + Project, Meeting and Manage are for admins and department admins.

  /** The person whose tasks are shown: an employee always themselves; a manager anyone, or everyone (null). */
  const whoId = () => !isManager() || S.who === 'me' ? me().id : S.who !== 'all' && S.data.team.some(m => m.id === S.who) ? S.who : null;
  const peopleInView = () => { const w = whoId(); return w ? [member(w)] : filterPeople(); };
  const SPECIAL = { open: t => !isDone(t), carried: t => !isDone(t) && t.week < THIS };
  const statusOk = t => S.fStatus === 'all' || (SPECIAL[S.fStatus] ? SPECIAL[S.fStatus](t) : t.status === S.fStatus);
  /** The tasks the filters let through (without the status filter: what the shortcut counts are made of). */
  function tasksInView(withStatus) {
    const ws = weeksOf(S.week), w = whoId(), q = S.q.trim();
    return S.data.tasks.filter(t => inWeeks(t, ws) && (!w || ownersOf(t).indexOf(w) !== -1) &&
      (!isManager() || ownersOf(t).some(id => teamMatch(teamKeyOf(member(id))))) &&
      (S.fProject === 'all' || (S.fProject === 'none' ? !t.projectId : t.projectId === S.fProject)) && searchOk(t, q) && (!withStatus || statusOk(t)));
  }
  /** Everything that can be filtered. The search box, its tags and the shortcuts all read this one list. */
  function filterDefs() {
    const weeks = [[THIS, 'This week · ' + wnum(THIS)], [NEXT, 'Next week · ' + wnum(NEXT)]];
    for (let n = 1; n <= (isManager() ? 8 : 1); n++) { const w = shiftWeek(THIS, -n); weeks.push([w, (n === 1 ? 'Last week · ' : 'Week ') + wnum(w)]); }
    const defs = [
      { k: 'week', label: 'Week', def: 'now', opts: weeks },
      { k: 'fStatus', label: 'Status', def: 'all', opts: [['open', 'Open (not done)']].concat(STATUSES, [['carried', 'Carried over']]) },
    ];
    if (isManager()) {
      defs.push({ k: 'who', label: 'Person', def: 'all', opts: [['me', 'Me']].concat(filterPeople().filter(m => m.id !== me().id).map(m => [m.id, m.name])) });
      const teams = [];
      departments().forEach(d => {
        const cols = deptTeams(d.id);
        teams.push(['dept:' + d.id, d.name + (cols.length > 1 ? ' (department)' : ''), d.id + ':' + cols[0]]);
        if (cols.length > 1) cols.forEach(c => teams.push(['team:' + d.id + ':' + c, teamLabel(d.id + ':' + c), d.id + ':' + c]));
      });
      teams.push(['team:' + MGMT, 'Management', MGMT]);
      defs.push({ k: 'tfilter', label: 'Team', def: 'all', opts: teams });
    }
    defs.push({ k: 'fProject', label: 'Project', def: 'all', opts: S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1 || p.id === S.fProject)
      .sort((a, b) => a.name.localeCompare(b.name)).map(p => [p.id, p.name]).concat([['none', 'No project']]) });
    return defs;
  }
  const fval = k => k === 'tfilter' ? teamFilter() : S[k];
  function setFilter(k, v) {
    S[k] = v;
    if (k === 'tfilter') S.who = 'all';   // the people to pick from follow the team
  }

  // ---------- Grouping and sorting: the same for List, Board and Table ----------

  /** `set(key, task)`: what changes when a task is dragged into that group (none: the grouping is for looking only). */
  const FIELD = {
    project: { label: 'Project', keys: t => [t.projectId], title: k => project(k).name, set: k => ({ projectId: k }) },
    person: { label: 'Person', keys: t => ownersOf(t), title: k => member(k).name, set: k => ({ assigneeIds: [k] }) },
    team: { label: 'Team', keys: t => [taskTeam(t)], title: k => teamLabel(k) },
    status: { label: 'Status', keys: t => [t.status], title: statusLabel, set: (k, t) => statusChange(t, k) },
    week: { label: 'Week', keys: t => [shownWeek(t)], title: k => 'Week ' + wnum(k) + (k === THIS ? ' · this week' : k === NEXT ? ' · next week' : ''), set: k => ({ week: k }) },
    none: { label: 'No grouping', keys: () => [''], title: () => 'All tasks' },
  };
  const groupFields = () => isManager() ? ['project', 'person', 'team', 'status', 'week', 'none'] : ['project', 'status', 'week', 'none'];
  const SORTS = {
    added: ['Date added', (a, b) => (a.createdRaw || '').localeCompare(b.createdRaw || '')],
    title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
    status: ['Status', (a, b) => STATUSES.findIndex(s => s[0] === a.status) - STATUSES.findIndex(s => s[0] === b.status)],
    changed: ['Last changed', (a, b) => (b.version || '').localeCompare(a.version || '')],
  };
  /** Layout, grouping, sorting and "show empty" are remembered on the device. */
  function prefs() {
    if (!S.layout) S.layout = ['board', 'table'].indexOf(remember.get('layout')) !== -1 ? remember.get('layout') : 'list';
    if (!S.sort) S.sort = SORTS[remember.get('sort')] ? remember.get('sort') : 'added';
    if (S.showEmpty === null) S.showEmpty = remember.get('show-empty') !== '0';
    const fields = groupFields();
    if (fields.indexOf(S.group) === -1) S.group = fields.indexOf(remember.get('group')) !== -1 ? remember.get('group') : 'project';
    if (S.layout === 'board' && S.group === 'none') S.group = 'status';
  }
  /** Every group a grouping could show, inside the filters in use: all open projects, all people, all teams, all statuses... */
  function allKeys(gid) {
    const w = whoId();
    if (gid === 'project') return S.fProject === 'none' ? [''] : S.fProject !== 'all' ? [S.fProject] : openProjects().map(p => p.id).concat(['']);
    if (gid === 'person') return peopleInView().map(m => m.id);
    if (gid === 'team') return teamKeys().filter(k => w ? k === teamKeyOf(member(w)) : teamMatch(k));
    if (gid === 'status') return S.fStatus === 'all' ? STATUSES.map(s => s[0]) : SPECIAL[S.fStatus] ? ['To Do', 'In Progress', 'Blocked'] : [S.fStatus];
    if (gid === 'week') return weeksOf(S.week);
    return [''];
  }
  /**
   * Groups in a fixed order: names A–Z ("No project" last), teams, statuses and weeks in their own order. A change to a
   * task never moves a group. "Show empty" adds the groups with no tasks (not while searching).
   */
  function groups(list) {
    const gid = S.group, f = FIELD[gid], map = {};
    if (S.showEmpty && !S.q.trim()) allKeys(gid).forEach(k => { map[k] = []; });
    const inView = gid === 'person' ? peopleInView().map(m => m.id) : null;
    list.forEach(t => {
      let keys = f.keys(t);
      if (inView && keys.some(k => inView.indexOf(k) !== -1)) keys = keys.filter(k => inView.indexOf(k) !== -1);   // a shared task: only under the people in view
      keys.forEach(k => { (map[k] = map[k] || []).push(t); });
    });
    const order = gid === 'team' ? teamKeys() : gid === 'status' ? STATUSES.map(s => s[0]) : null;
    const keys = Object.keys(map).sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : gid === 'week' ? a.localeCompare(b) : (a === '') - (b === '') || f.title(a).localeCompare(f.title(b)));
    const cmp = SORTS[S.sort][1];
    return keys.map(k => ({ key: k, title: f.title(k), tasks: map[k].slice().sort(cmp), field: gid }));
  }
  /** May this person move tasks into this group (by dragging), or add a task straight into it? */
  const canSet = g => !!FIELD[g.field].set && (g.field !== 'person' || canAddFor(g.key)) && (g.field !== 'project' || CLOSED.indexOf(project(g.key).status) === -1);
  const canAddTo = g => g.field !== 'team' && (g.field === 'none' || canSet(g));
  /** Add a task from the line under a group: it takes the group's project, person, status or week (and no project, unless the group or the filter names one). */
  async function addInline(title, g) {
    const ws = weeksOf(S.week);
    const v = { title: title, projectId: S.fProject !== 'all' && S.fProject !== 'none' ? S.fProject : '', week: ws.indexOf(THIS) !== -1 ? THIS : ws[0], forId: defaultFor(), status: 'To Do' };
    if (g.field === 'project') v.projectId = g.key;
    if (g.field === 'person') v.forId = g.key;
    if (g.field === 'status') v.status = g.key;
    if (g.field === 'week') v.week = g.key;
    if (CLOSED.indexOf(project(v.projectId).status) !== -1) return quickAddSheet({ title: title, week: v.week, forId: v.forId, status: v.status });   // a closed project: pick another
    if (await addTask(v)) toast('Added · ' + project(v.projectId).name + (v.forId === me().id ? '' : ' · for ' + shortName(member(v.forId).name)));
    render();
  }

  // ---------- Layouts ----------

  const addLine = (g, i) => canAddTo(g) ? `<form class="w-add" data-form="add" data-g="${i}"><input id="add-${i}" data-keep="add-${esc(g.field + ':' + g.key)}" autocomplete="off" maxlength="300" placeholder="+ Add a task${g.field === 'none' ? '' : ' to ' + esc(g.title)} (type, then Enter)" aria-label="Add a task${g.field === 'none' ? '' : ' to ' + esc(g.title)}"></form>` : '';
  const groupMark = g => g.field === 'person' ? av(g.key) : g.field === 'team' ? `<span class="w-dot tc-${slug(g.title)}"></span>` : '';
  function groupHead(g, i) {
    const p = g.field === 'project' && g.key ? project(g.key) : null;
    return `<button type="button" class="w-caret" data-act="fold" data-g="${i}" aria-label="Fold or unfold ${esc(g.title)}">${S.folded[g.field + ':' + g.key] ? '▸' : '▾'}</button>
      <div class="w-gtitle">${groupMark(g)}${p ? `<button type="button" class="w-gname" data-act="project" data-id="${esc(p.id)}">${esc(g.title)}</button>` : `<h3 class="w-gname">${esc(g.title)}</h3>`}<span class="w-count">${g.tasks.length}</span>
        ${g.field === 'person' ? teamChip(teamKeyOf(member(g.key))) : ''}${p ? statusPill(p) + `<span class="tchips">${teamsOnProject(p.id).map(k => teamChip(k)).join('')}</span>` : ''}</div>
      ${p && isManager() ? `<button type="button" class="w-chip" data-act="editproject" data-id="${esc(p.id)}" aria-label="Edit project ${esc(p.name)}">✎<span class="w-txt">&nbsp;Edit project</span></button>` : '<span></span>'}`;
  }
  /** People on a task, unless the group already says who (a task shared with others still shows everyone). */
  const peopleCell = (t, gid) => gid === 'person' && ownersOf(t).length < 2 && !liveContacts(t).length ? '' : avatars(t);
  function listHtml(gs) {
    return `<div class="w-groups">${gs.map((g, i) => `<section class="w-grp" data-group="${esc(g.key)}"><header class="w-ghead">${groupHead(g, i)}</header>
      ${S.folded[g.field + ':' + g.key] ? '' : g.tasks.map(t => `<div class="w-row${isDone(t) ? ' done' : ''}${S.task === t.id ? ' sel' : ''}">
        <button type="button" class="w-chk${isDone(t) ? ' on' : ''}" data-act="done" data-id="${t.id}"${canEditTask(t) ? '' : ' disabled'} aria-label="${isDone(t) ? 'Mark as not done' : 'Mark as done'}">${isDone(t) ? '✓' : ''}</button>
        <div><button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button><div class="w-meta">${tagsHtml(t, g.field)}</div></div>
        <div class="w-side"><span class="c-sub">${subsChip(t)}</span><span class="c-cmt">${cmtChip(t)}</span><span class="c-ppl">${peopleCell(t, g.field)}</span><span class="c-st">${statusSel(t)}</span></div>
        ${S.subsOpen[t.id] && t.subtasks.length ? subsHtml(t, 'r', false) : ''}</div>`).join('') + addLine(g, i)}</section>`).join('')}</div>`;
  }
  function boardHtml(gs) {
    return `<div class="w-board">${gs.map((g, i) => `<section class="w-col" data-col="${esc(g.key)}"${canSet(g) ? ` data-drop="${i}"` : ''}><header class="w-chead">${groupMark(g)}<h3>${esc(g.title)}</h3><span class="w-count">${g.tasks.length}</span></header>
      ${g.tasks.map(t => { const drag = canSet(g) && canEditTask(t); return `<article class="w-card${isDone(t) ? ' done' : ''}${S.task === t.id ? ' sel' : ''}"${drag ? ` data-drag="${t.id}"` : ''}>
        <div class="w-ctitle">${drag ? '<span class="grip" title="Drag to move">⋮⋮</span>' : ''}<button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button></div>
        <div class="w-meta">${tagsHtml(t, g.field)}</div>
        <div class="w-meta">${subsChip(t)}${cmtChip(t)}<span class="w-grow"></span>${peopleCell(t, g.field)}${g.field === 'status' ? '' : statusSel(t)}</div>
        ${S.subsOpen[t.id] && t.subtasks.length ? subsHtml(t, 'r', false) : ''}</article>`; }).join('')}
      ${addLine(g, i) || (g.tasks.length ? '' : '<p class="muted small w-none">Nothing here</p>')}</section>`).join('')}</div>`;
  }
  function tableHtml(gs) {
    return `<div class="w-twrap"><table class="w-table"><thead><tr><th>Task</th><th>Project</th><th>Person</th><th>Week</th><th>Status</th><th>Sub-tasks</th><th>Comments</th></tr></thead><tbody>
      ${gs.map((g, i) => (g.field === 'none' ? '' : `<tr class="w-gh"><td colspan="7">${groupMark(g)} ${esc(g.title)} <span class="w-count">${g.tasks.length}</span></td></tr>`) +
        g.tasks.map(t => { const edit = canEditTask(t); return `<tr class="${isDone(t) ? 'done' : ''}${S.task === t.id ? ' sel' : ''}">
        <td class="w-tt"><button type="button" class="w-title" data-act="open" data-id="${t.id}">${esc(t.title)}</button>${t.week < THIS && !isDone(t) ? ` <span class="tag-carry">from week ${wnum(t.week)}</span>` : ''}${isBlocked(t) && t.blockNote ? ` <span class="tag-block">${esc(t.blockNote)}</span>` : ''}${S.subsOpen[t.id] && t.subtasks.length ? subsHtml(t, 'r', false) : ''}</td>
        <td>${edit ? pickerBtn('project', t.id, project(t.projectId).name, 'cell') : esc(project(t.projectId).name)}</td>
        <td><span class="w-meta">${avatars(t)} ${esc(ownersOf(t).map(id => shortName(member(id).name)).join(', '))}</span></td>
        <td>${edit ? `<select class="w-cell" id="tw-${t.id}" data-chg="week" data-id="${t.id}" aria-label="Week">${weekChoices(t.week)}</select>` : 'Week ' + wnum(t.week)}</td>
        <td>${statusSel(t)}</td><td>${subsChip(t) || '<span class="muted">–</span>'}</td><td>${cmtChip(t) || '<span class="muted">–</span>'}</td></tr>`; }).join('') +
        (addLine(g, i) ? `<tr class="w-addtr"><td colspan="7">${addLine(g, i)}</td></tr>` : '')).join('')}</tbody></table></div>`;
  }
  /**
   * Drag and drop with a mouse or a finger (on a phone: the ⋮⋮ handle, so the page still scrolls):
   * move a card over another column and let go. The task takes that column's status, project, week or person.
   */
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
          const box = root.getBoundingClientRect();   // the data area scrolls, not the page
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
          if (!g || !t || !canSet(g) || !canEditTask(t) || (FIELD[g.field].keys(t).length === 1 && FIELD[g.field].keys(t)[0] === g.key)) return;
          updateTask(t, x => FIELD[g.field].set(g.key, x));
          toast('Moved to ' + g.title);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
      });
    });
  }

  // ---------- The top of the page: search and filter, actions, View, Shortcuts ----------

  /** Under the search box: the tasks that match what is typed (from every week), and every filter choice that matches. */
  function suggHtml(defs) {
    const q = S.q.trim().toLowerCase();
    const gs = defs.map(d => ({ d: d, opts: d.opts.filter(o => o[0] !== fval(d.k) && (!q || (d.label + ' ' + o[1]).toLowerCase().indexOf(q) !== -1)) })).filter(g => g.opts.length);
    const w = whoId();
    const hits = q ? S.data.tasks.filter(t => (!w || ownersOf(t).indexOf(w) !== -1) && searchOk(t, q)).sort((a, b) => b.week.localeCompare(a.week)).slice(0, 6) : [];
    const mark = (d, o) => d.k === 'who' ? av(o[0] === 'me' ? me().id : o[0]) : d.k === 'tfilter' ? `<span class="w-dot tc-${slug(teamLabel(o[2]))}"></span>` : '';
    return `<div class="w-sugg" id="sugg">
      ${q ? '' : '<p class="muted small w-sugg-tip">Type to search tasks, or pick a filter below. Each filter you pick becomes a tag in the box.</p>'}
      ${hits.length ? `<h4>Tasks</h4><div class="w-sugg-items col">${hits.map(t => `<button type="button" class="w-hit" data-act="gopen" data-id="${t.id}"><span>${esc(t.title)}</span><small class="muted">${esc(project(t.projectId).name)} · week ${wnum(t.week)} · ${esc(statusLabel(t.status))}</small></button>`).join('')}</div>` : ''}
      ${gs.map(g => `<h4>Filter by ${g.d.label.toLowerCase()}</h4><div class="w-sugg-items">${g.opts.map(o => `<button type="button" class="w-opt" data-act="filter" data-k="${g.d.k}" data-v="${esc(o[0])}">${mark(g.d, o)}${esc(o[1])}</button>`).join('')}</div>`).join('')}
      ${q && !gs.length && !hits.length ? '<p class="muted small w-sugg-tip">Nothing matches.</p>' : ''}</div>`;
  }
  function searchHtml(defs) {
    const chips = defs.filter(d => fval(d.k) !== d.def).map(d => {
      const o = d.opts.find(x => x[0] === fval(d.k));
      return `<span class="w-fchip">${d.label}: <b>${esc(o ? o[1].replace(' (department)', '') : d.k === 'who' ? member(S.who).name : fval(d.k))}</b><button type="button" class="w-x" data-act="unfilter" data-k="${d.k}" aria-label="Remove the ${d.label.toLowerCase()} filter">×</button></span>`;
    }).join('');
    return `<div class="w-gbox"><span class="w-label">Filter</span>
        ${isManager() ? '' : '<span class="w-fchip locked" title="You see your own tasks">Person: <b>Me</b></span>'}${chips}
        <input type="search" id="gq" placeholder="Search tasks, or filter by ${isManager() ? 'project, person, team, status, week' : 'project, status, week'}…" value="${esc(S.q)}" autocomplete="off" aria-label="Search and filter">
        ${chips || S.q ? '<button type="button" class="text-btn" data-act="clear" id="clearFilters">Clear</button>' : ''}</div>
      ${S.searchOpen ? suggHtml(defs) : ''}`;
  }
  /** The week the minutes and "No update" are about. */
  const meetWeek = () => S.week === 'now' ? THIS : S.week;
  /** Managers: the weekly meeting of the department in the Team filter (email, save the minutes, past minutes). */
  function meetingItems() {
    const d = filterDept(), week = meetWeek();
    if (!d) return '<p class="muted small w-menu-note">Pick a department in the <b>Team</b> filter to email or save its minutes.</p>';
    if (!((d + ':' + week) in S.minutes)) loadMinutes(week);
    const saved = S.minutes[d + ':' + week], has = !!(saved && saved.snapshot);
    return `<p class="muted small w-menu-note">${esc(dept(d).name)} · week ${wnum(week)}${has ? '<br>Saved ' + esc(saved.savedAt) + (saved.savedBy ? ' by ' + esc(member(saved.savedBy).name) : '') : week < THIS && saved === null ? '<br>Not saved: rebuilt from today’s tasks' : ''}</p>
      <button type="button" data-act="copyemail" id="copyEmail">Copy as email</button>
      ${canManage(d) && week <= THIS ? `<button type="button" data-act="savemins" id="saveMins">${has ? 'Update saved minutes' : 'Save minutes'}</button>` : ''}
      ${has ? '<button type="button" data-act="viewsaved" id="viewSaved">View saved copy</button>' : ''}
      <button type="button" data-act="archive" id="archiveBtn">Past minutes</button>`;
  }
  const menu = (id, label, items, cls) => `<details class="w-menu ${cls || ''}" id="${id}"><summary class="secondary small-btn" role="button">${label} ▾</summary><div class="w-menu-items">${items}</div></details>`;
  function actionsHtml() {
    const m = isManager();
    return `${m ? menu('meetMenu', 'Meeting', meetingItems(), 'w-wide') : ''}
      ${m ? '<button type="button" class="secondary small-btn w-wide" data-act="newproject" id="newProject">+ Project</button>' : ''}
      <button type="button" class="primary small" data-act="newtask" id="addTaskBtn">${icon('plus')} Task</button>
      ${m ? `<button type="button" class="secondary small-btn w-wide" data-act="manage" id="manageBtn" title="People and passwords, projects, departments, 3rd parties">${icon('settings')} Manage</button>` : ''}
      ${m ? menu('moreMenu', 'More', `<button type="button" data-act="newproject">+ Project</button><button type="button" data-act="manage">Manage</button><hr>${meetingItems().replace(/ id="[^"]+"/g, '')}`, 'w-narrow') : ''}`;
  }
  function barsHtml(base) {
    const sel = (key, label, opts) => `<label class="w-f"><span>${label}</span><select id="v-${key}" data-chg="${key}">${opts.map(o => `<option value="${esc(o[0])}"${o[0] === S[key] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    const n = fn => base.filter(fn).length;
    const short = (k, v, label, cls, count) => `<button type="button" class="w-kpi ${cls || ''}${fval(k) === v ? ' on' : ''}" data-act="short" data-k="${k}" data-v="${esc(v)}" aria-pressed="${fval(k) === v}">${count === undefined ? '' : `<b>${count}</b>`}${label}</button>`;
    const m = isManager(), week = meetWeek();
    const quiet = m && week <= THIS ? quietPeople(week, peopleInView()) : [];
    const teams = m ? filterDefs().find(d => d.k === 'tfilter').opts.filter(o => o[0].indexOf('team:') === 0 || deptTeams(o[0].slice(5)).length < 2) : [];
    const what = S.layout === 'board' ? 'columns' : 'groups';
    const plan = !m || whoId() === me().id;
    const day = new Date().getDay();
    const nudge = plan && weeksOf(S.week).indexOf(THIS) !== -1 && (day === 0 || day >= 4) && remember.get('plan-dismissed') !== NEXT &&
      !S.data.tasks.some(t => t.week === NEXT && ownersOf(t).indexOf(me().id) !== -1);
    return `<div class="w-bars">
        <div class="w-bar"><span class="w-label">View</span>
          <div class="w-seg" role="group" aria-label="Layout">${[['list', 'List'], ['board', 'Board'], ['table', 'Table']].map(l => `<button type="button" data-act="layout" data-k="${l[0]}" class="${S.layout === l[0] ? 'on' : ''}" aria-pressed="${S.layout === l[0]}">${l[1]}</button>`).join('')}</div>
          ${sel('group', S.layout === 'board' ? 'Columns' : 'Group by', groupFields().filter(k => S.layout !== 'board' || k !== 'none').map(k => [k, FIELD[k].label]))}
          ${sel('sort', 'Sort', Object.keys(SORTS).map(k => [k, SORTS[k][0]]))}
          <label class="w-f tick" title="Also show the ${what} that have no tasks"><input type="checkbox" id="v-empty" data-chg="empty"${S.showEmpty ? ' checked' : ''}><span>Show empty ${what}</span></label>
        </div>
        <div class="w-bar"><span class="w-label">Shortcuts</span>
          ${m ? short('who', 'me', 'My tasks') + '<span class="w-sep"></span>' : ''}
          ${short('fStatus', 'open', 'Open', '', n(SPECIAL.open))}${short('fStatus', 'Blocked', 'Blocked', 'k-bad', n(isBlocked))}${short('fStatus', 'Done', 'Done', 'k-ok', n(isDone))}${short('fStatus', 'carried', 'Carried over', 'k-warn', n(SPECIAL.carried))}
          ${m && week <= THIS ? `<button type="button" class="w-kpi${S.quiet ? ' on' : ''}" data-act="quiet" id="quietBtn" aria-expanded="${S.quiet}"><b>${quiet.length}</b>No update</button>` : ''}
          ${teams.length ? '<span class="w-sep"></span>' + teams.map(o => short('tfilter', o[0], `<span class="w-dot"></span>${esc(o[1])}`, 'tc-' + slug(teamLabel(o[2])))).join('') : ''}
        </div>
      </div>
      ${m && S.quiet && week <= THIS ? `<div class="w-note" id="quietBox"><span><b>No update in week ${wnum(week)}:</b> ${quiet.length ? quiet.map(x => `${av(x.m.id)} ${esc(x.m.name)} <small class="muted">${x.last ? 'last ' + ago(x.last) : 'never'}</small>`).join(' · ') : 'everyone has updated'}</span>
        ${quiet.length && week === THIS ? '<button type="button" class="secondary small-btn" data-act="reminder" id="copyReminder">Copy reminder</button>' : ''}</div>` : ''}
      ${nudge ? `<div class="w-note" id="planNudge"><span><b>Plan next week.</b> You have nothing planned for week ${wnum(NEXT)} yet.</span>
        <span class="w-pchips"><button type="button" class="primary small" data-act="plannext" id="planNext">Plan week ${wnum(NEXT)}</button><button type="button" class="text-btn" data-act="planlater" id="planLater">Later</button></span></div>` : ''}`;
  }

  // ---------- Drawing ----------

  /** Manage (people and passwords, projects, departments, 3rd parties): a window over the page, so nobody leaves their tasks. */
  function openManage() {
    const dlg = $('#manageDlg');
    dlg.innerHTML = '<div class="sheet"><header class="sheet-head"><span></span><h3>Manage</h3><button type="button" class="text-btn strong" data-close>Done</button></header><div class="sheet-body" id="manageRoot"></div></div>';
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.onclose = () => render();
    viewManage($('#manageRoot'));
    if (!dlg.open) dlg.showModal();
  }
  /**
   * Draws the page from the state. Only the data area scrolls, and it keeps its place. What is being
   * typed (search, a new task or sub-task) and the cursor survive the redraw.
   */
  function render() {
    if (!S.data) return;
    S.pendingRender = false;
    prefs();
    const act = document.activeElement, fid = act && act.id, pos = act && typeof act.selectionStart === 'number' ? act.selectionStart : null;
    const kept = {};
    $$('#shell [data-keep]').forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    const openMenus = $$('#shell details.w-menu[open]').map(d => d.id);
    const body = $('#panel .w-pbody'), scroll = body ? body.scrollTop : 0;

    $('#avatarBtn').textContent = initials(me().name);
    $('#avatarBtn').title = me().name;
    const defs = filterDefs();
    if (S.fProject !== 'all' && S.fProject !== 'none' && !S.data.projects.some(p => p.id === S.fProject)) S.fProject = 'all';   // removed meanwhile
    const base = tasksInView(false), list = base.filter(statusOk), gs = groups(list);
    render.groups = gs;
    $('#gsearch').innerHTML = searchHtml(defs);
    $('#topActions').innerHTML = actionsHtml();
    $('#bars').innerHTML = barsHtml(base);
    const view = $('#view');
    view.className = 'w-data w-' + S.layout;
    view.innerHTML = (S.layout === 'board' ? boardHtml(gs) : S.layout === 'table' ? tableHtml(gs) : listHtml(gs)) +
      (list.length ? '' : `<p class="empty w-empty">No tasks ${S.q.trim() || defs.some(d => fval(d.k) !== d.def) ? 'match the search and filters' : 'this week or next'}. Use <b>+ Task</b> to add one.</p>`);
    if (S.layout === 'board') bindBoard(view, gs);

    // The panel on the right: the open task, or the open project
    const panel = $('#panel');
    const t = S.task && findTask(S.task), p = !t && S.project && S.data.projects.find(x => x.id === S.project);
    if (!t) S.task = null;
    if (!p) S.project = null;
    $('#shell').classList.toggle('panel-on', !!(t || p));
    panel.hidden = !(t || p);
    panel.innerHTML = t ? taskPanelHtml(t) : p ? projectPanelHtml(p) : '';
    if (p) bindTeamEditor(panel, p);
    const nb = $('#panel .w-pbody'); if (nb) nb.scrollTop = scroll;

    if ($('#manageDlg').open) viewManage($('#manageRoot'));
    $$('#shell [data-keep]').forEach(i => { if (kept[i.dataset.keep] && !i.value) i.value = kept[i.dataset.keep]; });
    openMenus.forEach(id => { const d = id && document.getElementById(id); if (d) d.open = true; });
    if (fid && $('#shell').contains(act) === false) {
      const el = document.getElementById(fid);
      if (el && $('#shell').contains(el)) { restoring = true; el.focus(); restoring = false; if (pos !== null && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text box */ } } }
    }
  }
  let restoring = false;   // true while render() puts the cursor back (so that does not count as "the person focused the search box")

  function showLogin(message) {
    document.body.classList.remove('signed-in');
    $('#shell').hidden = true;
    $('#view').innerHTML = '';
    $('#loginView').hidden = false;
    const err = $('#loginError');
    err.textContent = message || '';
    err.hidden = !message;
  }

  function showApp() {
    $('#loginView').hidden = true;
    $('#shell').hidden = false;
    document.body.classList.add('signed-in');
    render();
  }

  // ---------- What happens when something on the page is tapped, changed or typed ----------

  const closeSugg = () => { S.searchOpen = false; const s = $('#sugg'); if (s) s.remove(); };
  const ACTIONS = {
    layout: (b, k) => { S.layout = k; remember.set('layout', k); },
    fold: b => { const g = render.groups[Number(b.dataset.g)], key = g.field + ':' + g.key; S.folded[key] = !S.folded[key]; },
    subs: (b, k, t) => { S.subsOpen[t.id] = !S.subsOpen[t.id]; },
    open: (b, k, t) => { if (Date.now() - (S.dragged || 0) < 400) return false; S.task = S.task === t.id ? null : t.id; S.project = null; },
    gopen: (b, k, t) => { S.task = t.id; S.project = null; S.searchOpen = false; },
    close: () => { S.task = null; S.project = null; },
    done: (b, k, t) => { const done = !isDone(t); updateTask(t, x => done ? statusChange(x, 'Done') : { status: 'To Do' }); if (done) toast('Done ✔ — it goes into this week’s meeting'); return false; },
    pstatus: (b, k, t) => { updateTask(t, x => statusChange(x, k)); return false; },
    reason: (b, k, t) => { updateTask(t, { blockNote: k }); return false; },
    subdel: (b, k, t) => { updateTask(t, subEdit(t, Number(b.dataset.i), () => null)); return false; },
    unasg: (b, k, t) => { updateTask(t, x => ({ assigneeIds: x.assigneeIds.filter(y => y !== k) })); return false; },
    unext: (b, k, t) => { updateTask(t, x => ({ contactIds: x.contactIds.filter(y => y !== k) })); return false; },
    del: (b, k, t) => {
      if (!confirm('Delete this task?')) return false;
      S.lastWrite = Date.now();
      Api.deleteTask(t.id).then(() => toast('Task deleted'), e => toast(e.message, true)).then(() => { if (S.task === t.id) S.task = null; render(); });
      return false;
    },
    cmtdel: b => {
      if (!confirm('Delete this comment?')) return false;
      S.lastWrite = Date.now();
      guard(() => Api.deleteComment(b.dataset.cid)).then(render);
      return false;
    },
    filter: (b, k) => { setFilter(k, b.dataset.v); S.q = ''; S.searchOpen = false; },
    unfilter: (b, k) => setFilter(k, k === 'week' ? 'now' : 'all'),
    short: (b, k) => setFilter(k, fval(k) === b.dataset.v ? 'all' : b.dataset.v),
    clear: () => { S.week = 'now'; S.fStatus = 'all'; S.fProject = 'all'; S.who = 'all'; S.tfilter = 'all'; S.q = ''; S.searchOpen = false; },
    quiet: () => { S.quiet = !S.quiet; },
    picker: b => { openPicker(b); return false; },
    pick: b => { picked(b); return false; },
    project: b => { openProject(b.dataset.id); return false; },
    joinp: b => { S.lastWrite = Date.now(); guard(() => Api.joinProject(b.dataset.id)).then(render); return false; },
    leavep: b => {
      if (!confirm('Leave ' + project(b.dataset.id).name + '? Your tasks stay on the project.')) return false;
      S.lastWrite = Date.now(); guard(() => Api.leaveProject(b.dataset.id)).then(render); return false;
    },
    addto: b => { quickAddSheet({ pid: b.dataset.id }); return false; },
    onlyproject: b => { S.fProject = b.dataset.id; S.project = null; },
    editproject: b => { editProject(b.dataset.id); return false; },
    newtask: () => { quickAddSheet({}); return false; },
    newproject: () => { projectForm({ type: 'Other', status: 'In Progress', priority: 'Medium', assigned: [] }); return false; },
    manage: () => { openManage(); return false; },
    copyemail: () => { copyEmail(buildMinutes(meetWeek())); return false; },
    archive: () => { minutesArchive(); return false; },
    viewsaved: () => { const rec = S.minutes[filterDept() + ':' + meetWeek()]; if (rec && rec.snapshot) savedMinutesSheet(rec); return false; },
    savemins: () => {
      const d = filterDept(), week = meetWeek(), key = d + ':' + week, saved = S.minutes[key];
      if (saved && saved.snapshot && !confirm('Replace the saved minutes for week ' + wnum(week) + ' with today’s tasks?')) return false;
      guard(() => Api.saveMinutes(week, buildMinutes(week), d)).then(rec => { if (rec) { S.minutes[key] = rec; toast('Minutes saved'); render(); } });
      return false;
    },
    reminder: () => {
      const week = meetWeek();
      copyText('Hi ' + quietPeople(week, peopleInView()).map(x => x.m.name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0]).join(', ') +
        ' — please add your tasks for week ' + wnum(week) + ' in Weekly Tasks before the meeting: ' + location.origin + location.pathname,
      'Reminder copied — paste it into your team chat');
      return false;
    },
    plannext: () => { quickAddSheet({ week: NEXT }); return false; },
    planlater: () => { remember.set('plan-dismissed', NEXT); },
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if ($('#pop') && !e.target.closest('#pop') && !(b && b.dataset.act === 'picker')) closePicker();
    if (S.searchOpen && !e.target.closest('#gsearch')) closeSugg();
    $$('#shell details.w-menu[open]').forEach(d => { if (!d.contains(e.target) || b) d.open = false; });
    if (!b || !S.data || !ACTIONS[b.dataset.act]) return;
    const t = b.dataset.id ? findTask(b.dataset.id) : null;
    if (ACTIONS[b.dataset.act](b, b.dataset.k, t) !== false) render();   // an action that draws the page itself (or opens a sheet) returns false
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (!S.data || !el.closest || !el.closest('#shell')) return;
    const c = el.dataset.chg, x = el.dataset.txt, t = el.dataset.id ? findTask(el.dataset.id) : null;
    if (c === 'group' || c === 'sort') { S[c] = el.value; remember.set(c, el.value); return render(); }
    if (c === 'empty') { S.showEmpty = el.checked; remember.set('show-empty', el.checked ? '1' : '0'); return render(); }
    if (!t) return;
    if (c === 'status') updateTask(t, y => statusChange(y, el.value));
    else if (c === 'week') { updateTask(t, { week: el.value }); toast('Moved to week ' + wnum(el.value)); }
    else if (c === 'subc') updateTask(t, subEdit(t, Number(el.dataset.i), s => ({ t: s.t, done: el.checked })));
    else if (x === 'title') { const v = el.value.replace(/\s+/g, ' ').trim(); if (v && v !== t.title) quietUpdate(t, { title: v }); else el.value = t.title; }
    else if (x === 'block') { const v = el.value.trim(); if (v !== t.blockNote) quietUpdate(t, { blockNote: v }); }
    else if (x === 'sub') {
      const i = Number(el.dataset.i), v = el.value.replace(/\s+/g, ' ').trim();
      if (v && t.subtasks[i] && v !== t.subtasks[i].t) quietUpdate(t, subEdit(t, i, s => ({ t: v, done: s.done }))); else if (t.subtasks[i]) el.value = t.subtasks[i].t;
    }
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'gq') { S.q = el.value; S.searchOpen = true; render(); }
    else if (el.id === 'pop-q') {
      const q = el.value.trim().toLowerCase(); let n = 0;
      $$('.w-pop-item').forEach(i => { const ok = i.textContent.toLowerCase().indexOf(q) !== -1; i.hidden = !ok; if (ok) n++; });
      $('#pop-none').hidden = n > 0; $('#pop-none').textContent = 'Nothing matches';
    }
  });
  document.addEventListener('focusin', e => {
    if (restoring || !S.data) return;
    if (e.target.id === 'gq') { if (!S.searchOpen) { S.searchOpen = true; render(); } }
    else if (S.searchOpen && !(e.target.closest && e.target.closest('#gsearch'))) closeSugg();
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-form]');
    if (!f || !S.data) return;
    e.preventDefault();
    const kind = f.dataset.form, t = f.dataset.id ? findTask(f.dataset.id) : null, i = $('input, textarea', f);
    const v = kind === 'comment' ? i.value.trim() : i.value.replace(/\s+/g, ' ').trim();   // a comment keeps its line breaks
    if (!v) return;
    i.value = '';
    if (kind === 'add') addInline(v, render.groups[Number(f.dataset.g)]);
    else if (kind === 'sub' && t) updateTask(t, y => ({ subtasks: y.subtasks.concat({ t: v, done: false }) }));
    else if (kind === 'comment' && t) { S.lastWrite = Date.now(); guard(() => Api.addComment(t.id, v)).then(render); }
    else if (kind === 'ext' && t) {
      guard(() => Api.addContact(v)).then(c => {
        if (!c) return;
        const cur = findTask(t.id);
        if (cur && cur.contactIds.indexOf(c.id) === -1) updateTask(cur, y => ({ contactIds: addId(y.contactIds, c.id) })); else render();
        toast(c.name + ' added — everyone can now pick them');
      });
    }
  });
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (el.id === 'pop-q' && e.key === 'Enter') { e.preventDefault(); const first = $$('.w-pop-item').find(i => !i.hidden); if (first) first.click(); return; }
    if (e.key === 'Escape') {
      if ($('#pop')) { e.preventDefault(); e.stopPropagation(); closePicker(); if (openPicker.btn && openPicker.btn.isConnected) openPicker.btn.focus(); }
      else if (S.searchOpen) closeSugg();
      else if ((S.task || S.project) && !$('#dialog').open && !$('#manageDlg').open) { S.task = null; S.project = null; render(); }
      return;
    }
    if (el.id === 'gq' && e.key === 'Enter') { e.preventDefault(); closeSugg(); return; }
    if (el.id === 'p-title' && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
    if (el.id === 'p-cmt' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.form.requestSubmit(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && $('#sugg') && el.closest && el.closest('#gsearch')) {
      const items = $$('#sugg button'), i = items.indexOf(el);
      const next = e.key === 'ArrowDown' ? items[i + 1] : i <= 0 ? $('#gq') : items[i - 1];
      if (next) { e.preventDefault(); next.focus(); }
    }
  }, true);

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
    const original = values.assigned || [];
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
        { name: 'assigned', label: 'People on the project', type: 'checklist',
          options: groupPeople(S.data.team.filter(m => m.active), d.id)
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
    // Admins only: delete the project. Its tasks go with it, so it asks first and offers "Canceled" instead.
    if (values.id && isAdmin()) {
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'ghost danger-text block'; del.id = 'deleteProject'; del.textContent = 'Delete project';
      del.addEventListener('click', async () => {
        const n = S.data.tasks.filter(t => t.projectId === values.id).length;
        if (!confirm('Delete ' + values.name + '?\n\nIts ' + n + ' task' + (n === 1 ? '' : 's') + ' and its team list are deleted for good, also from past weeks.' +
          '\n\nTo keep its history, set the status to Canceled instead.')) return;
        S.lastWrite = Date.now();
        try {
          await Api.deleteProject(values.id);
          $('#dialog').close();
          if (S.project === values.id) S.project = null;
          toast(values.name + ' deleted');
          render();
        } catch (e) { toast(e.message, true); }
      });
      $('#dialog .sheet-body').appendChild(del);
    }
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
      $('#shell').hidden = false;
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
