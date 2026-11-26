/**
 * Team HQ back end. Paste this file into the Apps Script project of the Team Board sheet.
 *
 * It does two jobs:
 *   1. Watchdog: once an hour it compares the runs listed in the Expected tab with the reports
 *      each assistant posted, and sends one short phone alert when a run did not report.
 *      It runs on Google's side, so it keeps working when the assistants cannot run.
 *   2. Data feed for the Team HQ app: one POST returns the board, and the app can post
 *      the owner's replies, notes and the dial setting.
 *   3. Digest: after each check and each tap in the app it rewrites the Digest tab with only what is
 *      still open, so an assistant reads one short tab and never the full history.
 *
 * Names of people and assistants, the assistants' roles and labels, and the Dial's words live in the Settings tab, never in this file.
 */
var VERSION_ = '1.2.1';
var OUT_ROWS_ = 1000; // only the newest rows of each Out_ tab are read, so a year of history stays fast
var MAX_BODY_ = 20000;
var OUT_HEAD_ = ['Row ID', 'Time', 'Kind', 'To', 'Re', 'Subject', 'Brief', 'Due', 'Needs owner', 'State', 'Source trust', 'Link'];
var EXPECTED_HEAD_ = ['Run', 'Role', 'Days', 'Due by', 'Active', 'Scheduled', 'Notes'];
var SET_HEAD_ = ['Setting', 'Value', 'What it does'];
var WATCH_HEAD_ = ['Date', 'Run', 'Role', 'Due by', 'Reported at', 'Status', 'Alerted at'];
var DIGEST_HEAD_ = ['Section', 'Row ID', 'Time', 'From', 'To', 'Kind', 'Subject', 'Brief', 'Due', 'Link'];
var DAYS_ = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// A row whose name holds * is made once per role in the Roles setting, with * replaced by the role.
var SETTINGS_ = [
  ['Roles', 'Assistant A, Assistant B, Assistant C', 'The assistants\' roles in card order, separated by commas. The Expected tab names these roles.'],
  ['* name', '*', "This assistant's name. The handoff tab is Out_ followed by this name."],
  ['* label', '*', "Shown in Team HQ beside this assistant's name."],
  ['Owner name', 'Owner', 'The name the assistants use in the To column for the owner.'],
  ['Dial', 'normal', 'One of the Dial options.'],
  ['Dial options', '', 'The words the Dial offers, separated by commas. The assistants read the chosen one from the Dial row. Empty: the Dial shows only its current value.'],
  ['Quiet hours start', '', 'No missed-run alerts are sent from this time (HH:MM). Leave both empty for no quiet hours.'],
  ['Quiet hours end', '', 'Alerts held overnight are sent at the first check after this time (HH:MM).'],
  ['Max alerts per day', '2', 'The watchdog sends at most this many pushes in one day.'],
  ['* room', '', "Link to this assistant's chat room."],
  ['* desk', '', "Link to this assistant's desk doc."],
  ['Task app', '', 'Link shown in Team HQ for opening the task list.'],
  ['Reports kept in Team HQ', '5', 'How many past reports each card can show.']
];

/* ---------- small helpers ---------- */

