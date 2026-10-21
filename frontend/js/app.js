// ACS Project Tracker — UI. Plain JS, no build step.
(function () {
  const { call, Session, Auth } = window.Api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const UPDATE_STATUSES = ['On Track', 'At Risk', 'Delayed', 'Blocked', 'Done'];
  const PROJECT_TYPES = ['PLC', 'AVEVA', 'Other'];
  const PROJECT_STATUSES = ['Active', 'On Hold', 'Completed', 'Closed'];

  const S = {
    user: null,
    week: isoWeek(new Date()),
    myProjects: [],
    myUpdates: [],
    meetings: null,
    projects: null,
    team: null,
    assignments: null,
  };

  // ---------- Helpers ----------

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function multiline(v) { return esc(v).replace(/\n/g, '<br>'); }
  function slug(v) { return String(v || '').toLowerCase().replace(/[^a-z]+/g, '-'); }

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
  }

  async function guard(fn) {
    try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
  }

  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return date.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
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
  function weekLabel(week) {
    const mon = weekMonday(week);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const f = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return 'Week ' + week.split('-W')[1] + ' · ' + f(mon) + ' – ' + f(sun) + ' ' + sun.getUTCFullYear();
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function options(list, selected) {
    return list.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  function weekToolbar(extra) {
    const isCurrent = S.week === isoWeek(new Date());
    return `
      <div class="toolbar">
        <button type="button" class="icon" data-shift="-1" aria-label="Previous week">‹</button>
        <h2>${esc(weekLabel(S.week))}</h2>
        <button type="button" class="icon" data-shift="1" aria-label="Next week">›</button>
        ${isCurrent ? '' : '<button type="button" class="link" data-shift="0">This week</button>'}
        <span class="spacer"></span>
        ${extra || ''}
      </div>`;
  }
  function bindWeekToolbar(root, rerender) {
    $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => {
      if (!confirmDiscard()) return;
      const n = Number(b.dataset.shift);
      S.week = n === 0 ? isoWeek(new Date()) : shiftWeek(S.week, n);
      rerender();
    }));
  }

  // ---------- Generic form dialog ----------

  /**
   * fields: [{ name, label, type: text|email|password|date|select|textarea|checkbox|checklist, options, required }]
   * onSubmit(values) may throw; the dialog stays open on error.
   */
  function openForm({ title, fields, values, onSubmit, submitLabel }) {
    const dlg = $('#dialog');
    values = values || {};
    const fieldHtml = fields.map(f => {
      const v = values[f.name];
      const req = f.required ? ' required' : '';
      const id = 'f-' + f.name;
      if (f.type === 'textarea') {
        return `<label for="${id}">${esc(f.label)}<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}"${req}>${esc(v)}</textarea></label>`;
      }
      if (f.type === 'select') {
        return `<label for="${id}">${esc(f.label)}<select id="${id}" name="${f.name}">${options(f.options, v)}</select></label>`;
      }
      if (f.type === 'checkbox') {
        return `<label class="check"><input type="checkbox" name="${f.name}"${v !== false ? ' checked' : ''}> ${esc(f.label)}</label>`;
      }
      if (f.type === 'checklist') {
        const sel = v || [];
        const items = f.options.length ? f.options.map(o =>
          `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"${sel.indexOf(o.value) !== -1 ? ' checked' : ''}> ${esc(o.label)}</label>`
        ).join('') : '<p class="muted">Nobody on the team yet.</p>';
        return `<fieldset><legend>${esc(f.label)}</legend><div class="checklist">${items}</div></fieldset>`;
      }
      return `<label for="${id}">${esc(f.label)}<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}"${req}${f.readonly ? ' readonly' : ''}></label>`;
    }).join('');

    dlg.innerHTML = `
      <form method="dialog" class="form">
        <h3>${esc(title)}</h3>
        <div class="form-grid">${fieldHtml}</div>
        <p class="error" hidden></p>
        <div class="actions">
          <button type="button" class="secondary" data-cancel>Cancel</button>
          <button type="submit" class="primary">${esc(submitLabel || 'Save')}</button>
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
      } finally {
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  // ---------- My week ----------

  function dirtyCards() { return $$('.update-card.dirty'); }
  function confirmDiscard() {
    return !dirtyCards().length || confirm('You have unsaved changes. Discard them?');
  }

  async function loadMine() {
    const [projects, updates] = await Promise.all([call('myProjects'), call('myUpdates')]);
    S.myProjects = projects;
    S.myUpdates = updates;
  }

  function findUpdate(week, projectId) {
    return S.myUpdates.find(u => u.week === week && u.projectId === projectId);
  }

  function renderWeek(root) {
    const prevWeek = shiftWeek(S.week, -1);
    const cards = S.myProjects.map(p => {
      const u = findUpdate(S.week, p.id) || {};
      const prev = findUpdate(prevWeek, p.id);
      const progress = u.progress !== null && u.progress !== undefined ? u.progress : (prev && prev.progress) || 0;
      return `
        <article class="card update-card" data-project="${esc(p.id)}">
          <header>
            <div>
              <h3>${esc(p.name)}</h3>
              <div class="meta"><span class="badge type-${slug(p.type)}">${esc(p.type)}</span>
                ${p.client ? esc(p.client) + ' · ' : ''}${esc(p.id)}${p.status && p.status !== 'Active' ? ' · ' + esc(p.status) : ''}</div>
            </div>
            <span class="saved-at">${u.updatedAt ? 'Saved ' + esc(u.updatedAt) : 'Not submitted'}</span>
          </header>
          ${prev && prev.next ? `<div class="ref"><strong>You planned last week:</strong><br>${multiline(prev.next)}</div>` : ''}
          <div class="fields">
            <label>What I did this week<textarea name="done" rows="4">${esc(u.done)}</textarea></label>
            <label>What I'll do next week<textarea name="next" rows="4">${esc(u.next)}</textarea></label>
            <label class="wide">Blockers / support needed<textarea name="blockers" rows="2">${esc(u.blockers)}</textarea></label>
          </div>
          <footer>
            <label class="inline">Status <select name="status">${options(UPDATE_STATUSES, u.status || 'On Track')}</select></label>
            <label class="inline progress">Progress
              <input type="range" name="progress" min="0" max="100" step="5" value="${esc(progress)}">
              <output>${esc(progress)}%</output>
            </label>
            <span class="spacer"></span>
            <button type="button" class="primary" data-save>Save</button>
          </footer>
        </article>`;
    }).join('');

    root.innerHTML = weekToolbar('<button type="button" class="primary" id="saveAll">Save all</button>') + (cards ||
      `<div class="empty"><h3>No projects assigned to you yet</h3><p>Ask an admin to assign you to your projects.</p></div>`);

    bindWeekToolbar(root, () => render());
    $$('.update-card', root).forEach(card => {
      card.addEventListener('input', ev => {
        card.classList.add('dirty');
        if (ev.target.name === 'progress') $('output', card).textContent = ev.target.value + '%';
      });
      $('[data-save]', card).addEventListener('click', () => saveCard(card));
    });
    const all = $('#saveAll', root);
    if (all) all.addEventListener('click', async () => {
      const dirty = dirtyCards();
      if (!dirty.length) return toast('Nothing to save');
      for (const card of dirty) await saveCard(card, true);
      if (!dirtyCards().length) toast('All updates saved');
    });
  }

  async function saveCard(card, quiet) {
    const btn = $('[data-save]', card);
    const val = n => card.querySelector(`[name="${n}"]`).value;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const saved = await call('saveUpdate', {
        week: S.week, projectId: card.dataset.project,
        done: val('done'), next: val('next'), blockers: val('blockers'),
        status: val('status'), progress: Number(val('progress')),
      });
      S.myUpdates = S.myUpdates.filter(u => !(u.week === saved.week && u.projectId === saved.projectId)).concat(saved);
      card.classList.remove('dirty');
      $('.saved-at', card).textContent = 'Saved ' + saved.updatedAt;
      if (!quiet) toast('Saved');
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  // ---------- My history ----------

  function renderHistory(root) {
    const byWeek = {};
    S.myUpdates.forEach(u => { (byWeek[u.week] = byWeek[u.week] || []).push(u); });
    const weeks = Object.keys(byWeek).sort().reverse();
    root.innerHTML = `<div class="toolbar"><h2>My history</h2></div>` + (weeks.length ? weeks.map(w => `
      <section class="card">
        <h3>${esc(weekLabel(w))}</h3>
        ${updatesTable(byWeek[w], false)}
      </section>`).join('') : '<div class="empty"><h3>No updates yet</h3></div>');
  }

  function updatesTable(list, showPerson) {
    return `<div class="table-wrap"><table>
      <thead><tr>${showPerson ? '<th>Engineer</th>' : '<th>Project</th>'}<th>Done this week</th><th>Next week</th><th>Blockers</th><th>Status</th><th>%</th></tr></thead>
      <tbody>${list.map(u => `<tr>
        <td>${esc(showPerson ? u.name : u.projectName)}</td>
        <td>${multiline(u.done)}</td><td>${multiline(u.next)}</td><td>${multiline(u.blockers)}</td>
        <td><span class="pill st-${slug(u.status)}">${esc(u.status)}</span></td>
        <td>${u.progress === null ? '' : esc(u.progress) + '%'}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  // ---------- Weekly report / MoM (admin) ----------

  async function renderReport(root) {
    root.innerHTML = weekToolbar('') + '<p class="muted">Loading…</p>';
    bindWeekToolbar(root, () => render());
    const week = S.week;
    const r = await guard(() => call('weekReport', { week }));
    if (!r || week !== S.week) return;
    S.report = r;

    const byProject = {};
    r.updates.forEach(u => { (byProject[u.projectId] = byProject[u.projectId] || []).push(u); });
    const sections = r.projects.filter(p => byProject[p.id]).map(p => `
      <section class="card">
        <h3>${esc(p.name)} <span class="badge type-${slug(p.type)}">${esc(p.type)}</span></h3>
        ${updatesTable(byProject[p.id], true)}
      </section>`).join('');

    const submitted = new Set(r.updates.map(u => u.username)).size;
    const missingHtml = r.missing.length ? `
      <section class="card warn">
        <h3>Missing updates (${r.missing.length})</h3>
        <ul>${r.missing.map(m => `<li><strong>${esc(m.name)}</strong> — ${esc(m.projectName)}</li>`).join('')}</ul>
      </section>` : '';

    root.innerHTML = weekToolbar(`
        <button type="button" class="secondary" id="copyMom">Copy as text</button>
        <button type="button" class="secondary" id="printMom">Print / PDF</button>
        <button type="button" class="primary" id="newMeetingFromReport">Record meeting</button>`) + `
      <div class="stats">
        <div class="stat"><b>${r.updates.length}</b><span>updates</span></div>
        <div class="stat"><b>${submitted}</b><span>people submitted</span></div>
        <div class="stat ${r.missing.length ? 'bad' : ''}"><b>${r.missing.length}</b><span>missing</span></div>
      </div>
      ${missingHtml}
      ${sections || '<div class="empty"><h3>No updates submitted for this week yet</h3></div>'}`;

    bindWeekToolbar(root, () => render());
    $('#printMom', root).addEventListener('click', () => window.print());
    $('#copyMom', root).addEventListener('click', () => {
      navigator.clipboard.writeText(momText(r)).then(() => toast('Copied'), () => toast('Copy failed', true));
    });
    $('#newMeetingFromReport', root).addEventListener('click', () => {
      const attendees = Array.from(new Set(r.updates.map(u => u.name))).join(', ');
      const actions = r.updates.filter(u => u.next).map(u => `${u.name} — ${u.projectName}: ${u.next.replace(/\s*\n\s*/g, '; ')}`).join('\n');
      meetingForm({ date: today(), week: r.week, title: 'Weekly meeting — ' + weekLabel(r.week), attendees, actionItems: actions });
    });
  }

  function momText(r) {
    const lines = ['Minutes of meeting — ' + weekLabel(r.week), ''];
    const byProject = {};
    r.updates.forEach(u => { (byProject[u.projectId] = byProject[u.projectId] || []).push(u); });
    r.projects.filter(p => byProject[p.id]).forEach(p => {
      lines.push('■ ' + p.name + ' (' + p.type + ')');
      byProject[p.id].forEach(u => {
        lines.push('  • ' + u.name + ' — ' + u.status + (u.progress !== null ? ', ' + u.progress + '%' : ''));
        if (u.done) lines.push('    Done: ' + u.done.replace(/\n/g, '\n          '));
        if (u.next) lines.push('    Next: ' + u.next.replace(/\n/g, '\n          '));
        if (u.blockers) lines.push('    Blockers: ' + u.blockers.replace(/\n/g, '\n              '));
      });
      lines.push('');
    });
    if (r.missing.length) {
      lines.push('Missing updates:');
      r.missing.forEach(m => lines.push('  • ' + m.name + ' — ' + m.projectName));
    }
    return lines.join('\n');
  }

  // ---------- Meetings ----------

  async function renderMeetings(root) {
    if (!S.meetings) {
      root.innerHTML = '<p class="muted">Loading…</p>';
      S.meetings = await guard(() => call('listMeetings'));
      if (!S.meetings) { S.meetings = null; return; }
    }
    const isAdmin = S.user.role === 'Admin';
    root.innerHTML = `
      <div class="toolbar"><h2>Meetings</h2><span class="spacer"></span>
        ${isAdmin ? '<button type="button" class="primary" id="newMeeting">New meeting</button>' : ''}</div>
      ${S.meetings.length ? S.meetings.map(m => `
        <article class="card meeting">
          <header>
            <div><h3>${esc(m.title)}</h3><div class="meta">${esc(m.date)}${m.week ? ' · ' + esc(m.week) : ''}</div></div>
            ${isAdmin ? `<button type="button" class="link" data-edit="${esc(m.id)}">Edit</button>` : ''}
          </header>
          ${m.attendees ? `<p><strong>Attendees:</strong> ${esc(m.attendees)}</p>` : ''}
          ${m.decisions ? `<h4>Decisions</h4><p>${multiline(m.decisions)}</p>` : ''}
          ${m.actionItems ? `<h4>Action items</h4><p>${multiline(m.actionItems)}</p>` : ''}
          ${m.notes ? `<h4>Notes</h4><p>${multiline(m.notes)}</p>` : ''}
        </article>`).join('') : '<div class="empty"><h3>No meetings recorded yet</h3></div>'}`;
    const nb = $('#newMeeting', root);
    if (nb) nb.addEventListener('click', () => meetingForm({ date: today(), week: isoWeek(new Date()) }));
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () =>
      meetingForm(S.meetings.find(m => m.id === b.dataset.edit))));
  }

  function meetingForm(values) {
    openForm({
      title: values.id ? 'Edit meeting' : 'New meeting',
      values,
      fields: [
        { name: 'date', label: 'Date', type: 'date', required: true },
        { name: 'week', label: 'Week (e.g. 2026-W43)' },
        { name: 'title', label: 'Title' },
        { name: 'attendees', label: 'Attendees' },
        { name: 'decisions', label: 'Decisions', type: 'textarea', rows: 4 },
        { name: 'actionItems', label: 'Action items (owner — task — due)', type: 'textarea', rows: 6 },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 4 },
      ],
      onSubmit: async v => {
        await call('saveMeeting', Object.assign({ id: values.id }, v));
        S.meetings = null;
        toast('Meeting saved');
        location.hash = '#/meetings';
        render();
      },
    });
  }

  // ---------- Projects (admin) ----------

  async function loadAdminData(force) {
    if (force || !S.projects) {
      const [projects, team, assignments] = await Promise.all([call('listProjects'), call('listTeam'), call('listAssignments')]);
      Object.assign(S, { projects, team, assignments });
    }
  }

  async function renderProjects(root) {
    if (!S.projects) root.innerHTML = '<p class="muted">Loading…</p>';
    await guard(() => loadAdminData());
    if (!S.projects) return;
    const nameOf = username => (S.team.find(m => m.username === username) || { name: username }).name;
    const filter = S.projectFilter || '';
    const rows = S.projects.filter(p => !filter || p.type === filter);
    root.innerHTML = `
      <div class="toolbar"><h2>Projects</h2>
        <select id="typeFilter"><option value="">All types</option>${options(PROJECT_TYPES, filter)}</select>
        <span class="spacer"></span>
        <button type="button" class="primary" id="addProject">Add project</button></div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Client</th><th>Manager</th><th>Status</th><th>Assigned to</th><th></th></tr></thead>
        <tbody>${rows.map(p => `<tr>
          <td>${esc(p.id)}</td><td>${esc(p.name)}</td>
          <td><span class="badge type-${slug(p.type)}">${esc(p.type)}</span></td>
          <td>${esc(p.client)}</td><td>${esc(p.manager)}</td><td>${esc(p.status)}</td>
          <td>${S.assignments.filter(a => a.projectId === p.id).map(a => esc(nameOf(a.username))).join(', ')}</td>
          <td><button type="button" class="link" data-edit="${esc(p.id)}">Edit</button></td></tr>`).join('')
          || '<tr><td colspan="8" class="muted">No projects yet.</td></tr>'}</tbody>
      </table></div></div>`;
    $('#typeFilter', root).addEventListener('change', e => { S.projectFilter = e.target.value; render(); });
    $('#addProject', root).addEventListener('click', () => projectForm({ type: 'PLC', status: 'Active' }));
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
      const p = S.projects.find(x => x.id === b.dataset.edit);
      projectForm(Object.assign({}, p, { assigned: S.assignments.filter(a => a.projectId === p.id).map(a => a.username) }));
    }));
  }

  function projectForm(values) {
    openForm({
      title: values.id ? 'Edit project' : 'Add project',
      values,
      fields: [
        { name: 'id', label: 'Project ID (blank = auto)', readonly: !!values.id },
        { name: 'name', label: 'Project name', required: true },
        { name: 'type', label: 'Type', type: 'select', options: PROJECT_TYPES },
        { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUSES },
        { name: 'client', label: 'Client' },
        { name: 'manager', label: 'Project manager' },
        { name: 'startDate', label: 'Start date', type: 'date' },
        { name: 'endDate', label: 'End date', type: 'date' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
        { name: 'assigned', label: 'Assigned engineers', type: 'checklist',
          options: S.team.filter(m => m.active).map(m => ({ value: m.username, label: m.name })) },
      ],
      onSubmit: async v => {
        const saved = await call('saveProject', v);
        await call('setAssignments', { projectId: saved.id, usernames: v.assigned });
        await loadAdminData(true);
        toast('Project saved');
        render();
      },
    });
  }

  // ---------- Team (admin) ----------

  async function renderTeam(root) {
    if (!S.team) root.innerHTML = '<p class="muted">Loading…</p>';
    await guard(() => loadAdminData());
    if (!S.team) return;
    root.innerHTML = `
      <div class="toolbar"><h2>Team</h2><span class="spacer"></span>
        <button type="button" class="primary" id="addMember">Add member</button></div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th><th>Projects</th><th></th></tr></thead>
        <tbody>${S.team.map(m => `<tr class="${m.active ? '' : 'inactive'}">
          <td>${esc(m.name)}</td><td>${esc(m.username)}</td><td>${esc(m.role)}</td><td>${m.active ? 'Yes' : 'No'}</td>
          <td>${S.assignments.filter(a => a.username === m.username).length}</td>
          <td><button type="button" class="link" data-edit="${esc(m.username)}">Edit</button></td></tr>`).join('')}</tbody>
      </table></div></div>`;
    $('#addMember', root).addEventListener('click', () => memberForm({ role: 'Member', active: true }));
    $$('[data-edit]', root).forEach(b => b.addEventListener('click', () =>
      memberForm(S.team.find(m => m.username === b.dataset.edit))));
  }

  function memberForm(values) {
    openForm({
      title: values.username ? 'Edit member' : 'Add member',
      values,
      fields: [
        { name: 'username', label: 'Username', required: true, readonly: !!values.username },
        { name: 'name', label: 'Full name', required: true },
        { name: 'password', type: 'password', required: !values.username,
          label: values.username ? 'New password (leave blank to keep)' : 'Password (min. 8 characters)' },
        { name: 'role', label: 'Role', type: 'select', options: ['Member', 'Admin'] },
        { name: 'active', label: 'Active (can sign in)', type: 'checkbox' },
      ],
      onSubmit: async v => {
        await call('saveMember', Object.assign({ isNew: !values.username }, v));
        await loadAdminData(true);
        toast('Member saved');
        render();
      },
    });
  }

  // ---------- Routing ----------

  const TABS = [
    { id: 'week', label: 'My week', view: renderWeek },
    { id: 'history', label: 'My history', view: renderHistory },
    { id: 'meetings', label: 'Meetings', view: renderMeetings },
    { id: 'report', label: 'Weekly report', view: renderReport, admin: true },
    { id: 'projects', label: 'Projects', view: renderProjects, admin: true },
    { id: 'team', label: 'Team', view: renderTeam, admin: true },
  ];

  function currentTab() {
    const id = location.hash.replace(/^#\/?/, '');
    const allowed = TABS.filter(t => !t.admin || S.user.role === 'Admin');
    return allowed.find(t => t.id === id) || allowed[0];
  }

  function render() {
    const tab = currentTab();
    $('#tabs').innerHTML = TABS.filter(t => !t.admin || S.user.role === 'Admin').map(t =>
      `<a href="#/${t.id}" class="${t.id === tab.id ? 'active' : ''}${t.admin ? ' admin' : ''}">${esc(t.label)}</a>`).join('');
    tab.view($('#view'));
  }

  function showLogin(message) {
    $('#topbar').hidden = true;
    $('#view').innerHTML = '';
    $('#loginView').hidden = false;
    const err = $('#loginError');
    err.textContent = message || '';
    err.hidden = !message;
  }

  function passwordForm() {
    openForm({
      title: 'Change password',
      submitLabel: 'Change password',
      fields: [
        { name: 'current', label: 'Current password', type: 'password', required: true },
        { name: 'next', label: 'New password (min. 8 characters)', type: 'password', required: true },
        { name: 'confirm', label: 'Repeat new password', type: 'password', required: true },
      ],
      onSubmit: async v => {
        if (v.next !== v.confirm) throw new Error('The new passwords do not match.');
        await call('changePassword', { current: v.current, next: v.next });
        toast('Password changed');
      },
    });
  }

  async function enterApp() {
    $('#loginView').hidden = true;
    $('#view').innerHTML = '<p class="muted">Loading your projects…</p>';
    try {
      S.user = await call('me');
      await loadMine();
    } catch (e) {
      return showLogin(e.message);
    }
    $('#userName').textContent = S.user.name + (S.user.role === 'Admin' ? ' · Admin' : '');
    $('#topbar').hidden = false;
    render();
  }

  function start() {
    $('#loginForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const form = ev.target;
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      $('#loginError').hidden = true;
      try {
        await Auth.login(form.elements.username.value.trim(), form.elements.password.value);
        form.reset();
        await enterApp();
      } catch (e) {
        showLogin(e.message);
      } finally {
        btn.disabled = false;
      }
    });
    $('#passwordBtn').addEventListener('click', passwordForm);
    $('#logoutBtn').addEventListener('click', () => { if (confirmDiscard()) Auth.logout(); });
    window.addEventListener('session-expired', e => showLogin(e.detail));
    window.addEventListener('beforeunload', e => { if (dirtyCards().length) { e.preventDefault(); e.returnValue = ''; } });
    let lastHash = location.hash;
    window.addEventListener('hashchange', () => {
      if (!S.user) return;
      if (!confirmDiscard()) { history.replaceState(null, '', lastHash || '#/'); return; }
      lastHash = location.hash;
      render();
    });

    const session = Session.get();
    if (!session || !session.token) return showLogin();
    enterApp();
  }

  start();
})();
