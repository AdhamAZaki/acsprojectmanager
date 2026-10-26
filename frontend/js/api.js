// Data layer: talks to Supabase directly (auth + database). Security is enforced
// by the database's Row Level Security rules (supabase/setup.sql), not here.
//
// Speed: everything the app needs is fetched in ONE request (app_bootstrap) and
// kept in localStorage, so the app can show the last known data instantly on
// open and refresh it in the background.
(function () {
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const DOMAIN = String(cfg.EMAIL_DOMAIN || '').toLowerCase();
  const CACHE_KEY = 'acs-tracker-cache-v4';
  const HISTORY_WEEKS = 26;

  // ---------- Usernames <-> emails ----------
  // People sign in with a short username ("ahmed"); Supabase needs an email,
  // so EMAIL_DOMAIN is added. A full email address also works.

  function toEmail(username) {
    const u = String(username || '').trim().toLowerCase();
    return u.indexOf('@') === -1 && DOMAIN ? u + '@' + DOMAIN : u;
  }
  function toUsername(email) {
    const e = String(email || '').toLowerCase();
    return DOMAIN && e.endsWith('@' + DOMAIN) ? e.slice(0, -DOMAIN.length - 1) : e;
  }

  // ---------- Helpers ----------

  class ApiError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  function check(res) {
    if (res.error) {
      const e = res.error;
      const msg = String(e.message || '');
      if (e.code === '42501' || /row-level security|permission denied/i.test(msg)) {
        throw new ApiError('You are not allowed to do that.', 403);
      }
      if (/JWT|not authenticated/i.test(msg)) expire('Your session has expired. Please sign in again.');
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) throw new ApiError('No connection. Check your internet and try again.', 0);
      throw new ApiError(msg || 'Request failed', 400);
    }
    return res.data;
  }

  function expire(message) {
    clearCache();
    window.dispatchEvent(new CustomEvent('session-expired', { detail: message }));
    throw new ApiError(message, 401);
  }

  function stamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  const mapMember = r => ({
    id: r.id, username: toUsername(r.email), email: r.email, name: r.name || toUsername(r.email),
    role: r.role === 'admin' ? 'Admin' : 'Member', active: r.active, team: r.team || '',
  });
  const mapProject = r => ({
    id: r.id, name: r.name, type: r.type, status: r.status, priority: r.priority || 'Medium',
    client: r.client || '', manager: r.manager || '', notes: r.notes || '',
    startDate: r.start_date || '', endDate: r.end_date || '',
  });
  const mapUpdate = r => ({
    id: r.id, week: r.week, userId: r.user_id, projectId: r.project_id,
    done: r.done || '', next: r.next || '', blockers: r.blockers || '', status: r.status,
    progress: r.progress === null || r.progress === undefined ? null : r.progress,
    submittedAt: stamp(r.created_at), updatedAt: stamp(r.updated_at),
  });
  const mapTask = r => ({
    id: r.id, projectId: r.project_id, week: r.week, title: r.title, notes: r.notes || '', status: r.status,
    team: r.team || '', blockNote: r.block_note || '', assigneeIds: r.assignee_ids || [], contactIds: r.contact_ids || [],
    subtasks: Array.isArray(r.subtasks) ? r.subtasks : [], createdBy: r.created_by,
    createdAt: stamp(r.created_at), updatedAt: stamp(r.updated_at),
    version: r.updated_at,   // exact timestamp, used to spot a teammate saving the same task first
  });
  const mapContact = r => ({ id: r.id, name: r.name, org: r.org || '' });
  const mapMinutes = r => ({
    id: r.id, week: r.week, savedAt: stamp(r.updated_at), savedBy: r.created_by, snapshot: r.snapshot,
  });
  const mapMeeting = r => ({
    id: r.id, date: r.date, week: r.week || '', title: r.title, attendees: r.attendees, notes: r.notes,
    decisions: r.decisions, actionItems: r.action_items, createdAt: stamp(r.created_at),
  });

  function sinceWeek() {
    const d = new Date(Date.now() - HISTORY_WEEKS * 7 * 86400000);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const wk = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
    return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
  }

  // ---------- Local cache ----------

  let data = null; // { me, team, projects, assignments, updates, tasks, contacts, loadedAt }

  // Last version of each task the server confirmed. The screen may show changes that are
  // still saving; changes are always worked out against this confirmed copy.
  const base = new Map();
  function remember(t) { base.set(t.id, t); return t; }
  function putTask(t) {
    data.tasks = data.tasks.some(x => x.id === t.id) ? data.tasks.map(x => x.id === t.id ? t : x) : data.tasks.concat(t);
  }

  // Every write goes through write(), so a refresh that overlaps a save can tell, and
  // fetches again instead of showing data from before the save.
  let writeSeq = 0, inflight = 0;
  async function write(fn) {
    writeSeq++; inflight++;
    try { return await fn(); } finally { inflight--; writeSeq++; }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uniq = list => Array.from(new Set(list || []));
  const cleanSubs = list => (list || []).filter(x => String(x.t || '').trim()).map(x => ({ t: String(x.t).trim(), done: !!x.done }));

  /** Turns app-side task changes into database columns (only the fields given). */
  function taskRow(c) {
    const r = {};
    if ('projectId' in c) r.project_id = c.projectId;
    if ('week' in c) r.week = c.week;
    if ('title' in c) r.title = String(c.title || '').trim();
    if ('notes' in c) r.notes = String(c.notes || '').trim();
    if ('status' in c) r.status = c.status || 'To Do';
    if ('team' in c) r.team = c.team || null;
    if ('blockNote' in c) r.block_note = String(c.blockNote || '').trim();
    if ('assigneeIds' in c) r.assignee_ids = uniq(c.assigneeIds);
    if ('contactIds' in c) r.contact_ids = uniq(c.contactIds);
    if ('subtasks' in c) r.subtasks = cleanSubs(c.subtasks);
    return r;
  }

  async function fetchTask(id) {
    const rows = check(await sb.from('tasks').select('*').eq('id', id));
    if (!rows.length) { base.delete(id); return null; }
    return remember(mapTask(rows[0]));
  }
  const taskQueues = {};   // one save at a time per task, in the order they were made

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; }
  }
  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
  }
  function clearCache() {
    data = null;
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- Public API ----------

  const Api = {
    toUsername: toUsername,

    /** Last data seen on this device (may be stale), or null. */
    cached() {
      if (!data) data = readCache();
      return data;
    },

    /** Fetches everything in one request and updates the cache. */
    async refresh() {
      for (let attempt = 0; ; attempt++) {
        // Let saves finish first, and fetch again if one happened meanwhile.
        for (let waited = 0; inflight > 0 && waited < 10000; waited += 150) await sleep(150);
        const seq = writeSeq;
        const res = check(await sb.rpc('app_bootstrap', { p_since: sinceWeek() }));
        if (!res || !res.me) expire('Please sign in.');
        if (!res.me.active) {
          await sb.auth.signOut();
          expire('Your account is not active. Ask an admin to activate it on the Team page.');
        }
        if ((writeSeq !== seq || inflight > 0) && attempt < 3) continue;
        return Api._apply(res);
      }
    },

    _apply(res) {
      data = {
        me: mapMember(res.me),
        team: res.team.map(mapMember),
        projects: res.projects.map(mapProject),
        assignments: res.assignments.map(a => ({ projectId: a.project_id, userId: a.user_id })),
        updates: res.updates.map(mapUpdate),
        tasks: (res.tasks || []).map(mapTask),
        contacts: (res.contacts || []).map(mapContact),
        loadedAt: Date.now(),
      };
      base.clear();
      data.tasks.forEach(remember);
      writeCache();
      return data;
    },

    async saveUpdate(p) {
      const progress = p.progress === '' || p.progress === null || p.progress === undefined
        ? null : Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0)));
      const row = check(await sb.from('weekly_updates').upsert({
        week: p.week, user_id: data.me.id, project_id: p.projectId,
        done: String(p.done || '').trim(), next: String(p.next || '').trim(), blockers: String(p.blockers || '').trim(),
        status: p.status || 'On Track', progress: progress,
      }, { onConflict: 'week,user_id,project_id' }).select().single());
      const saved = mapUpdate(row);
      data.updates = data.updates.filter(u => !(u.week === saved.week && u.projectId === saved.projectId)).concat(saved);
      writeCache();
      return saved;
    },

    /** All updates for a week (admins see everyone's). */
    async weekUpdates(week) {
      return check(await sb.from('weekly_updates').select('*').eq('week', week)).map(mapUpdate);
    },

    // ----- Tasks -----

    /** Creates a task. */
    async addTask(t) {
      return write(async () => {
        const row = taskRow(Object.assign({ notes: '', status: 'To Do', team: '', blockNote: '', assigneeIds: [], contactIds: [], subtasks: [] }, t));
        const saved = remember(mapTask(check(await sb.from('tasks').insert(row).select().single())));
        putTask(saved);
        writeCache();
        return saved;
      });
    },

    /**
     * Saves a change to a task. `change(task)` returns only the fields to change, e.g.
     * { status: 'Done' }. It is worked out against the latest saved version, and if a
     * teammate saved the task first it is worked out again on top of their version, so
     * neither person's change is lost.
     */
    patchTask(id, change) {
      const prev = taskQueues[id] || Promise.resolve();
      const job = prev.catch(() => {}).then(() => write(async () => {
        let cur = base.get(id) || await fetchTask(id);
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!cur) throw new ApiError('This task was deleted by a teammate.', 404);
          const row = taskRow(change(cur));
          if (!Object.keys(row).length) return cur;
          let q = sb.from('tasks').update(row).eq('id', id);
          if (cur.version) q = q.eq('updated_at', cur.version);
          const rows = check(await q.select());
          if (rows.length) return remember(mapTask(rows[0]));
          cur = await fetchTask(id);   // someone saved first (or it's gone): try again on their version
        }
        throw new ApiError('You are not allowed to change this task.', 403);
      }));
      taskQueues[id] = job;
      const last = () => taskQueues[id] === job;
      return job.then(saved => {
        // While more changes to this task are queued, keep showing them.
        if (last()) { delete taskQueues[id]; putTask(saved); writeCache(); }
        return saved;
      }, e => {
        if (last()) {
          delete taskQueues[id];
          const b = base.get(id);
          if (b) putTask(b); else data.tasks = data.tasks.filter(x => x.id !== id);
          writeCache();
        }
        throw e;
      });
    },

    async deleteTask(id) {
      return write(async () => {
        check(await sb.from('tasks').delete().eq('id', id));
        base.delete(id);
        data.tasks = data.tasks.filter(x => x.id !== id);
        writeCache();
      });
    },

    /** Adds a 3rd party (someone without an account). Re-uses an existing one with the same name. */
    async addContact(name, org) { return write(() => Api._addContact(name, org)); },
    async _addContact(name, org) {
      const clean = String(name || '').trim();
      if (!clean) throw new ApiError('Enter a name.');
      const existing = data.contacts.find(c => c.name.toLowerCase() === clean.toLowerCase());
      if (existing) return existing;
      const res = await sb.from('contacts').insert({ name: clean, org: String(org || '').trim() }).select().single();
      let saved;
      if (res.error && /duplicate|unique/i.test(res.error.message || '')) {
        saved = mapContact(check(await sb.from('contacts').select('*').ilike('name', clean).limit(1).single()));
      } else {
        saved = mapContact(check(res));
      }
      data.contacts = data.contacts.filter(c => c.id !== saved.id).concat(saved).sort((a, b) => a.name.localeCompare(b.name));
      writeCache();
      return saved;
    },

    async saveContact(c) { return write(() => Api._saveContact(c)); },
    async _saveContact(c) {
      const saved = mapContact(check(await sb.from('contacts').update({ name: String(c.name || '').trim(), org: String(c.org || '').trim() }).eq('id', c.id).select().single()));
      data.contacts = data.contacts.map(x => x.id === saved.id ? saved : x);
      writeCache();
      return saved;
    },

    async deleteContact(id) { return write(() => Api._deleteContact(id)); },
    async _deleteContact(id) {
      check(await sb.from('contacts').delete().eq('id', id));
      data.contacts = data.contacts.filter(c => c.id !== id);
      writeCache();
    },

    // ----- Joining projects -----

    async joinProject(projectId) { return write(() => Api._joinProject(projectId)); },
    async _joinProject(projectId) {
      check(await sb.from('assignments').insert({ project_id: projectId, user_id: data.me.id }));
      data.assignments = data.assignments.filter(a => !(a.projectId === projectId && a.userId === data.me.id))
        .concat({ projectId: projectId, userId: data.me.id });
      writeCache();
    },

    async leaveProject(projectId) { return write(() => Api._leaveProject(projectId)); },
    async _leaveProject(projectId) {
      check(await sb.from('assignments').delete().eq('project_id', projectId).eq('user_id', data.me.id));
      data.assignments = data.assignments.filter(a => !(a.projectId === projectId && a.userId === data.me.id));
      writeCache();
    },

    // ----- Live updates -----

    /** Calls onChange(table) whenever a teammate changes tasks, projects, assignments or 3rd parties. */
    subscribe(onChange) {
      const ch = sb.channel('acs-live');
      ['tasks', 'assignments', 'contacts', 'projects'].forEach(table => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: table }, payload => onChange(table, payload));
      });
      ch.subscribe(status => onChange('status', { status: status }));
      return () => sb.removeChannel(ch);
    },

    async meetings() {
      return check(await sb.from('meetings').select('*').order('date', { ascending: false })).map(mapMeeting);
    },

    async saveMeeting(p) {
      const row = {
        date: p.date, week: p.week || null, title: p.title || 'Weekly meeting', attendees: p.attendees || '',
        notes: p.notes || '', decisions: p.decisions || '', action_items: p.actionItems || '',
      };
      const q = p.id
        ? sb.from('meetings').update(row).eq('id', p.id)
        : sb.from('meetings').insert(Object.assign({ created_by: data.me.id }, row));
      return mapMeeting(check(await q.select().single()));
    },

    /**
     * Saves a project. userIds = the people ticked in the form; originalIds = the people
     * ticked when the form was opened. Only the difference is sent, so people who joined
     * in the meantime stay on the project.
     */
    async saveProject(p, userIds, originalIds) {
      return write(async () => {
        const add = uniq(userIds);
        const remove = uniq(originalIds).filter(id => add.indexOf(id) === -1);
        const row = check(await sb.rpc('admin_save_project', {
          p: {
            id: p.id || '', name: p.name, type: p.type, status: p.status, priority: p.priority,
            client: p.client || '', manager: p.manager || '', notes: p.notes || '',
            start_date: p.startDate || '', end_date: p.endDate || '',
          },
          p_add_ids: add,
          p_remove_ids: remove,
        }));
        const saved = mapProject(row);
        data.projects = data.projects.filter(x => x.id !== saved.id).concat(saved).sort((a, b) => a.id.localeCompare(b.id));
        data.assignments = data.assignments
          .filter(a => !(a.projectId === saved.id && (remove.indexOf(a.userId) !== -1 || add.indexOf(a.userId) !== -1)))
          .concat(add.map(id => ({ projectId: saved.id, userId: id })));
        writeCache();
        return saved;
      });
    },

    // ----- Saved minutes -----

    /** The saved minutes for a week, or null. */
    async minutes(week) {
      const rows = check(await sb.from('meetings').select('id,week,updated_at,created_by,snapshot')
        .eq('week', week).not('snapshot', 'is', null).limit(1));
      return rows.length ? mapMinutes(rows[0]) : null;
    },

    /** Saves (or replaces) the week's minutes. Admins only. */
    async saveMinutes(week, snapshot) {
      return write(async () => mapMinutes(check(await sb.rpc('admin_save_minutes', { p_week: week, p_snapshot: snapshot }))));
    },

    async saveMember(p) { return write(() => Api._saveMember(p)); },
    async _saveMember(p) {
      const role = p.role === 'Admin' ? 'admin' : 'member';
      const password = String(p.password || '');
      if (p.isNew) {
        const id = check(await sb.rpc('admin_create_user', {
          p_email: toEmail(p.username), p_password: password, p_name: p.name || '', p_role: role,
        }));
        check(await sb.from('profiles').update({ active: p.active !== false, team: p.team || null }).eq('id', id));
      } else {
        check(await sb.from('profiles').update({ name: p.name, role: role, active: p.active !== false, team: p.team || null }).eq('id', p.id));
        if (password) check(await sb.rpc('admin_set_password', { p_user_id: p.id, p_password: password }));
      }
      data.team = check(await sb.from('profiles').select('id,email,name,role,active,team').order('name')).map(mapMember);
      writeCache();
    },

    async changePassword(current, next) {
      if (String(next || '').length < 8) throw new ApiError('The new password must be at least 8 characters.');
      const verify = await sb.auth.signInWithPassword({ email: data.me.email, password: String(current || '') });
      if (verify.error) throw new ApiError('Your current password is not correct.');
      const res = await sb.auth.updateUser({ password: next });
      if (res.error) throw new ApiError(res.error.message);
    },

    async login(username, password) {
      const res = await sb.auth.signInWithPassword({ email: toEmail(username), password: password });
      if (res.error) {
        const msg = res.error.message || '';
        throw new ApiError(/invalid/i.test(msg) ? 'Wrong username or password.'
          : /fetch|network/i.test(msg) ? 'No connection. Check your internet and try again.' : msg, 401);
      }
      clearCache();
      return Api.refresh();
    },

    /** The signed-in user's id from the locally stored session (no network), or null. */
    async sessionUserId() {
      const { data: s } = await sb.auth.getSession();
      return s.session ? s.session.user.id : null;
    },

    async logout() {
      clearCache();
      await sb.auth.signOut();
    },
  };

  window.Api = Api;
})();