function s_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function tz_() { return Session.getScriptTimeZone() || SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Etc/UTC'; }
/** User text is stored as text: a leading space (trimmed again on read) stops = + - @ from ever being read as a formula. */
function safe_(v) { return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? ' ' + v : v; }
/** Constant-time string compare. */
function same_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function fmt_(d, pattern) { return Utilities.formatDate(d, tz_(), pattern); }
function nowText_() { return fmt_(new Date(), 'yyyy-MM-dd HH:mm'); }
/** A cell that Sheets turned into a date still reads as the text the script expects. */
function cellTime_(v) { return v instanceof Date ? fmt_(v, 'yyyy-MM-dd HH:mm') : s_(v); }
function cellHm_(v) { return v instanceof Date ? fmt_(v, 'HH:mm') : s_(v); }
/** The yyyy-MM-dd part of a time cell, or '' when the cell holds something else. */
function dayOf_(text) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s_(text)); return m ? m[0] : ''; }
function hmToMin_(hm) { var m = /^(\d{1,2}):(\d{2})$/.exec(s_(hm)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function addDays_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return d.toISOString().slice(0, 10);
}
function weekday_(ymd) { var p = ymd.split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay(); }
/** True when the Days cell (Daily, Mon-Fri, Sat, "Mon, Wed") covers the given weekday number. */
function runsOn_(days, wd) {
  var text = s_(days).toLowerCase();
  if (!text || text === 'daily' || text === 'every day') return true;
  return text.split(',').some(function (part) {
    var ends = part.trim().split('-').map(function (x) { return DAYS_.indexOf(x.trim().slice(0, 3)); });
    if (ends.some(function (i) { return i < 0; })) return false;
    if (ends.length === 1) return ends[0] === wd;
    var a = ends[0], b = ends[1];
    return a <= b ? (wd >= a && wd <= b) : (wd >= a || wd <= b);
  });
}

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Use Team HQ > Set up or repair.');
  return sh;
}
/** The data rows of a tab in one read; with a limit, only the newest rows. */
function rows_(name, width, limit) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var first = limit ? Math.max(2, last - limit + 1) : 2;
  return sh.getRange(first, 1, last - first + 1, width).getValues();
}
function settings_() {
  var map = {};
  rows_('Settings', 2).forEach(function (r) { if (s_(r[0])) map[s_(r[0])] = r[1] instanceof Date ? cellHm_(r[1]) : s_(r[1]); });
  return map;
}
function list_(v) { return s_(v).split(',').map(s_).filter(function (x) { return x; }); }
/** The roles from the Roles setting. A sheet made before that setting existed lists them as "<role> name" rows. */
function roles_(set) {
  var list = list_(set['Roles']);
  return list.length ? list : Object.keys(set).filter(function (k) { return / name$/.test(k) && k !== 'Owner name'; }).map(function (k) { return k.slice(0, -5); });
}
/** The Dial's words; without the Dial options setting, only the current value. */
function dials_(set) { var list = list_(set['Dial options']).map(function (x) { return x.toLowerCase(); }); return list.length ? list : list_(set['Dial']).map(function (x) { return x.toLowerCase(); }); }
function names_(set) {
  var out = {};
  roles_(set).forEach(function (role) { out[role] = set[role + ' name'] || role; });
  return out;
}
function tabOf_(role, set) { return 'Out_' + (set[role + ' name'] || role); }

/** Every Out row as an object, newest last, tagged with the tab's role ('' for the app's own tab). */
function outRows_(set) {
  var all = [];
  roles_(set).map(function (role) { return [role, tabOf_(role, set)]; }).concat([['', 'Out_HQ']]).forEach(function (pair) {
    rows_(pair[1], OUT_HEAD_.length, OUT_ROWS_).forEach(function (r) {
      if (!s_(r[0]) && !s_(r[2])) return;
      all.push({ role: pair[0], id: s_(r[0]), time: cellTime_(r[1]), kind: s_(r[2]).toLowerCase(), to: s_(r[3]), re: s_(r[4]),
        subject: s_(r[5]), brief: s_(r[6]), due: cellTime_(r[7]), needs: s_(r[8]).toUpperCase() === 'Y', state: s_(r[9]).toLowerCase(),
        trust: s_(r[10]).toLowerCase(), link: s_(r[11]) });
    });
  });
  return all;
}

/* ---------- setup and menu ---------- */

function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  // An existing header row is left as it is, so a renamed column survives a repair.
  var blank = sh.getRange(1, 1, 1, head.length).getValues()[0].every(function (v) { return s_(v) === ''; });
  if (blank) sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Every column is plain text, so an ID, a date or a note starting with = stays as typed.
  sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
  return sh;
}

