// ACS Weekly Tasks: UI. Plain JS, no build step. Mobile-first.
// Two screens: Projects (the weekly meeting board: every project, this week and next side by side)
// and My tasks (your own tasks across all projects). Admins also get Manage.
(function () {
  const Api = window.Api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PROJECT_TYPES = ['PLC', 'AVEVA', 'AVEVA + PLC', 'BMS', 'Other'];
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
    mtgLive: false,      // Projects board: show live tasks even when minutes were saved
    board: 'mine',       // Projects board: 'mine' (projects I'm on) or 'all'
    addFor: null,        // Projects board: project whose add box is open
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
  /** The people a task belongs to: its assigned team members, or its creator if nobody is assigned. */
  function ownersOf(t) {
    const ids = t.assigneeIds.filter(id => S.data.team.some(m => m.id === id));
    return ids.length ? ids : [t.createdBy];
  }
  /** Meeting column(s): the teams of the people on the task; else the task's team, else the project type. */
  function teamsOf(t) {
    const teams = Array.from(new Set(ownersOf(t).map(id => member(id).team).filter(Boolean)));
    if (teams.length) return teams;
    if (t.team) return [t.team];
    return [project(t.projectId).type === 'PLC' ? 'PLC' : 'Dev'];
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
      updateTask(t, x => done ? { status: 'Done', week: x.week < THIS ? THIS : x.week } : { status: 'To Do' });
      if (done) toast('Done ✔ — it goes into this week’s meeting');
    });
    $$('[data-toggle]', root).forEach(b => b.onclick = () => { S.open[b.dataset.toggle] = !S.open[b.dataset.toggle]; render(); });
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
    const [from, to] = isAdmin() ? [-4, 8] : [-1, 1];
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
  /** Project picker: my projects first, then every other open project (anyone can add to any project). */
  function projectChoices() {
    const open = p => CLOSED.indexOf(p.status) === -1;
    const mine = myProjects().filter(open);
    const others = S.data.projects.filter(p => open(p) && mine.indexOf(p) === -1).sort((a, b) => a.name.localeCompare(b.name));
    const opt = p => `<option value="${esc(p.id)}"${p.id === S.lastProject ? ' selected' : ''}>${esc(p.name)}</option>`;
    return (mine.length ? `<optgroup label="My projects">${mine.map(opt).join('')}</optgroup>` : '') +
      (others.length ? `<optgroup label="${mine.length ? 'Other projects' : 'Projects'}">${others.map(opt).join('')}</optgroup>` : '');
  }
  /** `fixedProject`: add straight into that project. `week`: the week picked by default. */
  function addBar(fixedProject, people, week) {
    week = week || (S.which === 'next' ? NEXT : THIS);
    if (week < shiftWeek(THIS, isAdmin() ? -4 : -1) || week > shiftWeek(THIS, isAdmin() ? 8 : 1)) week = THIS;
    return `
      <form class="card addbar" id="addForm">
        <input name="title" data-keep="add-title" placeholder="${week === NEXT ? 'What will you do next week?' : week < THIS ? 'What did you do that week?' : 'What are you working on this week?'}" autocomplete="off" required>
        <div class="addbar-row">
          ${fixedProject ? '' : `<select name="project" aria-label="Project">${projectChoices()}</select>`}
          <select name="week" aria-label="Week">${weekChoices(week)}</select>
          <button type="submit" class="primary small">${icon('plus')} Add</button>
        </div>
        ${isAdmin() ? `<div class="addbar-row admin-row"><select name="person" aria-label="For">${personChoices(people || S.data.team)}</select></div>` : ''}
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
        const tab = currentTab().id;
        const shown = forId === me().id && (tab === 'projects' ? !S.project : week === (S.which === 'next' ? NEXT : THIS));
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
  function planNudge(list, hasProjects) {
    const day = new Date().getDay();   // 0 = Sunday
    const lateInWeek = day === 0 || day >= 4;
    if (!lateInWeek || !hasProjects || S.which !== 'this') return '';
    if (list.some(t => t.week === NEXT) || remember.get('plan-dismissed') === NEXT) return '';
    return `<div class="nudge" id="planNudge"><span><strong>Plan next week</strong><br>Nothing planned for week ${wnum(NEXT)} yet. It goes straight into next week’s meeting.</span>
      <span class="nudge-actions"><button type="button" class="primary small" id="planNext">Plan week ${wnum(NEXT)}</button><button type="button" class="text-btn" id="planLater">Later</button></span></div>`;
  }

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
      ${planNudge(list, mine.some(p => CLOSED.indexOf(p.status) === -1))}
      ${S.data.projects.some(p => CLOSED.indexOf(p.status) === -1) ? addBar() : ''}
      ${cur.length ? `<p class="muted small" style="margin:0 0 8px">${open} open · ${cur.length - open} done</p>` : ''}
      ${groups.map(p => `<section class="card"><h3 class="card-title">${esc(p.name)} <span class="badge ${typeClass(p.type)}">${esc(p.type)}</span></h3>
        ${cur.filter(t => t.projectId === p.id).sort((a, b) => isDone(a) - isDone(b)).map(t => taskHtml(t)).join('')}</section>`).join('')
        || `<div class="empty"><h3>Nothing ${S.which === 'next' ? 'planned for next week' : 'for this week'} yet</h3><p>Add your first task above, on any project.</p></div>`}`;
    bindWeekSwitch(root); bindAddBar(root); bindTasks(root);
    const plan = $('#planNext', root);
    if (plan) plan.onclick = () => { S.which = 'next'; render(); const i = $('#addForm input'); if (i) i.focus(); };
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
      <p class="muted small" style="margin:-8px 0 12px">${esc(p.type)} · ${esc(p.status)} · ${projectTeam(p.id).map(m => esc(shortName(m.name))).join(', ') || 'nobody yet'}</p>
      ${weekSwitch(S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'this')).length, S.data.tasks.filter(t => t.projectId === p.id && inView(t, 'next')).length)}
      ${isAdmin() ? teamEditor(p) : ''}
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
      title: t.title, who: who(t) || member(t.createdBy).name, kind: kind, week: t.week,
      blocked: isBlocked(t), note: t.blockNote || '',
      subDone: t.subtasks.filter(x => x.done).length, subTotal: t.subtasks.length,
    });
    const rows = [];
    const summary = { moved: 0, done: 0, delayed: 0, blocked: 0 };
    S.data.projects.forEach(p => {
      const ts = S.data.tasks.filter(t => t.projectId === p.id);
      const pick = {
        doing: ts.filter(t => !isDone(t) && open(t)),
        done: ts.filter(t => isDone(t) && t.week === week),
        next: ts.filter(t => t.week === nextOf),
      };
      if (!pick.doing.length && !pick.done.length && !pick.next.length) return;
      const cols = { PLC: { done: [], doing: [], next: [] }, Dev: { done: [], doing: [], next: [] } };
      const people = {};
      ['doing', 'done', 'next'].forEach(kind => pick[kind].forEach(t => {
        const it = itemOf(t, kind);
        teamsOf(t).forEach(team => cols[team][kind].push(it));
        ownersOf(t).forEach(id => {
          const m = member(id);
          (people[id] = people[id] || { name: m.name, team: m.team || '', items: [] }).items.push(it);
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
    const blocked = S.data.tasks.filter(t => isBlocked(t) && open(t))
      .map(t => Object.assign(itemOf(t, 'doing'), { project: project(t.projectId).name }));
    summary.blocked = blocked.length;
    return { v: 1, week: week, rows: rows, blocked: blocked, summary: summary };
  }

  /**
   * Active people on an open project with no task activity in the week: none of their tasks
   * (created by or assigned to them) was saved that week, and nothing is planned for it.
   */
  function quietPeople(week) {
    const openIds = S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1).map(p => p.id);
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
    dlg.innerHTML = `<div class="sheet"><header class="sheet-head"><span></span><h3>Saved minutes</h3><button type="button" class="text-btn strong" data-close>Done</button></header>
      <div class="sheet-body" id="archiveBody"><div class="skeleton"></div></div></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.showModal();
    const list = await guard(() => Api.minutesList());
    const body = $('#archiveBody', dlg);
    if (!list || !body) return;
    list.sort((a, b) => b.week.localeCompare(a.week));
    body.innerHTML = list.length ? `<div class="archive">${list.map(r => `
      <button type="button" class="archive-row${r.week === S.mtgWeek ? ' on' : ''}" data-week="${esc(r.week)}">
        <span><strong>Week ${wnum(r.week)}</strong> · ${esc(weekRange(r.week))} ${weekMonday(r.week).getUTCFullYear()}<br>
        <span class="muted small">Saved ${esc(r.savedAt)}${r.savedBy ? ' by ' + esc(member(r.savedBy).name) : ''}</span></span>${icon('chevron')}</button>`).join('')}</div>`
      : '<div class="empty"><h3>No saved minutes yet</h3><p>An admin can save them from the Projects tab after each meeting.</p></div>';
    $$('[data-week]', body).forEach(b => b.onclick = () => {
      S.mtgWeek = b.dataset.week; S.mtgLive = false; dlg.close(); render(); window.scrollTo(0, 0);
    });
  }

  /** Loads the saved minutes for a week once, then redraws. */
  function loadMinutes(week) {
    S.minutes[week] = undefined;
    Api.minutes(week).then(rec => { S.minutes[week] = rec; }, () => { S.minutes[week] = null; })
      .then(() => { if (currentTab().id === 'projects' && !S.project && S.mtgWeek === week) softRender(); });
  }

  /** Saved minutes: exactly what was saved, no buttons. */
  function savedCards(rows, people) {
    return rows.map(r => `<section class="card"><h3 class="card-title">${esc(r.name)} <span class="badge ${typeClass(r.type)}">${esc(r.type)}</span><span class="pstatus ps-${slug(r.status)}">${esc(r.status)}</span></h3>
      ${people(r)}</section>`).join('') || '<div class="empty"><h3>Nothing was saved for this week</h3></div>';
  }

  /** Live board: my projects or all, each with Join / + Task and the two weeks side by side. */
  function liveCards(rows, people, week) {
    const byId = {}; rows.forEach(r => { byId[r.id] = r; });
    const mineIds = myProjectIds();
    const mode = mineIds.length ? S.board : 'all';   // nobody to show under "My projects" yet
    const shown = p => mode === 'all' ? (CLOSED.indexOf(p.status) === -1 || byId[p.id]) : mineIds.indexOf(p.id) !== -1;
    const list = S.data.projects.filter(shown).sort((a, b) =>
      (mineIds.indexOf(b.id) !== -1) - (mineIds.indexOf(a.id) !== -1) || !!byId[b.id] - !!byId[a.id] || a.name.localeCompare(b.name));
    const seg = `<div class="seg board-seg"><button type="button" data-board="mine" class="${mode === 'mine' ? 'on' : ''}">My projects <small>· ${mineIds.length}</small></button><button type="button" data-board="all" class="${mode === 'all' ? 'on' : ''}">All projects</button></div>`;
    const card = p => {
      const r = byId[p.id];
      const on = mineIds.indexOf(p.id) !== -1;
      const open = CLOSED.indexOf(p.status) === -1;
      return `<section class="card board-card">
        <div class="board-head">
          <button type="button" class="board-title" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong> <span class="badge ${typeClass(p.type)}">${esc(p.type)}</span><span class="pstatus ps-${slug(p.status)}">${esc(p.status)}</span></button>
          <span class="board-actions no-print">${on ? '' : `<button type="button" class="ghost small-btn" data-join="${esc(p.id)}">Join</button>`}${open ? `<button type="button" class="secondary small-btn" data-addto="${esc(p.id)}">${icon('plus')} Task</button>` : ''}</span>
        </div>
        ${S.addFor === p.id ? `<div class="no-print">${addBar(p.id, projectTeam(p.id).concat(S.data.team.filter(m => projectTeam(p.id).indexOf(m) === -1)), week)}</div>` : ''}
        ${r ? people(r) : `<p class="muted small" style="margin:8px 0 0">No tasks in week ${wnum(week)} or ${wnum(shiftWeek(week, 1))}.</p>`}
      </section>`;
    };
    const empty = mode === 'mine'
      ? '<div class="empty"><h3>You’re not on a project yet</h3><p>Open <b>All projects</b> to join yours. You can add tasks to any project, joined or not.</p></div>'
      : '<div class="empty"><h3>No projects</h3></div>';
    return seg + (list.map(card).join('') || empty);
  }
  function bindBoard(root) {
    $$('[data-board]', root).forEach(b => b.onclick = () => { S.board = b.dataset.board; S.addFor = null; render(); });
    $$('[data-project]', root).forEach(b => b.onclick = () => { S.project = b.dataset.project; S.which = S.mtgWeek > THIS ? 'next' : 'this'; render(); window.scrollTo(0, 0); });
    $$('[data-addto]', root).forEach(b => b.onclick = () => {
      S.addFor = S.addFor === b.dataset.addto ? null : b.dataset.addto; render();
      const i = $('#addForm input', root); if (i) i.focus();
    });
    $$('[data-join]', root).forEach(b => b.onclick = async () => {
      b.disabled = true; S.lastWrite = Date.now();
      if (await guard(() => Api.joinProject(b.dataset.join).then(() => true))) toast('You joined ' + project(b.dataset.join).name);
      render();
    });
    if (S.addFor) bindAddBar(root, S.addFor);
  }

  function viewBoard(root) {
    const week = S.mtgWeek;
    if (!(week in S.minutes)) loadMinutes(week);
    const saved = S.minutes[week];
    const showSaved = !!(saved && saved.snapshot && !S.mtgLive);
    const m = showSaved ? saved.snapshot : buildMinutes(week);
    const { rows, blocked, summary } = m;
    const subs = it => it.subTotal ? ` <em>(${it.subDone}/${it.subTotal})</em>` : '';
    const blockText = it => it.blocked ? ` — blocked: ${esc(it.note || 'no reason given')}` : '';
    const mark = it => it.kind === 'done' ? '✔' : it.kind === 'next' ? '→' : it.blocked ? '⛔' : '•';
    const item = it => `<li class="${it.blocked ? 'blk' : ''}"><span class="mk">${mark(it)}</span><span>${esc(it.title)}${it.kind === 'doing' && it.week < week ? ` <span class="tag-carry">from week ${wnum(it.week)}</span>` : ''}${blockText(it)}${subs(it)}</span></li>`;
    // Under each project: this week and next week side by side (swipe on a phone), people in each
    const person = (pp, items) => `<div class="mtg-person">
        <strong><span class="avatar sm">${esc(initials(pp.name))}</span>${esc(pp.name)}${pp.team ? ` <span class="badge">${esc(pp.team)}</span>` : ''}</strong>
        <ul>${items.map(item).join('')}</ul></div>`;
    const column = (r, isNext) => {
      const inCol = it => (it.kind === 'next') === isNext;
      const blocks = r.people.filter(pp => pp.items.some(inCol)).map(pp => person(pp, pp.items.filter(inCol)));
      const w = isNext ? shiftWeek(week, 1) : week;
      return `<div class="wk-col${isNext ? ' next' : ''}"><h4>Week ${wnum(w)} <span>${isNext ? 'plan' : 'done & in progress'}</span></h4>
        ${blocks.join('') || `<p class="muted small">${isNext ? 'Nothing planned yet' : 'Nothing this week'}</p>`}</div>`;
    };
    const people = r => `<div class="wk2">${column(r, false)}${column(r, true)}</div>`;
    // Admins, live view of this week or an earlier one: who hasn't touched their tasks.
    const quiet = isAdmin() && !showSaved && week <= THIS ? quietPeople(week) : [];
    const quietCard = quiet.length ? `<section class="card quiet"><h3 class="card-title">No update ${week === THIS ? 'yet' : ''} (${quiet.length})</h3>
      <p class="muted small" style="margin:0 0 8px">On an open project, but none of their tasks was added or changed in week ${wnum(week)}.</p>
      <div class="avatars-row">${quiet.map(m => `<span class="person-chip"><span class="avatar sm">${esc(initials(m.name))}</span>${esc(shortName(m.name))}${m.team ? ` <small class="muted">${esc(m.team)}</small>` : ''}</span>`).join('')}</div>
      ${week === THIS ? '<button type="button" class="secondary small-btn" id="copyReminder">Copy reminder</button>' : ''}</section>` : '';
    const note = showSaved
      ? `<div class="mtg-note saved"><span>Saved minutes · ${esc(saved.savedAt)}${saved.savedBy ? ' by ' + esc(member(saved.savedBy).name) : ''}</span><button type="button" class="text-btn" id="mtgLive">Show live tasks</button></div>`
      : saved ? `<div class="mtg-note"><span>Live view of today’s tasks.</span><button type="button" class="text-btn" id="mtgSaved">Show saved minutes</button></div>`
      : week < THIS && saved === null ? '<div class="mtg-note warn"><span>Not saved. This is rebuilt from today’s tasks, so it may differ from what was discussed.</span></div>' : '';
    root.innerHTML = `
      <div class="weekbar">
        <button type="button" class="icon-btn" data-mw="-1" aria-label="Previous week">${icon('left')}</button>
        <div class="weekbar-label"><strong>Week ${wnum(week)}${week === THIS ? ' · this week' : ''}</strong><span>${esc(weekRange(week))} · next to week ${wnum(shiftWeek(week, 1))}</span></div>
        <button type="button" class="icon-btn" data-mw="1" aria-label="Next week"${week >= shiftWeek(THIS, 8) ? ' disabled' : ''}>${icon('chevron')}</button>
      </div>
      <div class="actions-row"><button type="button" class="primary" id="copyEmail">Copy as email</button><button type="button" class="secondary" id="printMom">Print / PDF</button>${isAdmin() && !showSaved && week <= THIS ? `<button type="button" class="secondary" id="saveMins">${saved ? 'Replace saved minutes' : 'Save minutes'}</button>` : ''}<button type="button" class="ghost" id="archiveBtn">Past minutes</button></div>
      ${note}
      ${quietCard}
      ${showSaved ? '' : '<p class="muted small" style="margin:0 0 12px">This is the weekly meeting: built automatically from everyone’s tasks.</p>'}
      ${rows.length ? `<div class="mtg-sum"><span><b>${summary.moved}</b> ${summary.moved === 1 ? 'project' : 'projects'} with progress</span><span><b>${summary.done}</b> done</span><span class="${summary.blocked ? 'bad' : ''}"><b>${summary.blocked}</b> blocked</span><span class="${summary.delayed ? 'warn' : ''}"><b>${summary.delayed}</b> delayed</span></div>` : ''}
      ${blocked.length ? `<section class="card warn"><h3 class="card-title">Blocked (${blocked.length})</h3><ul class="plain">${blocked.map(it => `<li><span><strong>${esc(it.title)}</strong><br><span class="muted">${esc(it.project)} · ${esc(it.who)} — ${esc(it.note || 'no reason given')}</span></span></li>`).join('')}</ul></section>` : ''}
      ${showSaved ? savedCards(rows, people) : liveCards(rows, people, week)}`;
    $$('[data-mw]', root).forEach(b => b.onclick = () => { S.mtgWeek = shiftWeek(S.mtgWeek, Number(b.dataset.mw)); S.mtgLive = false; render(); });
    $('#printMom', root).onclick = () => window.print();
    $('#copyEmail', root).onclick = () => copyEmail(m);
    $('#archiveBtn', root).onclick = minutesArchive;
    if (!showSaved) bindBoard(root);
    const remind = $('#copyReminder', root);
    if (remind) remind.onclick = () => copyText(
      'Hi ' + quiet.map(x => x.name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0]).join(', ') +
      ' — please add your tasks for week ' + wnum(week) + ' in Weekly Tasks before the meeting: ' + location.origin + location.pathname,
      'Reminder copied — paste it into your team chat');
    const live = $('#mtgLive', root); if (live) live.onclick = () => { S.mtgLive = true; render(); };
    const back = $('#mtgSaved', root); if (back) back.onclick = () => { S.mtgLive = false; render(); };
    const save = $('#saveMins', root);
    if (save) save.onclick = async () => {
      if (saved && !confirm('Replace the saved minutes for week ' + wnum(week) + ' with today’s tasks?')) return;
      save.disabled = true;
      const rec = await guard(() => Api.saveMinutes(week, buildMinutes(week)));
      save.disabled = false;
      if (rec) { S.minutes[week] = rec; S.mtgLive = false; toast('Minutes saved'); render(); }
    };
  }

  /** Same layout as the "Weekly Progress Check & Action Plan" email; inline styles so it pastes into Zoho / Outlook. */
  function copyEmail(m) {
    const week = m.week;
    const rows = m.rows;
    const cell = 'border:1px solid #E7E3DE;padding:12px;text-align:left;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:13px;';
    const head = cell + 'background:#CB2150;color:#ffffff;font-size:14px;';
    const item = (it, prefix) => `<li style="margin-bottom:6px">${prefix}${esc(it.title)} "${esc(it.who)}"${it.blocked ? ' <b style="color:#CB2150">(blocked: ' + esc(it.note || 'no reason given') + ')</b>' : ''}</li>`;
    const list = c => {
      const items = c.done.map(it => item(it, '✔ ')).concat(c.doing.map(it => item(it, ''))).concat(c.next.map(it => item(it, 'Next week: ')));
      return '<ul style="margin:0;padding-left:18px">' + (items.length ? items.join('') : '<li>-</li>') + '</ul>';
    };
    const html = `<div style="max-width:1100px;font-family:Arial,Helvetica,sans-serif;color:#191919">
      <h2 style="text-align:center;margin:0 0 4px">Weekly Progress Check &amp; Action Plan</h2>
      <p style="text-align:center;margin:0 0 18px;color:#6B6862;font-weight:bold">Week ${wnum(week)} · ${esc(weekRange(week))} ${weekMonday(week).getUTCFullYear()}</p>
      <table style="width:100%;border-collapse:collapse" width="100%">
        <thead><tr><th style="${head}">Project Name</th><th style="${head}">PLC Team Action Plan</th><th style="${head}">Dev Team Action Plan</th><th style="${head}width:15%">Overall Status</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr style="background:${i % 2 ? '#F7F5F2' : '#ffffff'}"><td style="${cell}font-weight:bold;color:#CB2150">${esc(r.name)}</td>
          <td style="${cell}">${list(r.cols.PLC)}</td><td style="${cell}">${list(r.cols.Dev)}</td><td style="${cell}font-weight:bold">${esc(r.status)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const text = ['Weekly Progress Check & Action Plan — ' + weekLabel(week), ''].concat(rows.map(r => [r.name + ' — ' + r.status].concat(['PLC', 'Dev'].map(k => {
      const c = r.cols[k];
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
        await Api.saveProject(v, v.assigned, values.assigned || []);
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
    { id: 'projects', label: 'Projects', view: viewProjects },
    { id: 'tasks', label: 'My tasks', view: viewMyTasks },
    { id: 'manage', label: 'Manage', view: renderManage, admin: true },
  ];

  function currentTab() {
    const id = location.hash.replace(/^#\/?/, '').replace(/^meeting$/, 'projects');
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
    // Text half-typed into an "add" box survives the redraw (e.g. ticking a task meanwhile).
    const kept = {};
    $$('#view [data-keep]').forEach(i => { if (i.value) kept[i.dataset.keep] = i.value; });
    tab.view($('#view'));
    $$('#view [data-keep]').forEach(i => { if (kept[i.dataset.keep] && !i.value) i.value = kept[i.dataset.keep]; });
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
