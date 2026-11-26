// Runs apps-script/Code.gs unchanged against in-memory stand-ins for Google's services.
const fs = require('fs'), vm = require('vm'), path = require('path');
function makeEnv(opts) {
  opts = opts || {};
  const state = { sheets: {}, props: {}, pushes: [], now: opts.now || new Date('2026-11-23T00:00:00Z'), tz: 'Etc/UTC', triggers: [] };
  function sheet(name) {
    const sh = state.sheets[name] || (state.sheets[name] = { name, rows: [], max: 50, frozen: 0 });
    function grow(r, c) { while (sh.rows.length < r) sh.rows.push([]); for (let i = 0; i < r; i++) while (sh.rows[i].length < c) sh.rows[i].push(''); }
    return {
      getLastRow() { let n = sh.rows.length; while (n > 0 && sh.rows[n - 1].every(v => v === '' || v == null)) n--; return n; },
      getMaxRows() { return Math.max(sh.max, sh.rows.length); },
      insertRowsAfter(_, n) { sh.max = this.getMaxRows() + n; },
      setFrozenRows(n) { sh.frozen = n; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        const api = {
          getValues() { grow(r + nr - 1, c + nc - 1); return sh.rows.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)); },
          getValue() { return api.getValues()[0][0]; },
          setValues(v) { grow(r + nr - 1, c + nc - 1); v.forEach((row, i) => row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = x; })); return api; },
          setValue(x) { return api.setValues([[x]]); },
          clearContent() { grow(Math.min(r + nr - 1, sh.rows.length), 1); for (let i = r - 1; i < Math.min(r - 1 + nr, sh.rows.length); i++) for (let j = c - 1; j < c - 1 + nc; j++) if (sh.rows[i][j] !== undefined) sh.rows[i][j] = ''; return api; },
          setFontWeight() { return api; }, setNumberFormat() { return api; },
        };
        return api;
      },
    };
  }
  const ss = {
    getSheetByName(n) { return state.sheets[n] ? sheet(n) : null; },
    insertSheet(n) { return sheet(n); },
    getSpreadsheetTimeZone() { return state.tz; },
    getId() { return 'SHEET1'; },
  };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(state.now.getTime()); } static now() { return state.now.getTime(); } }
  const pad = n => String(n).padStart(2, '0');
  const ctx = {
    Date: FakeDate, JSON, Math, Number, String, Object, Array, RegExp, encodeURIComponent, Error,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi() { throw new Error('no ui'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in state.props ? state.props[k] : null), setProperty: (k, v) => { state.props[k] = String(v); }, deleteProperty: k => { delete state.props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (state.lockBusy) throw new Error('Could not obtain lock'); }, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => state.tz },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      formatDate(d, tz, pattern) {
        const m = new RealDate(d.getTime()); // the stand-in sheet's time zone is UTC
        const parts = { yyyy: m.getUTCFullYear(), MM: pad(m.getUTCMonth() + 1), dd: pad(m.getUTCDate()), HH: pad(m.getUTCHours()), mm: pad(m.getUTCMinutes()), ss: pad(m.getUTCSeconds()) };
        return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, t => parts[t]);
      },
    },
    UrlFetchApp: { fetch(url, o) { if (opts.pushThrows) throw new Error('DNS error: ' + url); state.pushes.push({ url, text: o.payload }); return { getResponseCode: () => (opts.pushFails ? 500 : 200) }; } },
    ScriptApp: { getProjectTriggers: () => state.triggers.slice(), deleteTrigger(t) { state.triggers = state.triggers.filter(x => x !== t); }, newTrigger: fn => ({ timeBased: () => ({ everyHours: () => ({ create() { state.triggers.push({ getHandlerFunction: () => fn }); } }) }) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  const api = {
    state, ctx,
    setNow(iso) { state.now = new RealDate(iso); },
    seed(name, rows) { const sh = sheet(name); rows.forEach((r, i) => sh.getRange(i + 1, 1, 1, r.length).setValues([r])); },
    append(name, row) { const sh = sheet(name); sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]); },
    rows(name) { return (state.sheets[name] || { rows: [] }).rows.filter(r => r.some(v => v !== '' && v != null)); },
    post(body) { return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ key: state.props.KEY }, body)) } }).text); },
  };
  return api;
}
module.exports = { makeEnv };