/** Creates any missing tab or setting, makes the connection key, and starts the hourly check. Safe to run again; it never deletes data. Returns true when the hourly check is running. */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return setup_(); } finally { lock.releaseLock(); }
}
function setup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var st = ensureSheet_(ss, 'Settings', SET_HEAD_);
  var have = {}, last = st.getLastRow();
  if (last > 1) st.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[s_(r[0])] = true; });
  // Missing rows go at the end, so existing rows never move.
  var roles = roles_(settings_());
  if (!roles.length) roles = list_(SETTINGS_[0][1]); // a new sheet starts with the placeholder roles of the Roles row
  SETTINGS_.forEach(function (row) {
    var made = row[0].indexOf('*') < 0 ? [row] : roles.map(function (role) { return row.map(function (c) { return c.split('*').join(role); }); });
    made.forEach(function (r) {
      if (have[r[0]]) return;
      if (r[0] === 'Roles') r = [r[0], roles.join(', '), r[2]];
      last = Math.max(last, 1) + 1; st.getRange(last, 1, 1, 3).setValues([r]); have[r[0]] = true;
    });
  });
  var set = settings_();
  roles_(set).forEach(function (role) { ensureSheet_(ss, tabOf_(role, set), OUT_HEAD_); });
  ensureSheet_(ss, 'Out_HQ', OUT_HEAD_);
  ensureSheet_(ss, 'Expected', EXPECTED_HEAD_);
  var wd = ensureSheet_(ss, 'Watchdog', WATCH_HEAD_);
  wd.getRange(1, 9).setValue('Last check').setFontWeight('bold');
  wd.getRange(1, 9, 1, 2).setNumberFormat('@');
  ensureSheet_(ss, 'Digest', DIGEST_HEAD_);
  // A copied spreadsheet brings its script properties along; a copy must not answer to the original's key.
  var id = ss.getId();
  if (props.getProperty('SHEET_ID') && props.getProperty('SHEET_ID') !== id) { props.deleteProperty('KEY'); props.deleteProperty('NTFY_TOPIC'); }
  props.setProperty('SHEET_ID', id);
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, ''));
  // Runs that were due before the watchdog existed are not reported as missed.
  if (!props.getProperty('SINCE')) props.setProperty('SINCE', nowText_());
  // Exactly one hourly trigger: keep the first, remove any extra, add one only when none exists.
  var running = false;
  try {
    var mine = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'watchdog'; });
    mine.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
    if (!mine.length) ScriptApp.newTrigger('watchdog').timeBased().everyHours(1).create();
    running = true;
  } catch (err) { Logger.log('The hourly check was not started: ' + err); }
  Logger.log('Team HQ is set up. Version ' + VERSION_ + '.');
  return running;
}
/** Replaces the connection key. The old code stops working at once; paste the new one into the app. */
function rotateKey() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { PropertiesService.getScriptProperties().setProperty('KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')); } finally { lock.releaseLock(); }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Team HQ')
    .addItem('Set up or repair', 'setupFromMenu')
    .addItem('Show connection code', 'showCode')
    .addItem('Make a new connection code', 'rotateFromMenu')
    .addItem('Set the alert topic', 'setTopic')
    .addItem('Send a test alert', 'testAlert')
    .addItem('Run the check now', 'checkFromMenu')
    .addToUi();
}
function rotateFromMenu() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Make a new connection code?', 'The old code stops working. Every device must be given the new one.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  rotateKey();
  showCode();
}
function setupFromMenu() {
  var running = setup();
  dialog_('Team HQ is set up', '<p>' + (running ? 'The hourly check is running.' : '<b>The hourly check could not be started.</b> Run Set up or repair again, and allow the permissions if asked.') + ' Next:</p><ol>'
    + '<li>Team HQ &gt; Set the alert topic, so a missed run can reach your phone.</li>'
    + '<li>Deploy &gt; New deployment &gt; Web app. Execute as: Me. Who has access: Anyone. '
    + 'After pasting a newer Code.gs, use Deploy &gt; Manage deployments &gt; edit &gt; New version instead.</li>'
    + '<li>Team HQ &gt; Show connection code, then paste the code into the app.</li></ol>');
}
function showCode() {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) { dialog_('Run setup first', '<p>Use Team HQ &gt; Set up or repair.</p>'); return; }
  dialog_('Connection code', '<p>The code has two parts joined by <b>#</b>.</p>'
    + '<ol><li>In Extensions &gt; Apps Script choose Deploy &gt; Manage deployments and copy the <b>Web app URL</b>. It ends in /exec.</li>'
    + '<li>Add <b>#</b> and this key right after it:</li></ol>'
    + '<textarea readonly style="width:100%;height:44px" onfocus="this.select()">#' + key + '</textarea>'
    + '<p>Paste the result into the app: the status button, then Save.</p>');
}
function setTopic() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var res = ui.prompt('Alert topic', 'Paste the ntfy topic your phone is subscribed to. Treat it like a password: anyone who knows it can read the alerts. Leave empty to switch alerts off.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var topic = s_(res.getResponseText()).replace(/^https?:\/\/[^/]+\//, '');
  if (!topic) { props.deleteProperty('NTFY_TOPIC'); dialog_('Alerts are off', '<p>No topic is set.</p>'); return; }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(topic)) { dialog_('Topic not saved', '<p>Use 16 to 64 letters, digits, hyphens or underscores, with nothing guessable in it.</p>'); return; }
  props.setProperty('NTFY_TOPIC', topic);
  dialog_('Topic saved', '<p>Use Team HQ &gt; Send a test alert to check that the phone receives it.</p>');
}
function testAlert() {
  var sent = push_('Test alert from Team HQ. Alerts are working.');
  var why = PropertiesService.getScriptProperties().getProperty('ALERT_ERROR');
  dialog_(sent ? 'Test alert sent' : 'No alert sent', sent ? '<p>It should reach the phone within a minute.</p>' : '<p>' + (why ? 'The last attempt failed: ' + why : 'Set the alert topic first, then try again.') + '</p>');
}
function checkFromMenu() {
  var res = watchdog();
  if (res.busy) { dialog_('Sheet is busy', '<p>Another update is running. Try again in a minute.</p>'); return; }
  dialog_('Check finished', '<p>Runs checked: ' + res.checked + '. Late: ' + res.late + '. Alerts sent: ' + res.alerted + '.</p>');
}
function dialog_(title, html) {
  try { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<div style="font:14px Arial">' + html + '</div>').setWidth(460).setHeight(300), title); }
  catch (err) { Logger.log(title + ': ' + html.replace(/<[^>]+>/g, ' ')); }
}

/* ---------- watchdog ---------- */

/**
 * Sends one push through ntfy. The message never carries more than run names. Returns true when a push was sent.
 * A failure never throws: it is kept in the ALERT_ERROR property (shown on the board) and cleared by the next success.
 * The error text never includes the topic.
 */
function push_(message) {
  var props = PropertiesService.getScriptProperties();
  var topic = props.getProperty('NTFY_TOPIC');
  if (!topic) return false;
  var problem = '';
  try {
    var code = UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(topic), { method: 'post', payload: message, headers: { Title: 'Team HQ', Tags: 'warning' }, muteHttpExceptions: true }).getResponseCode();
    if (code >= 300) problem = 'ntfy answered ' + code;
  } catch (err) { problem = 'ntfy could not be reached'; }
  if (problem) { props.setProperty('ALERT_ERROR', nowText_() + ' ' + problem); return false; }
  props.deleteProperty('ALERT_ERROR');
  return true;
}

