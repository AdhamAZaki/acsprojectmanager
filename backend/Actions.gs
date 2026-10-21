/**
 * API actions. Each receives (payload, user) where user = { username, name, role }.
 */

const WEEK_RE = /^\d{4}-W\d{2}$/;

function requireWeek_(week) {
  const w = String(week || '').trim();
  if (!WEEK_RE.test(w)) throw new AppError('Invalid week. Expected format like 2026-W43.');
  return w;
}

// ---------- Member actions ----------

function actionMyProjects(p, user) {
  const mine = listAssignments_().filter(a => same_(a.username, user.username)).map(a => a.projectId);
  return listProjects_()
    .filter(pr => mine.indexOf(pr.id) !== -1)
    .sort((a, b) => (a.status === 'Closed') - (b.status === 'Closed') || String(a.name).localeCompare(b.name));
}

function actionMyUpdates(p, user) {
  return readTable_('WeeklyUpdates')
    .filter(r => same_(r.Username, user.username) && (!p.week || String(r.Week) === p.week))
    .map(mapUpdate_);
}

function actionSaveUpdate(p, user) {
  const week = requireWeek_(p.week);
  const projectId = String(p.projectId || '').trim();
  const project = listProjects_().find(pr => pr.id === projectId);
  if (!project) throw new AppError('Project not found.');

  const assigned = listAssignments_().some(a => a.projectId === projectId && same_(a.username, user.username));
  if (!assigned && user.role !== 'Admin') throw new AppError('You are not assigned to this project.', 403);

  const progress = p.progress === '' || p.progress === null || p.progress === undefined
    ? '' : Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0)));

  return withLock_(() => {
    const existing = readTable_('WeeklyUpdates').find(r =>
      String(r.Week) === week && same_(r.Username, user.username) && String(r.ProjectID) === projectId);
    const now = nowStamp_();
    const record = Object.assign({}, existing || {}, {
      UpdateID: existing ? existing.UpdateID : Utilities.getUuid(),
      Week: week,
      Username: user.username,
      Name: user.name,
      ProjectID: projectId,
      ProjectName: project.name,
      DoneThisWeek: text_(p.done),
      PlanNextWeek: text_(p.next),
      Blockers: text_(p.blockers),
      Status: oneOf_(p.status, UPDATE_STATUSES, 'On Track'),
      Progress: progress,
      SubmittedAt: existing ? existing.SubmittedAt : now,
      UpdatedAt: now,
    });
    writeRecord_('WeeklyUpdates', record, existing && existing._row);
    return mapUpdate_(record);
  });
}

function actionListMeetings() {
  return readTable_('Meetings').map(mapMeeting_)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ---------- Admin actions ----------

function actionSaveProject(p) {
  const name = text_(p.name, 200);
  if (!name) throw new AppError('Project name is required.');

  return withLock_(() => {
    const rows = readTable_('Projects');
    let id = text_(p.id, 50);
    const existing = id ? rows.find(r => String(r.ProjectID) === id) : null;
    if (!id) id = nextProjectId_(rows);

    const record = Object.assign({}, existing || {}, {
      ProjectID: id,
      Name: name,
      Type: oneOf_(p.type, PROJECT_TYPES, 'Other'),
      Client: text_(p.client, 200),
      Manager: text_(p.manager, 200),
      Status: oneOf_(p.status, PROJECT_STATUSES, 'Active'),
      StartDate: text_(p.startDate, 20),
      EndDate: text_(p.endDate, 20),
      Notes: text_(p.notes),
    });
    writeRecord_('Projects', record, existing && existing._row);
    return mapProject_(record);
  });
}

function nextProjectId_(rows) {
  let max = 0;
  rows.forEach(r => {
    const m = /^PRJ-(\d+)$/.exec(String(r.ProjectID));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'PRJ-' + String(max + 1).padStart(4, '0');
}

function actionSaveMember(p, user) {
  const username = normUser_(p.username);
  if (!/^[a-z0-9._@-]{2,100}$/.test(username)) {
    throw new AppError('Username can use letters, numbers and . _ @ - (2–100 characters).');
  }
  const role = oneOf_(p.role, ROLES, 'Member');
  const active = p.active !== false;
  if (same_(username, user.username) && (role !== 'Admin' || !active)) {
    throw new AppError('You cannot remove your own admin access.');
  }
  const password = String(p.password || '');
  if (password && password.length < 8) throw new AppError('Password must be at least 8 characters.');

  return withLock_(() => {
    const existing = readTable_('Team').find(r => same_(r.Username, username));
    if (!existing && !password) throw new AppError('Set a password for the new member.');
    if (existing && p.isNew) throw new AppError('That username already exists.');
    const record = Object.assign({}, existing || {}, {
      Username: username, Name: text_(p.name, 200) || username, Role: role, Active: active,
    });
    if (password) record.Password = hashPassword_(password);
    writeRecord_('Team', record, existing && existing._row);
    return mapMember_(record);
  });
}

function actionSetAssignments(p) {
  const projectId = String(p.projectId || '').trim();
  if (!listProjects_().some(pr => pr.id === projectId)) throw new AppError('Project not found.');
  const usernames = Array.from(new Set((p.usernames || []).map(normUser_).filter(Boolean)));

  return withLock_(() => {
    const kept = listAssignments_().filter(a => a.projectId !== projectId);
    const records = kept.concat(usernames.map(u => ({ projectId: projectId, username: u })))
      .map(a => ({ ProjectID: a.projectId, Username: a.username }));
    rewriteTable_('Assignments', records);
    return { projectId: projectId, usernames: usernames };
  });
}

/** Everything the weekly meeting needs: all updates + who has not submitted. */
function actionWeekReport(p) {
  const week = requireWeek_(p.week);
  const projects = listProjects_();
  const team = listTeam_().filter(m => m.active);
  const updates = readTable_('WeeklyUpdates').filter(r => String(r.Week) === week).map(mapUpdate_);

  const openIds = projects.filter(pr => pr.status !== 'Closed' && pr.status !== 'Completed').map(pr => pr.id);
  const missing = [];
  listAssignments_().forEach(a => {
    if (openIds.indexOf(a.projectId) === -1) return;
    const member = team.find(m => m.username === a.username);
    if (!member) return;
    const has = updates.some(u => u.projectId === a.projectId && same_(u.username, a.username));
    if (!has) {
      const pr = projects.find(x => x.id === a.projectId);
      missing.push({ username: member.username, name: member.name, projectId: pr.id, projectName: pr.name });
    }
  });

  return { week: week, projects: projects, team: team, updates: updates, missing: missing };
}

function actionSaveMeeting(p, user) {
  const date = text_(p.date, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('Meeting date is required.');

  return withLock_(() => {
    const existing = p.id ? readTable_('Meetings').find(r => r.MeetingID === p.id) : null;
    const record = Object.assign({}, existing || {}, {
      MeetingID: existing ? existing.MeetingID : Utilities.getUuid(),
      Date: date,
      Week: p.week ? requireWeek_(p.week) : '',
      Title: text_(p.title, 200) || 'Weekly meeting',
      Attendees: text_(p.attendees, 2000),
      Notes: text_(p.notes, 20000),
      Decisions: text_(p.decisions, 10000),
      ActionItems: text_(p.actionItems, 10000),
      CreatedBy: existing ? existing.CreatedBy : user.username,
      CreatedAt: existing ? existing.CreatedAt : nowStamp_(),
    });
    writeRecord_('Meetings', record, existing && existing._row);
    return mapMeeting_(record);
  });
}
