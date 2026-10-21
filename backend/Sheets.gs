/**
 * Thin data layer over the Google Sheet. Each tab is a table whose first row
 * holds the column headers below.
 */

const SHEETS = {
  Projects:      ['ProjectID', 'Name', 'Type', 'Client', 'Manager', 'Status', 'StartDate', 'EndDate', 'Notes'],
  Team:          ['Username', 'Password', 'Name', 'Role', 'Active'],
  Assignments:   ['ProjectID', 'Username'],
  WeeklyUpdates: ['UpdateID', 'Week', 'Username', 'Name', 'ProjectID', 'ProjectName', 'DoneThisWeek',
                  'PlanNextWeek', 'Blockers', 'Status', 'Progress', 'SubmittedAt', 'UpdatedAt'],
  Meetings:      ['MeetingID', 'Date', 'Week', 'Title', 'Attendees', 'Notes', 'Decisions',
                  'ActionItems', 'CreatedBy', 'CreatedAt'],
};

const PROJECT_TYPES = ['PLC', 'AVEVA', 'Other'];
const PROJECT_STATUSES = ['Active', 'On Hold', 'Completed', 'Closed'];
const UPDATE_STATUSES = ['On Track', 'At Risk', 'Delayed', 'Blocked', 'Done'];
const ROLES = ['Member', 'Admin'];

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new AppError('Sheet "' + name + '" is missing. Run setup() in Apps Script.', 500);
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
}

/** Returns rows as objects keyed by header, plus _row (1-based sheet row). */
function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const tz = Session.getScriptTimeZone();
  const rows = [];
  values.forEach((row, i) => {
    if (row.every(v => v === '' || v === null)) return;
    const obj = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) obj[h] = normalizeCell_(row[c], tz); });
    rows.push(obj);
  });
  return rows;
}

function normalizeCell_(v, tz) {
  if (v instanceof Date) {
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, tz, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  }
  return v;
}

/** Writes a record; updates rowNumber if given, otherwise appends. */
function writeRecord_(name, record, rowNumber) {
  const sh = sheet_(name);
  const row = headers_(sh).map(h => toCell_(record[h]));
  if (rowNumber) sh.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/** Replaces all data rows of a sheet (header kept). */
function rewriteTable_(name, records) {
  const sh = sheet_(name);
  const headers = headers_(sh);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  if (records.length) {
    sh.getRange(2, 1, records.length, headers.length)
      .setValues(records.map(r => headers.map(h => toCell_(r[h]))));
  }
}

/** Prevents user text such as "=IMPORTXML(...)" or "- item" being treated as a formula. */
function toCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function same_(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function isActive_(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v).trim());
}

function text_(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 5000);
}

function oneOf_(v, list, fallback) {
  const match = list.find(x => same_(x, v || ''));
  return match || fallback;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

// ---------- Mappers (sheet row -> API object) ----------

function mapProject_(r) {
  return {
    id: String(r.ProjectID), name: r.Name, type: r.Type, client: r.Client, manager: r.Manager,
    status: r.Status, startDate: r.StartDate, endDate: r.EndDate, notes: r.Notes,
  };
}

/** Never includes the Password column. */
function mapMember_(r) {
  return {
    username: normUser_(r.Username), name: r.Name || r.Username,
    role: oneOf_(r.Role, ROLES, 'Member'), active: isActive_(r.Active),
  };
}

function mapUpdate_(r) {
  return {
    id: r.UpdateID, week: String(r.Week), username: normUser_(r.Username), name: r.Name,
    projectId: String(r.ProjectID), projectName: r.ProjectName,
    done: r.DoneThisWeek, next: r.PlanNextWeek, blockers: r.Blockers,
    status: r.Status, progress: r.Progress === '' ? null : Number(r.Progress),
    submittedAt: r.SubmittedAt, updatedAt: r.UpdatedAt,
  };
}

function mapMeeting_(r) {
  return {
    id: r.MeetingID, date: r.Date, week: String(r.Week), title: r.Title, attendees: r.Attendees,
    notes: r.Notes, decisions: r.Decisions, actionItems: r.ActionItems,
    createdBy: r.CreatedBy, createdAt: r.CreatedAt,
  };
}

// ---------- Queries ----------

function listProjects_() {
  return readTable_('Projects').map(mapProject_);
}

function listTeam_() {
  return readTable_('Team').map(mapMember_);
}

function listAssignments_() {
  return readTable_('Assignments').map(r => ({
    projectId: String(r.ProjectID), username: normUser_(r.Username),
  }));
}

/** Active team member by username, or null. */
function findMember_(username) {
  const row = readTable_('Team').find(r => same_(r.Username, username));
  if (!row || !isActive_(row.Active)) return null;
  const m = mapMember_(row);
  return { username: m.username, name: m.name, role: m.role };
}