function expected_() {
  return rows_('Expected', EXPECTED_HEAD_.length).filter(function (r) { return s_(r[0]); }).map(function (r) {
    return { run: s_(r[0]), role: s_(r[1]), days: s_(r[2]), dueBy: cellHm_(r[3]), active: s_(r[4]).toUpperCase() === 'Y', scheduled: cellHm_(r[5]), notes: s_(r[6]) };
  });
}

/** The time of the first report a run posted on a given day, or ''. */
function reportedAt_(out, role, run, day) {
  var want = run.toLowerCase(), hit = '';
  out.forEach(function (o) {
    if (o.kind !== 'heartbeat' || o.role !== role || o.subject.toLowerCase() !== want || dayOf_(o.time) !== day) return;
    if (!hit || o.time < hit) hit = o.time;
  });
  return hit;
}

/**
 * Runs every hour. For yesterday and today it lists each active run that was due, records whether it reported,
 * and sends at most one push naming the runs that did not. Quiet hours and the daily cap come from Settings.
 */
function watchdog() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (err) { Logger.log('The check was skipped: the sheet was busy.'); return { busy: true, checked: 0, late: 0, alerted: 0 }; }
  var res = null, failure = null;
  try {
    try { res = check_(); } catch (err) { failure = err; Logger.log('The check failed: ' + err); }
    // The Digest is rewritten even when the check failed, so assistants never read a stale tab.
    try { writeDigest_(); } catch (err) { failure = failure || err; Logger.log('The digest failed: ' + err); }
  } finally {
    lock.releaseLock();
  }
  if (failure) throw failure; // shows in the Apps Script executions list
  return res;
}
function check_() {
  var props = PropertiesService.getScriptProperties();
  var set = settings_(), out = outRows_(set), exp = expected_();
  var now = nowText_(), today = now.slice(0, 10), nowMin = hmToMin_(now.slice(11));
  var since = props.getProperty('SINCE') || now;
  var sh = sheet_('Watchdog');
  var existing = rows_('Watchdog', WATCH_HEAD_.length);
  var index = {};
  existing.forEach(function (r, i) { index[cellTime_(r[0]).slice(0, 10) + '|' + s_(r[1]).toLowerCase()] = i; });
  // The cap counts pushes, not runs: one push can name several runs and they share one Alerted at time.
  var pushedToday = {};
  existing.forEach(function (r) { var t = cellTime_(r[6]); if (dayOf_(t) === today) pushedToday[t] = true; });
  var alertsToday = Object.keys(pushedToday).length;
  var newlyLate = [], checked = 0, late = 0;

  [addDays_(today, -1), today].forEach(function (day) {
    exp.forEach(function (e) {
      var dueMin = hmToMin_(e.dueBy);
      if (!e.active || dueMin === null || !runsOn_(e.days, weekday_(day))) return;
      var dueAt = day + ' ' + ('0' + Math.floor(dueMin / 60)).slice(-2) + ':' + ('0' + dueMin % 60).slice(-2);
      if (dueAt > now || dueAt < since) return;
      checked++;
      var at = reportedAt_(out, e.role, e.run, day);
      var key = day + '|' + e.run.toLowerCase();
      var i = index[key];
      var row = i === undefined ? [day, e.run, e.role, e.dueBy, '', '', ''] : existing[i].map(function (v, c) { return c === 0 ? day : (c === 3 ? cellHm_(v) : cellTime_(v)); });
      row[4] = at;
      row[5] = at ? (at > dueAt ? 'reported late' : 'ok') : 'late';
      if (!at) { late++; if (!row[6]) newlyLate.push({ key: key, run: e.run, day: day }); }
      if (i === undefined) { existing.push(row); index[key] = existing.length - 1; } else existing[i] = row;
    });
  });

  var alerted = 0;
  var qs = hmToMin_(set['Quiet hours start']), qe = hmToMin_(set['Quiet hours end']);
  var quiet = qs !== null && qe !== null && (qs > qe ? (nowMin >= qs || nowMin < qe) : (nowMin >= qs && nowMin < qe));
  var cap = s_(set['Max alerts per day']) === '' ? 2 : Number(set['Max alerts per day']); if (!(cap >= 0)) cap = 2; // blank means 2; only an explicit 0 turns alerts off
  if (newlyLate.length && !quiet && alertsToday < cap) {
    var names = newlyLate.map(function (x) { return x.run + (x.day === today ? '' : ' (yesterday)'); });
    var text = names.length === 1 ? names[0] + ' did not report.' : names.length + ' runs did not report: ' + names.join(', ') + '.';
    if (push_(text)) { newlyLate.forEach(function (x) { existing[index[x.key]][6] = now; }); alerted = 1; }
  }

  // Keep about two months of history.
  var cutoff = addDays_(today, -60);
  existing = existing.filter(function (r) { return cellTime_(r[0]).slice(0, 10) >= cutoff; });
  var maxRows = sh.getMaxRows();
  if (maxRows > 1) sh.getRange(2, 1, maxRows - 1, WATCH_HEAD_.length).clearContent();
  if (existing.length) {
    if (existing.length + 1 > maxRows) sh.insertRowsAfter(maxRows, existing.length + 1 - maxRows + 100);
    sh.getRange(2, 1, existing.length, WATCH_HEAD_.length).setNumberFormat('@').setValues(existing);
  }
  sh.getRange(1, 10).setValue(now);
  return { checked: checked, late: late, alerted: alerted };
}

