/**
 * One-time setup. Open the Sheet → Extensions → Apps Script and run setup()
 * once (or use the "ACS Tracker → Set up / repair sheets" menu afterwards).
 * It creates any missing tabs/columns and never deletes data.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ACS Tracker')
    .addItem('Set up / repair sheets', 'setup')
    .addToUi();
}

function setup() {
  const ss = ss_();

  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const headers = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      const existing = headers_(sh);
      const missing = headers.filter(h => existing.indexOf(h) === -1);
      if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    sh.getRange(1, 1, 1, sh.getLastColumn())
      .setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });

  // Keep IDs and week codes as plain text so Sheets never converts them.
  [['Projects', 'ProjectID'], ['Assignments', 'ProjectID'], ['WeeklyUpdates', 'ProjectID'],
   ['WeeklyUpdates', 'Week'], ['Meetings', 'Week'], ['Team', 'Password']].forEach(([name, col]) => {
    const sh = ss.getSheetByName(name);
    const idx = headers_(sh).indexOf(col) + 1;
    if (idx > 0) sh.getRange(2, idx, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  addValidation_(ss.getSheetByName('Projects'), 'Type', PROJECT_TYPES);
  addValidation_(ss.getSheetByName('Projects'), 'Status', PROJECT_STATUSES);
  addValidation_(ss.getSheetByName('Team'), 'Role', ROLES);
  addValidation_(ss.getSheetByName('WeeklyUpdates'), 'Status', UPDATE_STATUSES);
  const team = ss.getSheetByName('Team');
  const activeCol = headers_(team).indexOf('Active') + 1;
  // A checkbox rule (not insertCheckboxes) so empty rows stay empty and appendRow still works.
  team.getRange(2, activeCol, team.getMaxRows() - 1, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  getSessionSecret_();

  if (!readTable_('Team').some(r => isActive_(r.Active) && same_(r.Role, 'Admin'))) {
    console.warn('No active Admin yet: add a row to the Team tab (Username, Password, Name, Role = Admin, Active ticked).');
  }

  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  console.log('Setup complete.');
}

function addValidation_(sh, column, values) {
  const idx = headers_(sh).indexOf(column) + 1;
  if (!idx) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sh.getRange(2, idx, sh.getMaxRows() - 1, 1).setDataValidation(rule);
}
