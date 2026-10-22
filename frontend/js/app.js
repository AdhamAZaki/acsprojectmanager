// ACS Weekly Tasks: UI. Plain JS, no build step. Mobile-first.
// Three screens: My tasks (this / next week), Projects (join, team tasks), Meeting (built from tasks).
(function () {
  const Api = window.Api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PROJECT_TYPES = ['PLC', 'AVEVA', 'AVEVA + PLC', 'BMS', 'Other'];
  // Same statuses as the Notion "Projects" database.
  const PROJECT_STATUSES = ['In Progress', 'Planning', 'Paused', 'Backlog', 'Done', 'Canceled'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const CLOSED = ['Done', 'Canceled'];

  const THIS = isoWeek(new Date());
  const NEXT = shiftWeek(THIS, 1);

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
  const typeClass = t => 'type-' + slug(t === 'AVEVA + PLC' ? 'aveva' : t);
  const isAdmin = () => S.data && S.data.me.role === 'Admin';
  const me = () => S.data.me;
  const member = id => S.data.team.find(m => m.id === id) || { name: 'Unknown', username: '', team: '' };
  const project = id => S.data.projects.find(p => p.id === id) || { id: id, name: '(removed project)', type: '', status: '' };
  const contact = id => S.data.contacts.find(c => c.id === id);

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
  function options(list, selected) {
    return list.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
  /** Meeting column: the task owner's team, else the project type. */
  function teamOf(t) {
    const owner = member(t.createdBy);
    if (owner.team) return owner.team;
    if (t.team) return t.team;
    return project(t.projectId).type === 'PLC' ? 'PLC' : 'Dev';
  }

  /** Change a task: show it immediately, save in the background, undo on error. */
  function updateTask(t, changes) {
    const before = Object.assign({}, t);
    const updated = Object.assign({}, t, changes);
    S.data.tasks = S.data.tasks.map(x => x.id === t.id ? updated : x);
    S.lastWrite = Date.now();
    render();
    return Api.saveTask(updated).catch(e => {
      S.data.tasks = S.data.tasks.map(x => x.id === t.id ? before : x);
      toast(e.message, true);
      render();
    });
  }
  const findTask = id => S.data.tasks.find(t => t.id === id);

  // ---------- Task rows (My tasks and project pages) ----------

  function taskHtml(t, showOwner) {
    const open = !!S.open[t.id];
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
          <div class="subs">
            ${t.subtasks.map((s, i) => `<label class="sub"><input type="checkbox" data-sub="${t.id}:${i}"${s.done ? ' checked' : ''}><span class="${s.done ? 'done' : ''}">${esc(s.t)}</span><button type="button" data-subdel="${t.id}:${i}" aria-label="Remove sub-task">×</button></label>`).join('')}
            <div class="inline"><input placeholder="Add a sub-task" data-newsub="${t.id}" autocomplete="off"><button type="button" class="secondary" data-addsub="${t.id}">Add</button></div>
          </div>
          <div class="people">
            ${team.concat(extra).map(m => `<label><input type="checkbox" data-asg="${t.id}:${m.id}"${t.assigneeIds.indexOf(m.id) !== -1 ? ' checked' : ''}><span class="avatar sm">${esc(initials(m.name))}</span>${esc(shortName(m.name))}</label>`).join('')}
            ${S.data.contacts.map(c => `<label class="ext"><input type="checkbox" data-ext="${t.id}:${c.id}"${t.contactIds.indexOf(c.id) !== -1 ? ' checked' : ''}>${esc(c.name)}</label>`).join('')}
          </div>
          <div class="inline"><input placeholder="Add someone outside the team" data-newext="${t.id}" autocomplete="off"><button type="button" class="secondary" data-addext="${t.id}">Add</button></div>
          ${isBlocked(t) ? `<input class="block-note" placeholder="What is blocking it?" data-blocknote="${t.id}" value="${esc(t.blockNote)}">` : ''}
          <div class="t-actions">
            <button type="button" class="${isBlocked(t) ? 'danger' : 'secondary'}" data-block="${t.id}">${isBlocked(t) ? 'Unblock' : 'Blocked?'}</button>
            <button type="button" class="secondary" data-move="${t.id}">${t.week === NEXT ? 'Move to this week' : 'Move to next week'}</button>
            ${isAdmin() || t.createdBy === me().id ? `<button type="button" class="ghost danger-text" data-del="${t.id}">Delete</button>` : ''}
          </div>
        </div>` : ''}
      </div>`;
  }

  function bindTasks(root) {
    const pair = v => v.split(':');
    $$('[data-done]', root).forEach(b => b.onclick = () => {
      const t = findTask(b.dataset.done);
      const done = !isDone(t);
      updateTask(t, done ? { status: 'Done', week: t.week < THIS ? THIS : t.week } : { status: 'To Do' });
      if (done) toast('Done ✔ — it goes into this week’s meeting');
    });
    $$('[data-toggle]', root).forEach(b => b.onclick = () => { S.open[b.dataset.toggle] = !S.open[b.dataset.toggle]; render(); });
    $$('[data-sub]', root).forEach(c => c.onchange = () => {
      const [tid, i] = pair(c.dataset.sub); const t = findTask(tid);
      updateTask(t, { subtasks: t.subtasks.map((s, k) => k === Number(i) ? { t: s.t, done: c.checked } : s) });
    });
    $$('[data-subdel]', root).forEach(b => b.onclick = e => {
      e.preventDefault(); const [tid, i] = pair(b.dataset.subdel); const t = findTask(tid);
      updateTask(t, { subtasks: t.subtasks.filter((s, k) => k !== Number(i)) });
    });
    const addSub = tid => {
      const input = $(`[data-newsub="${tid}"]`, root); const title = input.value.trim(); if (!title) return;
      const t = findTask(tid);
      updateTask(t, { subtasks: t.subtasks.concat({ t: title, done: false }) });
      const again = $(`[data-newsub="${tid}"]`); if (again) again.focus();
    };
    $$('[data-addsub]', root).forEach(b => b.onclick = () => addSub(b.dataset.addsub));
    $$('[data-newsub]', root).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addSub(i.dataset.newsub); } });
    $$('[data-asg]', root).forEach(c => c.onchange = () => {
      const [tid, pid] = pair(c.dataset.asg); const t = findTask(tid);
      updateTask(t, { assigneeIds: c.checked ? t.assigneeIds.concat(pid) : t.assigneeIds.filter(x => x !== pid) });
    });
    $$('[data-ext]', root).forEach(c => c.onchange = () => {
      const [tid, cid] = pair(c.dataset.ext); const t = findTask(tid);
      updateTask(t, { contactIds: c.checked ? t.contactIds.concat(cid) : t.contactIds.filter(x => x !== cid) });
    });
    const addExt = async tid => {
      const input = $(`[data-newext="${tid}"]`, root); const name = input.value.trim(); if (!name) return;
      const c = await guard(() => Api.addContact(name));
      if (!c) return;
      const t = findTask(tid);
      if (t.contactIds.indexOf(c.id) === -1) updateTask(t, { contactIds: t.contactIds.concat(c.id) }); else render();
      toast(c.name + ' added — everyone can now pick them');
    };
    $$('[data-addext]', root).forEach(b => b.onclick = () => addExt(b.dataset.addext));
    $$('[data-newext]', root).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addExt(i.dataset.newext); } });
    $$('[data-block]', root).forEach(b => b.onclick = () => {
      const t = findTask(b.dataset.block);
      updateTask(t, { status: isBlocked(t) ? 'To Do' : 'Blocked' }).then(() => { const n = $(`[data-blocknote="${t.id}"]`); if (n) n.focus(); });
    });
    $$('[data-blocknote]', root).forEach(i => i.oninput = () => {
      const t = findTask(i.dataset.blocknote); t.blockNote = i.value;
      clearTimeout(i._t); i._t = setTimeout(() => { S.lastWrite = Date.now(); Api.saveTask(findTask(t.id)).catch(e => toast(e.message, true)); }, 600);
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

  function addBar(projects, fixedProject) {
    return `
      <form class="card addbar" id="addForm">
        <input name="title" placeholder="${S.which === 'next' ? 'What will you do next week?' : 'What are you working on this week?'}" autocomplete="off" required>
        <div class="addbar-row">
          ${fixedProject ? '' : `<select name="project" aria-label="Project">${projects.map(p => `<option value="${esc(p.id)}"${p.id === S.lastProject ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
          <button type="submit" class="primary small"${fixedProject ? ' style="flex:1;justify-content:center"' : ''}>${icon('plus')} Add</button>
        </div>
      </form>`;
  }
  function bindAddBar(root, fixedProject) {
    const f = $('#addForm', root);
    if (!f) return;
    f.onsubmit = async e => {
      e.preventDefault();
      const title = f.elements.title.value.trim();
      const pid = fixedProject || f.elements.project.value;
      if (!title || !pid) return;
      S.lastProject = pid;
      const btn = $('button[type=submit]', f); btn.disabled = true;
      S.lastWrite = Date.now();
      const saved = await guard(() => Api.saveTask({ projectId: pid, week: S.which === 'next' ? NEXT : THIS, title: title, status: 'To Do',
        team: me().team || '', assigneeIds: [me().id], contactIds: [], subtasks: [] }));
      btn.disabled = false;
      if (saved) { render(); const i = $('#addForm input'); if (i) i.focus(); }
    };
  }

  // ---------- My tasks ----------

  function viewMyTasks(root) {
    const list = S.data.tasks.filter(isMine);
    const cur = list.filter(t => inView(t, S.which));
    const mine = myProjects();
    const groupIds = Array.from(new Set(cur.map(t => t.projectId)));
    const groups = S.data.projects.filter(p => groupIds.indexOf(p.id) !== -1);
    const open = cur.filter(t => !isDone(t)).length;
    root.innerHTML = `
      <div class="page-head"><h2>Hi ${esc(me().name.split(' ')[0])}</h2><span class="muted">${esc(weekRange(S.which === 'next' ? NEXT : THIS))}</span></div>
      ${weekSwitch(list.filter(t => inView(t, 'this')).length, list.filter(t => inView(t, 'next')).length)}
      ${mine.length ? addBar(mine.filter(p => CLOSED.indexOf(p.status) === -1)) : `<div class="card"><p>You’re not on a project yet. <a href="#/projects">Join your projects</a> to start adding tasks.</p></div>`}
      ${cur.length ? `<p class="muted small" style="margin:0 0 8px">${open} open · ${cur.length - open} done</p>` : ''}
      ${groups.map(p => `<section class="card"><h3 class="card-title">${esc(p.name)} <span class="badge ${typeClass(p.type)}">${esc(p.type)}</span></h3>
        ${cur.filter(t => t.projectId === p.id).sort((a, b) => isDone(a) - isDone(b)).map(t => taskHtml(t)).join('')}</section>`).join('')
        || `<div class="empty"><h3>Nothing ${S.which === 'next' ? 'planned for next week' : 'for this week'} yet</h3><p>${mine.length ? 'Add your first task above.' : ''}</p></div>`}`;
    bindWeekSwitch(root); bindAddBar(root); bindTasks(root);
  }

  // ---------- Projects ----------

  function viewProjects(root) {
    if (S.project) return viewProject(root, project(S.project));
    const mine = myProjects();
    const others = S.data.projects.filter(p => mine.indexOf(p) === -1 && CLOSED.indexOf(p.status) === -1)
      .sort((a, b) => a.name.localeCompare(b.name));
    const counts = p => {
      const ts = S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this'));
      return { open: ts.filter(t => !isDone(t)).length, done: ts.filter(isDone).length, blocked: ts.filter(isBlocked).length };
    };
    root.innerHTML = `
      <div class="page-head"><h2>My projects</h2></div>
      <div class="grid">${mine.map(p => { const c = counts(p); const team = projectTeam(p.id); return `
        <button type="button" class="card list-card pcard2" data-project="${esc(p.id)}">
          <span class="row-between"><strong>${esc(p.name)}</strong><span class="badge ${typeClass(p.type)}">${esc(p.type)}</span></span>
          <span class="counts"><span><b>${c.open}</b> open</span><span><b>${c.done}</b> done</span>${c.blocked ? `<span class="bad-count"><b>${c.blocked}</b> blocked</span>` : ''}${p.status !== 'In Progress' ? `<span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span>` : ''}</span>
          <span class="avatars">${team.slice(0, 6).map(m => `<span class="avatar sm" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}${team.length > 6 ? `<span class="avatar sm more">+${team.length - 6}</span>` : ''}</span>
        </button>`; }).join('') || '<div class="empty"><h3>You’re not on any project yet</h3><p>Join yours below.</p></div>'}</div>
      <h2 class="section-h">Other projects</h2>
      <section class="card">${others.map(p => `
        <div class="join"><span><strong>${esc(p.name)}</strong><br><span class="muted small">${esc(p.type)} · ${projectTeam(p.id).length} ${projectTeam(p.id).length === 1 ? 'person' : 'people'}</span></span>
          <button type="button" class="secondary small-btn" data-join="${esc(p.id)}">Join</button></div>`).join('') || '<p class="muted">You’re on every open project.</p>'}</section>`;
    $$('[data-project]', root).forEach(b => b.onclick = () => { S.project = b.dataset.project; render(); window.scrollTo(0, 0); });
    $$('[data-join]', root).forEach(b => b.onclick = async () => {
      b.disabled = true; S.lastWrite = Date.now();
      try { await Api.joinProject(b.dataset.join); toast('You joined ' + project(b.dataset.join).name); }
      catch (e) { toast(e.message, true); }
      render();
    });
  }

  function viewProject(root, p) {
    const cur = S.data.tasks.filter(t => t.projectId === p.id && inView(t, S.which));
    const byPerson = {};
    cur.forEach(t => { (byPerson[t.createdBy] = byPerson[t.createdBy] || []).push(t); });
    const onIt = myProjectIds().indexOf(p.id) !== -1;
    const order = Object.keys(byPerson).sort((a, b) => (a === me().id ? -1 : b === me().id ? 1 : member(a).name.localeCompare(member(b).name)));
    root.innerHTML = `
      <button type="button" class="back" id="backBtn">${icon('left')} My projects</button>
      <div class="page-head"><h2>${esc(p.name)}</h2>${onIt ? '<button type="button" class="ghost small-btn" id="leaveBtn">Leave</button>' : '<button type="button" class="primary small" id="joinBtn">Join</button>'}</div>
      <p class="muted small" style="margin:-8px 0 12px">${esc(p.type)} · ${esc(p.status)} · ${projectTeam(p.id).map(m => esc(shortName(m.name))).join(', ') || 'nobody yet'}</p>
      ${weekSwitch(S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length, S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'next')).length)}
      ${onIt && CLOSED.indexOf(p.status) === -1 ? addBar([p], p.id) : ''}
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
    bindWeekSwitch(root); bindAddBar(root, p.id); bindTasks(root);
  }

  // ---------- Meeting (written by the tasks) ----------

  function meetingData(week) {
    const isCurrent = week === THIS;
    const nextOf = shiftWeek(week, 1);
    const rows = S.data.projects.map(p => {
      const ts = S.data.tasks.filter(t => t.projectId === p.id);
      const cols = {};
      ['PLC', 'Dev'].forEach(team => {
        const of = t => teamOf(t) === team;
        cols[team] = {
          done: ts.filter(t => of(t) && isDone(t) && t.week === week),
          doing: ts.filter(t => of(t) && !isDone(t) && (t.week === week || (isCurrent && t.week < week))),
          next: ts.filter(t => of(t) && t.week === nextOf),
        };
      });
      const any = ['PLC', 'Dev'].some(k => cols[k].done.length + cols[k].doing.length + cols[k].next.length);
      return { p, cols, any };
    }).filter(r => r.any);
    const blocked = S.data.tasks.filter(t => isBlocked(t) && (t.week === week || (isCurrent && t.week < week)));
    return { rows, blocked };
  }

  function viewMeeting(root) {
    const week = S.mtgWeek;
    const { rows, blocked } = meetingData(week);
    const subs = t => t.subtasks.length ? ` <em>(${t.subtasks.filter(s => s.done).length}/${t.subtasks.length})</em>` : '';
    const li = (t, kind) => `<li class="${isBlocked(t) ? 'blk' : ''}">${kind === 'done' ? '✔ ' : ''}${esc(t.title)} <em>"${esc(who(t))}"</em>${isBlocked(t) ? ` — blocked: ${esc(t.blockNote || 'no reason given')}` : ''}${subs(t)}</li>`;
    const col = (c, name) => `<div class="mtg-col"><strong>${name} team</strong>
      ${c.done.length ? `<h4>Done</h4><ul>${c.done.map(t => li(t, 'done')).join('')}</ul>` : ''}
      ${c.doing.length ? `<h4>In progress</h4><ul>${c.doing.map(t => li(t, 'doing')).join('')}</ul>` : ''}
      ${c.next.length ? `<h4>Next week</h4><ul>${c.next.map(t => li(t, 'next')).join('')}</ul>` : ''}
      ${c.done.length + c.doing.length + c.next.length ? '' : '<p class="muted">—</p>'}</div>`;
    root.innerHTML = `
      <div class="weekbar">
        <button type="button" class="icon-btn" data-mw="-1" aria-label="Previous week">${icon('left')}</button>
        <div class="weekbar-label"><strong>Week ${wnum(week)} meeting</strong><span>${esc(weekRange(week))}${week === THIS ? ' · this week' : ''}</span></div>
        <button type="button" class="icon-btn" data-mw="1" aria-label="Next week"${week >= THIS ? ' disabled' : ''}>${icon('chevron')}</button>
      </div>
      <div class="actions-row"><button type="button" class="primary" id="copyEmail">Copy as email</button><button type="button" class="secondary" id="printMom">Print / PDF</button></div>
      <p class="muted small" style="margin:0 0 12px">Built automatically from everyone’s tasks${isAdmin() ? '' : ' on your projects'}.</p>
      ${blocked.length ? `<section class="card warn"><h3 class="card-title">Blocked (${blocked.length})</h3><ul class="plain">${blocked.map(t => `<li><span><strong>${esc(t.title)}</strong><br><span class="muted">${esc(project(t.projectId).name)} · ${esc(who(t))} — ${esc(t.blockNote || 'no reason given')}</span></span></li>`).join('')}</ul></section>` : ''}
      ${rows.map(r => `<section class="card"><h3 class="card-title">${esc(r.p.name)} <span class="badge ${typeClass(r.p.type)}">${esc(r.p.type)}</span><span class="pstatus ps-${slug(r.p.status)}">${esc(r.p.status)}</span></h3>
        <div class="mtg-grid">${col(r.cols.PLC, 'PLC')}${col(r.cols.Dev, 'Dev')}</div></section>`).join('')
        || '<div class="empty"><h3>No tasks for this week yet</h3><p>As people add tasks, the meeting fills itself in.</p></div>'}`;
    $$('[data-mw]', root).forEach(b => b.onclick = () => { S.mtgWeek = shiftWeek(S.mtgWeek, Number(b.dataset.mw)); render(); });
    $('#printMom', root).onclick = () => window.print();
    $('#copyEmail', root).onclick = () => copyEmail(week, rows);
  }

  /** Same layout as the "Weekly Progress Check & Action Plan" email; inline styles so it pastes into Zoho / Outlook. */
  function copyEmail(week, rows) {
    const cell = 'border:1px solid #E7E3DE;padding:12px;text-align:left;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:13px;';
    const head = cell + 'background:#CB2150;color:#ffffff;font-size:14px;';
    const item = (t, prefix) => `<li style="margin-bottom:6px">${prefix}${esc(t.title)} "${esc(who(t))}"${isBlocked(t) ? ' <b style="color:#CB2150">(blocked: ' + esc(t.blockNote || 'no reason given') + ')</b>' : ''}</li>`;
    const list = c => {
      const items = c.done.map(t => item(t, '✔ ')).concat(c.doing.map(t => item(t, ''))).concat(c.next.map(t => item(t, 'Next week: ')));
      return '<ul style="margin:0;padding-left:18px">' + (items.length ? items.join('') : '<li>-</li>') + '</ul>';
    };
    const html = `<div style="max-width:1100px;font-family:Arial,Helvetica,sans-serif;color:#191919">
      <h2 style="text-align:center;margin:0 0 4px">Weekly Progress Check &amp; Action Plan</h2>
      <p style="text-align:center;margin:0 0 18px;color:#6B6862;font-weight:bold">Week ${wnum(week)} · ${esc(weekRange(week))} ${weekMonday(week).getUTCFullYear()}</p>
      <table style="width:100%;border-collapse:collapse" width="100%">
        <thead><tr><th style="${head}">Project Name</th><th style="${head}">PLC Team Action Plan</th><th style="${head}">Dev Team Action Plan</th><th style="${head}width:15%">Overall Status</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr style="background:${i % 2 ? '#F7F5F2' : '#ffffff'}"><td style="${cell}font-weight:bold;color:#CB2150">${esc(r.p.name)}</td>
          <td style="${cell}">${list(r.cols.PLC)}</td><td style="${cell}">${list(r.cols.Dev)}</td><td style="${cell}font-weight:bold">${esc(r.p.status)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const text = ['Weekly Progress Check & Action Plan — ' + weekLabel(week), ''].concat(rows.map(r => [r.p.name + ' — ' + r.p.status].concat(['PLC', 'Dev'].map(k => {
      const c = r.cols[k];
      const items = c.done.map(t => '✔ ' + t.title).concat(c.doing.map(t => t.title + (isBlocked(t) ? ' (blocked: ' + (t.blockNote || '-') + ')' : ''))).concat(c.next.map(t => 'Next week: ' + t.title));
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

  // ---------- Manage: projects & team (admin) ----------

  function renderManage(root) {
    const tab = S.manageTab;
    const addLabel = { projects: 'Project', team: 'Member', external: '3rd party' }[tab];
    root.innerHTML = `
      <div class="page-head"><h2>Manage</h2>
        <button type="button" class="primary small" id="addBtn">${icon('plus')} ${addLabel}</button></div>
      <div class="segmented">
        <button type="button" data-tab="projects" class="${tab === 'projects' ? 'on' : ''}">Projects</button>
        <button type="button" data-tab="team" class="${tab === 'team' ? 'on' : ''}">Team</button>
        <button type="button" data-tab="external" class="${tab === 'external' ? 'on' : ''}">3rd parties</button>
      </div>
      <div id="manageBody"></div>`;
    $$('[data-tab]', root).forEach(b => b.addEventListener('click', () => { S.manageTab = b.dataset.tab; render(); }));
    $('#addBtn', root).addEventListener('click', () => tab === 'projects'
      ? projectForm({ type: 'PLC', status: 'In Progress', priority: 'Medium', assigned: [] })
      : tab === 'team' ? memberForm({ role: 'Member', active: true }) : contactForm({}));
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
    const list = S.data.projects.filter(p =>
      (S.projectFilter === 'All' || (S.projectFilter === 'Open' ? CLOSED.indexOf(p.status) === -1 : p.status === S.projectFilter)) &&
      (!q || (p.name + ' ' + p.client + ' ' + p.id).toLowerCase().indexOf(q) !== -1));
    root.innerHTML = `
      <input type="search" class="search" id="projectSearch" placeholder="Search projects" value="${esc(S.projectSearch)}">
      <div class="chips scroll">${filters.map(f => {
        const n = f === 'All' ? S.data.projects.length : f === 'Open' ? S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1).length : S.data.projects.filter(p => p.status === f).length;
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
    openForm({
      title: values.id ? 'Edit project' : 'New project',
      values: values,
      fields: [
        { name: 'name', label: 'Project name', required: true, wide: true },
        { name: 'id', label: 'Project ID (blank = auto)', readonly: !!values.id },
        { name: 'type', label: 'Type', type: 'select', options: PROJECT_TYPES },
        { name: 'status', label: 'Status', type: 'chips', options: PROJECT_STATUSES },
        { name: 'priority', label: 'Priority', type: 'chips', options: PRIORITIES },
        { name: 'client', label: 'Client' },
        { name: 'manager', label: 'Project manager' },
        { name: 'startDate', label: 'Start date', type: 'date' },
        { name: 'endDate', label: 'End date', type: 'date' },
        { name: 'assigned', label: 'Assigned engineers', type: 'checklist',
          options: S.data.team.filter(m => m.active).map(m => ({ value: m.id, label: m.name })) },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      onSubmit: async v => {
        if (!v.name) throw new Error('Project name is required.');
        await Api.saveProject(v, v.assigned);
        toast('Project saved');
        render();
      },
    });
  }

  function renderTeam(root) {
    root.innerHTML = `<div class="grid">${S.data.team.map(m => {
      const n = S.data.assignments.filter(a => a.userId === m.id).length;
      return `
        <button type="button" class="card list-card member${m.active ? '' : ' inactive'}" data-edit="${esc(m.id)}">
          <span class="avatar">${esc(initials(m.name))}</span>
          <span class="member-info"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.username)}</span></span>
          <span class="member-side">${m.team ? `<span class="badge">${esc(m.team)}</span>` : '<span class="badge off">No team</span>'}${m.role === 'Admin' ? '<span class="badge">Admin</span>' : ''}${m.active ? '' : '<span class="badge off">Inactive</span>'}<small class="muted">${n} project${n === 1 ? '' : 's'}</small></span>
        </button>`;
    }).join('')}</div>`;
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => memberForm(S.data.team.find(m => m.id === b.dataset.edit))));
  }

  function memberForm(values) {
    const isNew = !values.id;
    openForm({
      title: isNew ? 'New member' : 'Edit member',
      values: values,
      fields: [
        { name: 'name', label: 'Full name', required: true },
        { name: 'username', label: 'Username (or full email)', required: true, readonly: !isNew },
        { name: 'password', type: 'password', required: isNew,
          label: isNew ? 'Password (min. 8 characters)' : 'New password (leave blank to keep)' },
        { name: 'team', label: 'Team (decides the meeting column)', type: 'chips', options: ['PLC', 'Dev'] },
        { name: 'role', label: 'Role', type: 'chips', options: ['Member', 'Admin'] },
        { name: 'active', label: 'Active (can sign in)', type: 'checkbox' },
      ],
      onSubmit: async v => {
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
            <div><strong>${esc(me().name)}</strong><br><span class="muted">${esc(me().username)} · ${esc(me().role)}</span></div></div>
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
    { id: 'tasks', label: 'My tasks', view: viewMyTasks },
    { id: 'projects', label: 'Projects', view: viewProjects },
    { id: 'meeting', label: 'Meeting', view: viewMeeting },
    { id: 'manage', label: 'Manage', view: renderManage, admin: true },
  ];

  function currentTab() {
    const id = location.hash.replace(/^#\/?/, '');
    const allowed = TABS.filter(t => !t.admin || isAdmin());
    return allowed.find(t => t.id === id) || allowed[0];
  }

  function render() {
    if (!S.data) return;
    const tab = currentTab();
    $('#nav').innerHTML = TABS.filter(t => !t.admin || isAdmin()).map(t =>
      `<a href="#/${t.id}" class="${t.id === tab.id ? 'active' : ''}"${t.id === tab.id ? ' aria-current="page"' : ''}>${icon(t.id)}<span>${esc(t.label)}</span></a>`).join('');
    $('#avatarBtn').textContent = initials(me().name);
    $('#avatarBtn').title = me().name;
    document.body.dataset.tab = tab.id;
    tab.view($('#view'));
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

  const editing = () => $('#dialog').open || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));

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
    window.addEventListener('hashchange', () => { S.project = null; render(); window.scrollTo(0, 0); });
    document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !editing()) { S.pendingRender = false; render(); } }, 300));
    window.addEventListener('focus', () => { if (S.data && Date.now() - (S.data.loadedAt || 0) > 60000) refresh(true); });

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

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  start();
})();