/* ---------- the app's data feed ---------- */

function board_() {
  var props = PropertiesService.getScriptProperties();
  var set = settings_(), names = names_(set), out = outRows_(set), exp = expected_();
  var now = nowText_(), today = now.slice(0, 10);
  var keep = Math.max(1, Math.min(20, Number(set['Reports kept in Team HQ']) || 5));
  var owner = (set['Owner name'] || '').toLowerCase();
  var answered = {};
  out.forEach(function (o) { if (o.re) answered[o.re] = true; });
  // A handoff nobody answered stays in a queue for two weeks, then drops off the app; the row itself stays in the sheet.
  var recent = addDays_(today, -14);
  var nameToRole = {};
  var roles = roles_(set);
  roles.forEach(function (role) { nameToRole[names[role].toLowerCase()] = role; });
  function isOwner(to) { var t = to.toLowerCase(); return !nameToRole[t] && (t === owner || t !== ''); }

  var people = roles.map(function (role) {
    var mine = out.filter(function (o) { return o.role === role; });
    var reports = mine.filter(function (o) { return o.kind === 'report'; }).slice(-keep).reverse()
      .map(function (o) { return { id: o.id, time: o.time, subject: o.subject, brief: o.brief, needs: o.needs }; });
    var queue = out.filter(function (o) { return nameToRole[o.to.toLowerCase()] === role && !answered[o.id] && o.kind !== 'heartbeat' && o.kind !== 'report' && o.kind !== 'reply' && o.state !== 'withdrawn' && dayOf_(o.time) >= recent; })
      .map(function (o) { return { id: o.id, time: o.time, kind: o.kind, from: o.role ? names[o.role] : (set['Owner name'] || 'Owner'), subject: o.subject, brief: o.brief }; });
    var lastSeen = mine.length ? mine[mine.length - 1].time : '';
    return { role: role, name: names[role], label: set[role + ' label'] || role, room: set[role + ' room'] || '', desk: set[role + ' desk'] || '', reports: reports, queue: queue, lastSeen: lastSeen };
  });

  // A report marked as needing the owner is flagged on its card; only requests wait here, and for two weeks at most.
  var needs = out.filter(function (o) { return o.role && o.needs && !answered[o.id] && o.kind !== 'heartbeat' && o.kind !== 'report' && o.state !== 'withdrawn' && isOwner(o.to) && dayOf_(o.time) >= recent; })
    .map(function (o) { return { id: o.id, from: names[o.role], role: o.role, time: o.time, kind: o.kind, subject: o.subject, brief: o.brief, due: o.due, trust: o.trust, link: o.link }; });

  var wd = today ? weekday_(today) : 0;
  var runs = exp.map(function (e) {
    var at = reportedAt_(out, e.role, e.run, today);
    var onToday = runsOn_(e.days, wd);
    var dueMin = hmToMin_(e.dueBy);
    var dueAt = dueMin === null ? '' : today + ' ' + ('0' + Math.floor(dueMin / 60)).slice(-2) + ':' + ('0' + dueMin % 60).slice(-2);
    var status = !e.active ? 'off' : !onToday ? 'not today' : at ? 'ok' : (dueAt && dueAt <= now ? 'late' : 'due');
    return { run: e.run, role: e.role, name: names[e.role] || e.role, days: e.days, dueBy: e.dueBy, scheduled: e.scheduled, status: status, at: at };
  });

  var watchRows = rows_('Watchdog', WATCH_HEAD_.length);
  var yesterday = addDays_(today, -1);
  // A row stays "late" until the next hourly check, so a run that has reported since then is left out.
  var lateList = watchRows.filter(function (r) { var d = cellTime_(r[0]).slice(0, 10); return s_(r[5]) === 'late' && (d === today || d === yesterday) && !reportedAt_(out, s_(r[2]), s_(r[1]), d); })
    .map(function (r) { return { date: cellTime_(r[0]).slice(0, 10), run: s_(r[1]) }; });
  var lastCheck = '';
  try { lastCheck = cellTime_(sheet_('Watchdog').getRange(1, 10).getValue()); } catch (err) {}

  return { version: VERSION_, now: now, today: today, dial: (set['Dial'] || 'normal').toLowerCase(), dials: dials_(set), owner: set['Owner name'] || '', taskApp: set['Task app'] || '',
    people: people, needs: needs, runs: runs, watchdog: { lastCheck: lastCheck, late: lateList, hasTopic: !!props.getProperty('NTFY_TOPIC'), alertError: props.getProperty('ALERT_ERROR') || '' } };
}

