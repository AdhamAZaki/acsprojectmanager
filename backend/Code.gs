/**
 * ACS Project Tracker — Google Apps Script backend.
 *
 * Deploy as a Web App (Execute as: Me, Who has access: Anyone).
 * Anyone can reach the URL, but every action except "login" requires a
 * signed session token, and a session is only issued after the user's Zoho
 * identity has been verified and found in the Team sheet.
 *
 * Request:  POST, body = JSON { action, token, payload }  (sent as text/plain
 *           so the browser does not need a CORS preflight)
 * Response: JSON { ok: true, data } or { ok: false, error, code }
 */

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 400;
  }
}

function getRoutes_() {
  return {
    // Public
    login:           { auth: false, fn: actionLogin },

    // Any signed-in member
    me:              { fn: (p, user) => user },
    myProjects:      { fn: actionMyProjects },
    myUpdates:       { fn: actionMyUpdates },
    saveUpdate:      { fn: actionSaveUpdate },
    listMeetings:    { fn: actionListMeetings },

    // Admins only
    listProjects:    { admin: true, fn: () => listProjects_() },
    saveProject:     { admin: true, fn: actionSaveProject },
    listTeam:        { admin: true, fn: () => listTeam_() },
    saveMember:      { admin: true, fn: actionSaveMember },
    listAssignments: { admin: true, fn: () => listAssignments_() },
    setAssignments:  { admin: true, fn: actionSetAssignments },
    weekReport:      { admin: true, fn: actionWeekReport },
    saveMeeting:     { admin: true, fn: actionSaveMeeting },
  };
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Invalid request body', code: 400 });
  }

  try {
    const route = getRoutes_()[body.action];
    if (!route) throw new AppError('Unknown action: ' + body.action, 404);

    let user = null;
    if (route.auth !== false) {
      user = requireSession_(body.token);
      if (route.admin && user.role !== 'Admin') {
        throw new AppError('Admin access required', 403);
      }
    }
    const data = route.fn(body.payload || {}, user);
    return json_({ ok: true, data: data });
  } catch (err) {
    const known = err instanceof AppError;
    if (!known) console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      error: known ? err.message : 'Server error. Please try again.',
      code: known ? err.code : 500,
    });
  }
}

function doGet() {
  return json_({ ok: true, service: 'ACS Project Tracker API' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Script Properties with sensible defaults. */
function getConfig_(key) {
  const defaults = {
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
    ALLOWED_DOMAIN: 'advcontrolsys.com',
  };
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value !== null && value !== '' ? value : (defaults[key] || '');
}
