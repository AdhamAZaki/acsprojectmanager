// ACS Project Tracker — UI. Plain JS, no build step. Mobile-first.
(function () {
  const Api = window.Api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const UPDATE_STATUSES = ['On Track', 'At Risk', 'Delayed', 'Blocked', 'Done'];
  const PROJECT_TYPES = ['PLC', 'AVEVA', 'BMS', 'Other'];
  // Same statuses as the Notion "Projects" database.
  const PROJECT_STATUSES = ['In Progress', 'Planning', 'Paused', 'Backlog', 'Done', 'Canceled'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const CLOSED = ['Done', 'Canceled'];

  const S = {
    data: null,          // see Api.refresh()
    week: isoWeek(new Date()),
    open: {},            // expanded project cards on My week
    meetings: null,
    report: {},          // week -> updates (admin)
    manageTab: 'projects',
    projectFilter: 'Open',
    projectSearch: '',
  };

  // ---------- Helpers ----------

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function multiline(v) { return esc(v).replace(/\n/g, '<br>'); }
  function slug(v) { return String(v || '').toLowerCase().replace(/[^a-z]+/g, '-'); }
  function initials(name) {
    return String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  }
  const isAdmin = () => S.data && S.data.me.role === 'Admin';
  const me = () => S.data.me;
  const member = id => S.data.team.find(m => m.id === id) || { name: 'Unknown', username: '' };
  const project = id => S.data.projects.find(p => p.id === id) || { name: id, type: '' };

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2200);
  }

  async function guard(fn) {
    try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
  }

  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
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
  function weekRange(week) {
    const mon = weekMonday(week);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const f = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return f(mon) + ' – ' + f(sun);
  }
  function weekLabel(week) { return 'Week ' + Number(week.split('-W')[1]) + ' · ' + weekRange(week); }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function options(list, selected) {
    return list.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  const ICONS = {
    week: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 14l2.5 2.5L16 11"/>',
    history: '<path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4M3 4v5h5"/>',
    meetings: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    manage: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
  };
  const icon = (name, cls) => `<svg class="ico ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function weekBar() {
    const current = isoWeek(new Date());
    return `
      <div class="weekbar">
        <button type="button" class="icon-btn" data-shift="-1" aria-label="Previous week">${icon('left')}</button>
        <div class="weekbar-label">
          <strong>Week ${Number(S.week.split('-W')[1])}</strong>
          <span>${esc(weekRange(S.week))}${S.week === current ? ' · this week' : ''}</span>
        </div>
        <button type="button" class="icon-btn" data-shift="1" aria-label="Next week">${icon('chevron')}</button>
        ${S.week === current ? '' : '<button type="button" class="chip" data-shift="0">Today</button>'}
      </div>`;
  }
  function bindWeekBar(root) {
    $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => {
      if (!confirmDiscard()) return;
      const n = Number(b.dataset.shift);
      S.week = n === 0 ? isoWeek(new Date()) : shiftWeek(S.week, n);
      render();
    }));
  }

  function statusPill(status) {
    return status ? `<span class="pill st-${slug(status)}">${esc(status)}</span>` : '';
  }
  function progressBar(v) {
    if (v === null || v === undefined) return '';
    return `<span class="bar" title="${esc(v)}%"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><span class="bar-num">${esc(v)}%</span>`;
  }

  /** One weekly update, shown as a card section (used by History and the Report). */
  function updateBlock(u, title) {
    const rows = [['Done', u.done], ['Next', u.next], ['Blockers', u.blockers]].filter(r => r[1]);
    return `
      <div class="ublock">
        <div class="ublock-head"><strong>${esc(title)}</strong><span class="ublock-meta">${statusPill(u.status)}${progressBar(u.progress)}</span></div>
        ${rows.map(([k, v]) => `<div class="ublock-row ${k === 'Blockers' ? 'warn' : ''}"><span>${k}</span><p>${multiline(v)}</p></div>`).join('')
          || '<p class="muted">No details.</p>'}
      </div>`;
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

  // ---------- My week ----------

  const draftKey = (week, projectId) => 'acs-draft:' + me().id + ':' + week + ':' + projectId;
  function readDraft(week, projectId) {
    try { return JSON.parse(localStorage.getItem(draftKey(week, projectId))); } catch (e) { return null; }
  }
  function writeDraft(card) {
    try { localStorage.setItem(draftKey(S.week, card.dataset.project), JSON.stringify(cardValues(card))); } catch (e) { /* ignore */ }
  }
  function clearDraft(week, projectId) {
    try { localStorage.removeItem(draftKey(week, projectId)); } catch (e) { /* ignore */ }
  }

  function dirtyCards() { return $$('.pcard.dirty'); }
  function confirmDiscard() {
    if (!dirtyCards().length) return true;
    // Drafts are kept on the device, so leaving doesn't lose anything.
    return true;
  }

  function myProjects() {
    const mine = S.data.assignments.filter(a => a.userId === me().id).map(a => a.projectId);
    return S.data.projects.filter(p => mine.indexOf(p.id) !== -1)
      .sort((a, b) => (CLOSED.indexOf(a.status) !== -1) - (CLOSED.indexOf(b.status) !== -1) || a.name.localeCompare(b.name));
  }
  function myUpdate(week, projectId) {
    return S.data.updates.find(u => u.week === week && u.projectId === projectId && u.userId === me().id);
  }

  function cardValues(card) {
    const val = n => { const el = card.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
    const st = card.querySelector('input[name="status-' + card.dataset.project + '"]:checked');
    return { done: val('done'), next: val('next'), blockers: val('blockers'), status: st ? st.value : 'On Track', progress: Number(val('progress')) };
  }

  function renderWeek(root) {
    const projects = myProjects();
    const prevWeek = shiftWeek(S.week, -1);
    const doneCount = projects.filter(p => myUpdate(S.week, p.id)).length;
    // Open the first project without an update for this week (once per week).
    if (!S.open[S.week]) {
      const first = projects.find(p => !myUpdate(S.week, p.id));
      S.open[S.week] = {};
      if (first) S.open[S.week][first.id] = true;
    }

    const cards = projects.map(p => {
      const saved = myUpdate(S.week, p.id);
      const draft = readDraft(S.week, p.id);
      const u = draft || saved || {};
      const prev = myUpdate(prevWeek, p.id);
      const progress = u.progress !== null && u.progress !== undefined ? u.progress : (prev && prev.progress) || 0;
      const status = u.status || 'On Track';
      const open = !!S.open[S.week][p.id];
      return `
        <article class="card pcard${open ? ' open' : ''}${draft ? ' dirty' : ''}" data-project="${esc(p.id)}">
          <button type="button" class="pcard-head" aria-expanded="${open}">
            <span class="pcard-title">
              <strong>${esc(p.name)}</strong>
              <span class="meta"><span class="badge type-${slug(p.type)}">${esc(p.type)}</span>${p.client ? esc(p.client) + ' · ' : ''}${esc(p.status)}</span>
            </span>
            <span class="pcard-state">${saved ? statusPill(saved.status) : '<span class="pill todo">To do</span>'}</span>
            ${icon('chevron', 'chev')}
          </button>
          <div class="pcard-body">
            ${prev && prev.next ? `<div class="ref"><span>You planned last week</span><p>${multiline(prev.next)}</p></div>` : ''}
            <label class="field">What I did this week<textarea name="done" rows="3" placeholder="e.g. Finished alarm screens, tested IO…">${esc(u.done)}</textarea></label>
            <label class="field">What I'll do next week<textarea name="next" rows="3" placeholder="e.g. FAT with client…">${esc(u.next)}</textarea></label>
            <label class="field">Blockers / support needed<textarea name="blockers" rows="2" placeholder="Optional">${esc(u.blockers)}</textarea></label>
            <fieldset class="field"><legend>Status</legend><div class="chips">${UPDATE_STATUSES.map(s =>
              `<label class="chip-opt st-${slug(s)}"><input type="radio" name="status-${esc(p.id)}" value="${esc(s)}"${s === status ? ' checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div></fieldset>
            <label class="field progress">Progress <output>${esc(progress)}%</output>
              <input type="range" name="progress" min="0" max="100" step="5" value="${esc(progress)}">
            </label>
            <div class="pcard-foot">
              <span class="saved-at">${draft ? 'Draft saved on this phone' : saved ? 'Saved ' + esc(saved.updatedAt) : 'Not submitted yet'}</span>
              <button type="button" class="primary" data-save>Save</button>
            </div>
          </div>
        </article>`;
    }).join('');

    root.innerHTML = weekBar() + (projects.length ? `
      <div class="summary">
        <span>${doneCount} of ${projects.length} project${projects.length === 1 ? '' : 's'} updated</span>
        <span class="bar wide"><i style="width:${projects.length ? Math.round(100 * doneCount / projects.length) : 0}%"></i></span>
      </div>
      <div class="stack">${cards}</div>` :
      `<div class="empty"><h3>No projects assigned to you yet</h3><p>Ask an admin to assign you to your projects.</p></div>`) + `
      <div class="savebar" id="savebar" hidden><span id="savebarText"></span><button type="button" class="primary" id="saveAll">Save all</button></div>`;

    bindWeekBar(root);
    $$('.pcard', root).forEach(card => {
      const id = card.dataset.project;
      $('.pcard-head', card).addEventListener('click', () => {
        const open = !card.classList.contains('open');
        card.classList.toggle('open', open);
        $('.pcard-head', card).setAttribute('aria-expanded', open);
        S.open[S.week][id] = open;
      });
      card.addEventListener('input', ev => {
        card.classList.add('dirty');
        if (ev.target.name === 'progress') $('output', card).textContent = ev.target.value + '%';
        if (ev.target.tagName === 'TEXTAREA') autoGrow(ev.target);
        $('.saved-at', card).textContent = 'Draft saved on this phone';
        writeDraft(card);
        updateSaveBar();
      });
      $$('textarea', card).forEach(autoGrow);
      $('[data-save]', card).addEventListener('click', () => saveCard(card));
    });
    const all = $('#saveAll', root);
    if (all) all.addEventListener('click', async () => {
      all.disabled = true;
      await Promise.all(dirtyCards().map(c => saveCard(c, true)));
      all.disabled = false;
      if (!dirtyCards().length) toast('All updates saved');
    });
    updateSaveBar();
  }

  function autoGrow(t) {
    if (!t.offsetParent) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight + 2, 400) + 'px';
  }

  function updateSaveBar() {
    const bar = $('#savebar');
    if (!bar) return;
    const n = dirtyCards().length;
    bar.hidden = n < 2;
    $('#savebarText').textContent = n + ' unsaved updates';
  }

  async function saveCard(card, quiet) {
    const btn = $('[data-save]', card);
    const week = S.week;
    const projectId = card.dataset.project;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const saved = await Api.saveUpdate(Object.assign({ week: week, projectId: projectId }, cardValues(card)));
      clearDraft(week, projectId);
      card.classList.remove('dirty');
      $('.saved-at', card).textContent = 'Saved ' + saved.updatedAt;
      $('.pcard-state', card).innerHTML = statusPill(saved.status);
      const projects = myProjects();
      const doneCount = projects.filter(p => myUpdate(week, p.id)).length;
      const sum = $('.summary');
      if (sum) {
        sum.firstElementChild.textContent = doneCount + ' of ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ' updated';
        $('.bar i', sum).style.width = Math.round(100 * doneCount / projects.length) + '%';
      }
      if (!quiet) toast('Saved');
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
      updateSaveBar();
    }
  }

  // ---------- My history ----------

  function renderHistory(root) {
    const byWeek = {};
    S.data.updates.filter(u => u.userId === me().id).forEach(u => { (byWeek[u.week] = byWeek[u.week] || []).push(u); });
    const weeks = Object.keys(byWeek).sort().reverse();
    root.innerHTML = `<div class="page-head"><h2>My history</h2><span class="muted">Last 6 months</span></div>` +
      (weeks.length ? weeks.map(w => `
        <section class="card">
          <h3 class="card-title">${esc(weekLabel(w))}</h3>
          ${byWeek[w].map(u => updateBlock(u, project(u.projectId).name)).join('')}
        </section>`).join('') : '<div class="empty"><h3>No updates yet</h3><p>Your saved weekly updates will appear here.</p></div>');
  }

  // ---------- Weekly report / MoM (admin) ----------

  async function renderReport(root) {
    const week = S.week;
    const draw = () => {
      if (week !== S.week || currentTab().id !== 'report') return;
      const updates = S.report[week];
      root.innerHTML = weekBar() + (updates ? reportHtml(week, updates) : '<div class="skeleton"></div><div class="skeleton"></div>');
      bindWeekBar(root);
      if (updates) bindReport(root, week, updates);
    };
    draw();
    const fresh = await guard(() => Api.weekUpdates(week));
    if (fresh) { S.report[week] = fresh; draw(); }
  }

  function reportData(week, updates) {
    const open = S.data.projects.filter(p => CLOSED.indexOf(p.status) === -1);
    const active = S.data.team.filter(m => m.active);
    const missing = [];
    S.data.assignments.forEach(a => {
      const p = open.find(x => x.id === a.projectId);
      const m = active.find(x => x.id === a.userId);
      if (p && m && !updates.some(u => u.projectId === p.id && u.userId === m.id)) missing.push({ name: m.name, projectName: p.name });
    });
    const byProject = {};
    updates.forEach(u => { (byProject[u.projectId] = byProject[u.projectId] || []).push(u); });
    const projects = S.data.projects.filter(p => byProject[p.id]);
    return { missing, byProject, projects, people: new Set(updates.map(u => u.userId)).size };
  }

  function reportHtml(week, updates) {
    const r = reportData(week, updates);
    const blockers = updates.filter(u => u.blockers).length;
    return `
      <div class="actions-row">
        <button type="button" class="secondary" id="copyMom">Copy as text</button>
        <button type="button" class="secondary" id="printMom">Print / PDF</button>
        <button type="button" class="primary" id="newMeetingFromReport">Record meeting</button>
      </div>
      <div class="stats">
        <div class="stat"><b>${updates.length}</b><span>updates</span></div>
        <div class="stat"><b>${r.people}</b><span>people</span></div>
        <div class="stat ${r.missing.length ? 'bad' : 'good'}"><b>${r.missing.length}</b><span>missing</span></div>
        <div class="stat ${blockers ? 'warn' : ''}"><b>${blockers}</b><span>blockers</span></div>
      </div>
      ${r.missing.length ? `
        <section class="card warn">
          <h3 class="card-title">Missing updates</h3>
          <ul class="plain">${r.missing.map(m => `<li><span class="avatar sm">${esc(initials(m.name))}</span><span><strong>${esc(m.name)}</strong><br><span class="muted">${esc(m.projectName)}</span></span></li>`).join('')}</ul>
        </section>` : ''}
      ${r.projects.map(p => `
        <section class="card">
          <h3 class="card-title">${esc(p.name)} <span class="badge type-${slug(p.type)}">${esc(p.type)}</span></h3>
          ${r.byProject[p.id].map(u => updateBlock(u, member(u.userId).name)).join('')}
        </section>`).join('') || '<div class="empty"><h3>No updates for this week yet</h3></div>'}`;
  }

  function bindReport(root, week, updates) {
    $('#printMom', root).addEventListener('click', () => window.print());
    $('#copyMom', root).addEventListener('click', () => {
      navigator.clipboard.writeText(momText(week, updates)).then(() => toast('Copied'), () => toast('Copy failed', true));
    });
    $('#newMeetingFromReport', root).addEventListener('click', () => {
      const attendees = Array.from(new Set(updates.map(u => member(u.userId).name))).join(', ');
      const actions = updates.filter(u => u.next).map(u => `${member(u.userId).name} — ${project(u.projectId).name}: ${u.next.replace(/\s*\n\s*/g, '; ')}`).join('\n');
      meetingForm({ date: today(), week: week, title: 'Weekly meeting — ' + weekLabel(week), attendees: attendees, actionItems: actions });
    });
  }

  function momText(week, updates) {
    const r = reportData(week, updates);
    const lines = ['Minutes of meeting — ' + weekLabel(week), ''];
    r.projects.forEach(p => {
      lines.push('■ ' + p.name + ' (' + p.type + ')');
      r.byProject[p.id].forEach(u => {
        lines.push('  • ' + member(u.userId).name + ' — ' + u.status + (u.progress !== null ? ', ' + u.progress + '%' : ''));
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
    const draw = () => {
      if (currentTab().id !== 'meetings') return;
      const list = S.meetings;
      root.innerHTML = `
        <div class="page-head"><h2>Meetings</h2>
          ${isAdmin() ? `<button type="button" class="primary small" id="newMeeting">${icon('plus')} New</button>` : ''}</div>
        ${!list ? '<div class="skeleton"></div>' : list.length ? list.map(m => `
          <article class="card meeting">
            <header class="row-between">
              <div><h3 class="card-title">${esc(m.title)}</h3><div class="meta">${esc(m.date)}${m.week ? ' · ' + esc(m.week) : ''}</div></div>
              ${isAdmin() ? `<button type="button" class="text-btn" data-edit="${esc(m.id)}">Edit</button>` : ''}
            </header>
            ${m.attendees ? `<p class="muted">${esc(m.attendees)}</p>` : ''}
            ${m.decisions ? `<h4>Decisions</h4><p>${multiline(m.decisions)}</p>` : ''}
            ${m.actionItems ? `<h4>Action items</h4><p>${multiline(m.actionItems)}</p>` : ''}
            ${m.notes ? `<h4>Notes</h4><p>${multiline(m.notes)}</p>` : ''}
          </article>`).join('') : '<div class="empty"><h3>No meetings recorded yet</h3></div>'}`;
      const nb = $('#newMeeting', root);
      if (nb) nb.addEventListener('click', () => meetingForm({ date: today(), week: isoWeek(new Date()) }));
      $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => meetingForm(S.meetings.find(m => m.id === b.dataset.edit))));
    };
    draw();
    const fresh = await guard(() => Api.meetings());
    if (fresh) { S.meetings = fresh; draw(); }
  }

  function meetingForm(values) {
    openForm({
      title: values.id ? 'Edit meeting' : 'New meeting',
      values: values,
      fields: [
        { name: 'date', label: 'Date', type: 'date', required: true },
        { name: 'week', label: 'Week (e.g. 2026-W43)' },
        { name: 'title', label: 'Title', wide: true },
        { name: 'attendees', label: 'Attendees', wide: true },
        { name: 'decisions', label: 'Decisions', type: 'textarea', rows: 4 },
        { name: 'actionItems', label: 'Action items (owner — task — due)', type: 'textarea', rows: 6 },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 4 },
      ],
      onSubmit: async v => {
        await Api.saveMeeting(Object.assign({ id: values.id }, v));
        S.meetings = null;
        toast('Meeting saved');
        if (location.hash !== '#/meetings') location.hash = '#/meetings'; else render();
      },
    });
  }

  // ---------- Manage: projects & team (admin) ----------

  function renderManage(root) {
    root.innerHTML = `
      <div class="page-head"><h2>Manage</h2>
        <button type="button" class="primary small" id="addBtn">${icon('plus')} ${S.manageTab === 'projects' ? 'Project' : 'Member'}</button></div>
      <div class="segmented">
        <button type="button" data-tab="projects" class="${S.manageTab === 'projects' ? 'on' : ''}">Projects</button>
        <button type="button" data-tab="team" class="${S.manageTab === 'team' ? 'on' : ''}">Team</button>
      </div>
      <div id="manageBody"></div>`;
    $$('[data-tab]', root).forEach(b => b.addEventListener('click', () => { S.manageTab = b.dataset.tab; render(); }));
    $('#addBtn', root).addEventListener('click', () => S.manageTab === 'projects'
      ? projectForm({ type: 'PLC', status: 'In Progress', priority: 'Medium', assigned: [] })
      : memberForm({ role: 'Member', active: true }));
    const body = $('#manageBody', root);
    if (S.manageTab === 'projects') renderProjects(body); else renderTeam(body);
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
          <span class="member-side">${m.role === 'Admin' ? '<span class="badge">Admin</span>' : ''}${m.active ? '' : '<span class="badge off">Inactive</span>'}<small class="muted">${n} project${n === 1 ? '' : 's'}</small></span>
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

  // ---------- Routing / shell ----------

  const TABS = [
    { id: 'week', label: 'My week', view: renderWeek },
    { id: 'history', label: 'History', view: renderHistory },
    { id: 'meetings', label: 'Meetings', view: renderMeetings },
    { id: 'report', label: 'Report', view: renderReport, admin: true },
    { id: 'manage', label: 'Manage', view: renderManage, admin: true },
  ];

  function currentTab() {
    const id = location.hash.replace(/^#\/?/, '');
    const allowed = TABS.filter(t => !t.admin || isAdmin());
    return allowed.find(t => t.id === id) || allowed[0];
  }

  function render() {
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

  /** Background refresh. Re-renders only when nothing is being edited. */
  async function refresh() {
    const sync = $('#sync');
    sync.className = 'sync busy';
    try {
      S.data = await Api.refresh();
      sync.className = 'sync';
      const editing = dirtyCards().length || $('#dialog').open || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
      if (!editing) showApp();
    } catch (e) {
      sync.className = 'sync off';
      if (e.code === 401) return;
      if (!S.data) return showLogin(e.message);
      toast(e.code === 0 ? 'Offline — showing saved data' : e.message, e.code !== 0);
    }
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
      } catch (e) {
        showLogin(e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
    $('#avatarBtn').addEventListener('click', accountSheet);
    window.addEventListener('session-expired', e => { S.data = null; showLogin(e.detail); });
    window.addEventListener('hashchange', () => { if (S.data) render(); });
    window.addEventListener('focus', () => { if (S.data && Date.now() - (S.data.loadedAt || 0) > 60000) refresh(); });

    const userId = await Api.sessionUserId().catch(() => null);
    if (!userId) return showLogin();
    const cached = Api.cached();
    if (cached && cached.me && cached.me.id === userId) {
      S.data = cached;   // instant: show what we had, then refresh
      showApp();
    } else {
      $('#view').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      document.body.classList.add('signed-in');
    }
    refresh();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  start();
})();