/**
 * Rewrites the Digest tab: what is waiting on the owner, what is waiting for each assistant, each assistant's
 * latest report, and runs that did not report today or yesterday. The script is this tab's only writer.
 */
function writeDigest_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Digest') || ensureSheet_(ss, 'Digest', DIGEST_HEAD_);
  var b = board_(), owner = b.owner || 'Owner';
  var cap = function (t) { return t.slice(0, 1500); };
  var rows = [['updated', '', b.now, '', '', '', 'Rewritten every hour and after each tap in the app.', '', '', '']];
  b.needs.forEach(function (n) { rows.push(['needs owner', n.id, n.time, n.from, owner, n.kind, n.subject, cap(n.brief), n.due, n.link]); });
  b.people.forEach(function (p) {
    p.queue.forEach(function (q) { rows.push(['waiting', q.id, q.time, q.from, p.name, q.kind, q.subject, cap(q.brief), '', '']); });
    if (p.reports.length) rows.push(['latest report', p.reports[0].id, p.reports[0].time, p.name, owner, 'report', p.reports[0].subject, cap(p.reports[0].brief), '', '']);
  });
  b.watchdog.late.forEach(function (l) { rows.push(['late run', '', l.date, '', '', '', l.run, '', '', '']); });
  rows = rows.map(function (r) { return r.map(safe_); });
  var maxRows = sh.getMaxRows();
  if (maxRows > 1) sh.getRange(2, 1, maxRows - 1, DIGEST_HEAD_.length).clearContent();
  if (rows.length + 1 > maxRows) sh.insertRowsAfter(maxRows, rows.length + 1 - maxRows + 50);
  sh.getRange(2, 1, rows.length, DIGEST_HEAD_.length).setNumberFormat('@').setValues(rows);
  return b;
}
/** Rewrites the Digest and returns the board; a Digest problem must not undo an answer that was already saved. */
function refresh_() {
  try { return writeDigest_(); } catch (err) { Logger.log('The digest failed: ' + err); return board_(); }
}

