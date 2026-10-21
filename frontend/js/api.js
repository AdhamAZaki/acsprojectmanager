// Data layer: talks to Supabase directly (auth + database). Security is enforced
// by the database's Row Level Security rules (supabase/setup.sql), not here.
// Exposes the same call(action, payload) interface the UI was built on.
(function () {
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const DOMAIN = String(cfg.EMAIL_DOMAIN || '').toLowerCase();

  // ---------- Usernames <-> emails ----------
  // People sign in with a short username ("ahmed"); Supabase needs an email,
  // so we add EMAIL_DOMAIN. A full email address also works.

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
      throw new ApiError(msg || 'Request failed', 400);
    }
    return res.data;
  }

  function expire(message) {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: message }));
    throw new ApiError(message, 401);
  }

  function stamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  const mapProject = r => ({
    id: r.id, name: r.name, type: r.type, client: r.client, manager: r.manager, status: r.status,
    startDate: r.start_date || '', endDate: r.end_date || '', notes: r.notes,
  });
  const mapMember = r => ({
    id: r.id, username: toUsername(r.email), email: r.email, name: r.name || toUsername(r.email),
    role: r.role === 'admin' ? 'Admin' : 'Member', active: r.active,
  });
  const mapMeeting = r => ({
    id: r.id, date: r.date, week: r.week || '', title: r.title, attendees: r.attendees, notes: r.notes,
    decisions: r.decisions, actionItems: r.action_items, createdAt: stamp(r.created_at),
  });

  // Profiles are cached so updates/assignments (stored by user id) can be shown by username/name.
  let profileCache = null;
  async function profiles(force) {
    if (force || !profileCache) {
      profileCache = check(await sb.from('profiles').select('id,email,name,role,active').order('name')).map(mapMember);
    }
    return profileCache;
  }
  async function byUsername(username) {
    const m = (await profiles()).find(p => p.username === username) || (await profiles(true)).find(p => p.username === username);
    if (!m) throw new ApiError('Unknown user: ' + username);
    return m;
  }
  function mapUpdate(r, team) {
    const m = team.find(p => p.id === r.user_id) || {};
    return {
      id: r.id, week: r.week, username: m.username || '', name: m.name || '',
      projectId: r.project_id, projectName: r.projects ? r.projects.name : '',
      done: r.done, next: r.next, blockers: r.blockers, status: r.status,
      progress: r.progress === null || r.progress === undefined ? null : r.progress,
      submittedAt: stamp(r.created_at), updatedAt: stamp(r.updated_at),
    };
  }

  let current = null; // { id, username, name, role }
  async function me() {
    if (current) return current;
    const { data } = await sb.auth.getSession();
    if (!data.session) expire('Please sign in.');
    const row = check(await sb.from('profiles').select('id,email,name,role,active').eq('id', data.session.user.id).maybeSingle());
    if (!row || !row.active) {
      await sb.auth.signOut();
      expire('Your account is disabled. Contact an admin.');
    }
    const m = mapMember(row);
    current = { id: m.id, username: m.username, name: m.name, role: m.role };
    return current;
  }

  // ---------- Actions ----------

  const actions = {
    async me() {
      const u = await me();
      return { username: u.username, name: u.name, role: u.role };
    },

    async myProjects() {
      const u = await me();
      const rows = check(await sb.from('assignments').select('projects(*)').eq('user_id', u.id));
      return rows.map(r => r.projects).filter(Boolean).map(mapProject)
        .sort((a, b) => (a.status === 'Closed') - (b.status === 'Closed') || a.name.localeCompare(b.name));
    },

    async myUpdates(p) {
      const u = await me();
      let q = sb.from('weekly_updates').select('*, projects(name)').eq('user_id', u.id);
      if (p.week) q = q.eq('week', p.week);
      const [rows, team] = await Promise.all([q.then(check), profiles()]);
      return rows.map(r => mapUpdate(r, team));
    },

    async saveUpdate(p) {
      const u = await me();
      const progress = p.progress === '' || p.progress === null || p.progress === undefined
        ? null : Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0)));
      const row = check(await sb.from('weekly_updates').upsert({
        week: p.week, user_id: u.id, project_id: p.projectId,
        done: String(p.done || '').trim(), next: String(p.next || '').trim(), blockers: String(p.blockers || '').trim(),
        status: p.status || 'On Track', progress: progress,
      }, { onConflict: 'week,user_id,project_id' }).select('*, projects(name)').single());
      return mapUpdate(row, await profiles());
    },

    async changePassword(p) {
      const u = await me();
      if (String(p.next || '').length < 8) throw new ApiError('The new password must be at least 8 characters.');
      const email = (await profiles()).find(m => m.id === u.id).email;
      const verify = await sb.auth.signInWithPassword({ email: email, password: String(p.current || '') });
      if (verify.error) throw new ApiError('Your current password is not correct.');
      const res = await sb.auth.updateUser({ password: p.next });
      if (res.error) throw new ApiError(res.error.message);
      return { changed: true };
    },

    async listMeetings() {
      return check(await sb.from('meetings').select('*').order('date', { ascending: false })).map(mapMeeting);
    },

    async saveMeeting(p) {
      const u = await me();
      const row = {
        date: p.date, week: p.week || null, title: p.title || 'Weekly meeting', attendees: p.attendees || '',
        notes: p.notes || '', decisions: p.decisions || '', action_items: p.actionItems || '',
      };
      const q = p.id
        ? sb.from('meetings').update(row).eq('id', p.id)
        : sb.from('meetings').insert(Object.assign({ created_by: u.id }, row));
      return mapMeeting(check(await q.select().single()));
    },

    async listProjects() {
      return check(await sb.from('projects').select('*').order('id')).map(mapProject);
    },

    async saveProject(p) {
      let id = String(p.id || '').trim();
      if (!id) {
        const ids = check(await sb.from('projects').select('id')).map(r => r.id);
        const max = ids.reduce((m, x) => { const k = /^PRJ-(\d+)$/.exec(x); return k ? Math.max(m, Number(k[1])) : m; }, 0);
        id = 'PRJ-' + String(max + 1).padStart(4, '0');
      }
      const row = check(await sb.from('projects').upsert({
        id: id, name: String(p.name || '').trim(), type: p.type || 'Other', status: p.status || 'Active',
        client: p.client || '', manager: p.manager || '', notes: p.notes || '',
        start_date: p.startDate || null, end_date: p.endDate || null,
      }).select().single());
      return mapProject(row);
    },

    async listTeam() {
      return profiles(true);
    },

    async saveMember(p) {
      const role = p.role === 'Admin' ? 'admin' : 'member';
      const password = String(p.password || '');
      if (p.isNew) {
        const id = check(await sb.rpc('admin_create_user', {
          p_email: toEmail(p.username), p_password: password, p_name: p.name || '', p_role: role,
        }));
        if (p.active === false) check(await sb.from('profiles').update({ active: false }).eq('id', id));
      } else {
        const m = await byUsername(p.username);
        check(await sb.from('profiles').update({ name: p.name || m.name, role: role, active: p.active !== false }).eq('id', m.id));
        if (password) check(await sb.rpc('admin_set_password', { p_user_id: m.id, p_password: password }));
      }
      await profiles(true);
      return { saved: true };
    },

    async listAssignments() {
      const [team, rows] = await Promise.all([profiles(), sb.from('assignments').select('project_id,user_id').then(check)]);
      return rows.map(a => ({
        projectId: a.project_id, username: (team.find(m => m.id === a.user_id) || {}).username || '',
      }));
    },

    async setAssignments(p) {
      const ids = [];
      for (const username of p.usernames || []) ids.push((await byUsername(username)).id);
      check(await sb.from('assignments').delete().eq('project_id', p.projectId));
      if (ids.length) {
        check(await sb.from('assignments').insert(ids.map(id => ({ project_id: p.projectId, user_id: id }))));
      }
      return { projectId: p.projectId, usernames: p.usernames };
    },

    async weekReport(p) {
      const [projects, team, assignments, rows] = await Promise.all([
        actions.listProjects(), profiles(true), actions.listAssignments(),
        sb.from('weekly_updates').select('*, projects(name)').eq('week', p.week).then(check),
      ]);
      const updates = rows.map(r => mapUpdate(r, team)).sort((a, b) => a.name.localeCompare(b.name));
      const active = team.filter(m => m.active);
      const open = projects.filter(pr => pr.status !== 'Closed' && pr.status !== 'Completed');
      const missing = [];
      assignments.forEach(a => {
        const pr = open.find(x => x.id === a.projectId);
        const m = active.find(x => x.username === a.username);
        if (pr && m && !updates.some(u => u.projectId === pr.id && u.username === m.username)) {
          missing.push({ username: m.username, name: m.name, projectId: pr.id, projectName: pr.name });
        }
      });
      return { week: p.week, projects: projects, team: active, updates: updates, missing: missing };
    },
  };

  async function call(action, payload) {
    const fn = actions[action];
    if (!fn) throw new ApiError('Unknown action: ' + action, 404);
    try {
      return await fn(payload || {});
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(/fetch/i.test(String(e.message)) ? 'Cannot reach the server. Check your connection.' : e.message);
    }
  }

  const Auth = {
    async login(username, password) {
      const res = await sb.auth.signInWithPassword({ email: toEmail(username), password: password });
      if (res.error) {
        throw new ApiError(/invalid/i.test(res.error.message) ? 'Wrong username or password.' : res.error.message, 401);
      }
      current = null;
      profileCache = null;
      await Promise.all([me(), profiles()]);
    },
    async hasSession() {
      const { data } = await sb.auth.getSession();
      return !!data.session;
    },
    async logout() {
      await sb.auth.signOut();
      location.reload();
    },
  };

  window.Api = { call: call, Auth: Auth };
})();