function appendHq_(row) {
  var sh = sheet_('Out_HQ');
  var last = sh.getLastRow();
  if (last + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  sh.getRange(last + 1, 1, 1, OUT_HEAD_.length).setNumberFormat('@').setValues([row]);
}
function hqId_() { var d = new Date(); return 'H-' + fmt_(d, 'yyyyMMdd-HHmmss') + ('00' + d.getMilliseconds()).slice(-3); }

/** The owner answers a request from the app: one appended row that points at the request. */
function reply_(body) {
  var set = settings_(), names = names_(set), out = outRows_(set);
  var re = s_(body.re).slice(0, 100), state = s_(body.state).toLowerCase();
  if (state !== 'done' && state !== 'declined') throw new Error('Unknown answer');
  var target = out.filter(function (o) { return o.id === re && o.role; })[0];
  if (!target) throw new Error('That request is no longer on the board');
  if (out.some(function (o) { return o.re === re; })) return; // already answered; the first answer stands
  appendHq_([hqId_(), nowText_(), 'reply', names[target.role], re, safe_('Re: ' + target.subject.slice(0, 200)), safe_(s_(body.note).slice(0, 1000)), '', 'N', state, 'owner', '']);
}
/** The owner leaves a note for one assistant; it is read at that assistant's next live session. */
function note_(body) {
  var set = settings_(), names = names_(set);
  var role = roles_(set).filter(function (r) { return r === s_(body.role); })[0];
  var text = s_(body.text).slice(0, 2000);
  if (!role || !text) throw new Error('A note needs an assistant and some text');
  appendHq_([hqId_(), nowText_(), 'fyi', names[role], '', safe_(text.split('\n')[0].slice(0, 80)), safe_(text), '', 'N', 'new', 'owner', '']);
}
function dial_(body) {
  var value = s_(body.value).toLowerCase();
  if (dials_(settings_()).indexOf(value) < 0) throw new Error('Unknown dial value');
  var sh = sheet_('Settings'), rows = rows_('Settings', 1);
  for (var i = 0; i < rows.length; i++) if (s_(rows[i][0]) === 'Dial') { sh.getRange(i + 2, 2).setValue(value); return; }
  throw new Error('The Dial setting is missing. Use Team HQ > Set up or repair.');
}

function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out_({ ok: true, data: { app: 'Team HQ', version: VERSION_ } }); }
function doPost(e) {
  var body, raw = e && e.postData ? String(e.postData.contents || '') : '';
  if (raw.length > MAX_BODY_) return out_({ ok: false, error: 'Request too large' });
  try { body = JSON.parse(raw); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!body || typeof body !== 'object' || !key || !same_(body.key, key)) return out_({ ok: false, error: 'Wrong key', auth: true });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { return out_({ ok: false, error: 'The sheet is busy, try again' }); }
  try {
    switch (body.action) {
      case 'ping': return out_({ ok: true, data: { version: VERSION_ } });
      case 'board': return out_({ ok: true, data: board_() });
      case 'reply': reply_(body); return out_({ ok: true, data: refresh_() });
      case 'note': note_(body); return out_({ ok: true, data: refresh_() });
      case 'dial': dial_(body); return out_({ ok: true, data: board_() });
      default: return out_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}
