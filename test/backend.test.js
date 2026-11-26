const assert = require('assert');
const { makeEnv } = require('./mock');
const HEAD = ['Row ID', 'Time', 'Kind', 'To', 'Re', 'Subject', 'Brief', 'Due', 'Needs owner', 'State', 'Source trust', 'Link'];
const SETTINGS = [['Setting', 'Value', 'What it does'], ['Roles', 'A, B, C', ''], ['A name', 'Assistant A', ''], ['B name', 'Assistant B', ''], ['C name', 'Assistant C', ''], ['Owner name', 'Owner', ''],
  ['Dial', 'mode 2', ''], ['Dial options', 'mode 1, mode 2, mode 3', ''], ['Quiet hours start', '20:00', ''], ['Quiet hours end', '08:00', ''], ['Max alerts per day', '2', '']];
const OUT_A = 'Out_Assistant A', OUT_B = 'Out_Assistant B', OUT_C = 'Out_Assistant C';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }
function fresh(nowIso, opts) {
  // The stand-in sheet runs on UTC: 2026-11-23 is a Monday, and the default start is 07:00.
  const env = makeEnv(Object.assign({ now: new Date(nowIso || '2026-11-23T07:00:00Z') }, opts));
  env.seed('Settings', SETTINGS);
  env.seed('Expected', [['Run', 'Role', 'Days', 'Due by', 'Active', 'Scheduled', 'Notes'],
    ['Run 1', 'A', 'Mon-Fri', '09:00', 'Y', '08:30', ''],
    ['Run 2', 'A', 'Sat', '10:00', 'Y', '09:30', ''],
    ['Run 3', 'C', 'Daily', '21:00', 'Y', '', ''],
    ['Run 4', 'C', 'Daily', '04:00', 'N', '', '']]);
  env.ctx.setup();
  env.state.props.NTFY_TOPIC = 'abcdefghijklmnop1234';
  return env;
}

test('setup makes the tabs, a key, the timer, and leaves existing headers alone', () => {
  const env = fresh();
  [OUT_A, OUT_B, OUT_C, 'Out_HQ', 'Watchdog', 'Digest'].forEach(n => assert.ok(env.state.sheets[n], n));
  assert.strictEqual(env.rows(OUT_A)[0][8], 'Needs owner');
  assert.ok(env.state.props.KEY && env.state.props.SINCE);
  assert.strictEqual(env.state.triggers.length, 1);
  env.state.sheets[OUT_A].rows[0][8] = 'Header A';
  env.ctx.setup();
  assert.strictEqual(env.rows(OUT_A)[0][8], 'Header A');
  assert.strictEqual(env.state.triggers.length, 1);
});

test('day matching', () => {
  const { ctx } = fresh();
  assert.ok(ctx.runsOn_('Daily', 0)); assert.ok(ctx.runsOn_('Mon-Fri', 1)); assert.ok(!ctx.runsOn_('Mon-Fri', 6));
  assert.ok(ctx.runsOn_('Sat', 6)); assert.ok(ctx.runsOn_('mon, wed', 3)); assert.ok(ctx.runsOn_('Fri-Mon', 0)); assert.ok(!ctx.runsOn_('Fri-Mon', 3));
});

test('a run that reported is ok; nothing is checked before it is due', () => {
  const env = fresh(); // 07:00 Monday, before 09:00
  let r = env.ctx.watchdog();
  assert.deepStrictEqual([r.checked, r.late, r.alerted], [0, 0, 0]);
  env.append(OUT_A, ['A-1', '2026-11-23 08:31', 'heartbeat', 'Owner', '', 'run 1', '', '', 'N', 'done', 'team', '']);
  env.setNow('2026-11-23T09:30:00Z');
  r = env.ctx.watchdog();
  assert.deepStrictEqual([r.checked, r.late, r.alerted], [1, 0, 0]);
  assert.strictEqual(env.rows('Watchdog')[1][5], 'ok');
  assert.strictEqual(env.state.pushes.length, 0);
  assert.strictEqual(env.state.sheets.Watchdog.rows[0][9], '2026-11-23 09:30');
});

test('a missed run alerts once, names only the run, and flips when it reports late', () => {
  const env = fresh();
  env.setNow('2026-11-23T09:30:00Z'); // Run 1 missing
  let r = env.ctx.watchdog();
  assert.deepStrictEqual([r.late, r.alerted], [1, 1]);
  assert.strictEqual(env.state.pushes[0].text, 'Run 1 did not report.');
  assert.ok(env.state.pushes[0].url.endsWith('/abcdefghijklmnop1234'));
  env.setNow('2026-11-23T10:30:00Z');
  r = env.ctx.watchdog();
  assert.strictEqual(env.state.pushes.length, 1, 'no second alert for the same run');
  env.append(OUT_A, ['A-2', '2026-11-23 10:50', 'heartbeat', 'Owner', '', 'Run 1', '', '', 'N', 'done', 'team', '']);
  env.setNow('2026-11-23T11:30:00Z');
  env.ctx.watchdog();
  const row = env.rows('Watchdog').find(x => x[1] === 'Run 1');
  assert.strictEqual(row[5], 'reported late');
  assert.strictEqual(row[6], '2026-11-23 09:30');
});

test('quiet hours hold an alert until morning, and yesterday is named', () => {
  const env = fresh();
  env.append(OUT_A, ['A-1', '2026-11-23 08:31', 'heartbeat', 'Owner', '', 'Run 1', '', '', 'N', 'done', 'team', '']);
  env.setNow('2026-11-23T21:10:00Z'); // 21:10 Monday, Run 3 missing, quiet
  let r = env.ctx.watchdog();
  assert.deepStrictEqual([r.late, r.alerted], [1, 0]);
  env.setNow('2026-11-24T08:10:00Z'); // 08:10 Tuesday
  r = env.ctx.watchdog();
  assert.strictEqual(r.alerted, 1);
  assert.strictEqual(env.state.pushes[0].text, 'Run 3 (yesterday) did not report.');
});

test('the daily cap and a missing topic both stop pushes without losing the record', () => {
  const env = fresh();
  env.state.sheets.Settings.rows.forEach(r => { if (r[0] === 'Max alerts per day') r[1] = '0'; });
  env.setNow('2026-11-23T09:30:00Z');
  let r = env.ctx.watchdog();
  assert.deepStrictEqual([r.late, r.alerted], [1, 0]);
  const env2 = fresh(); delete env2.state.props.NTFY_TOPIC;
  env2.setNow('2026-11-23T09:30:00Z');
  r = env2.ctx.watchdog();
  assert.deepStrictEqual([r.late, r.alerted], [1, 0]);
  assert.strictEqual(env2.rows('Watchdog')[1][5], 'late');
});

test('a run that reported since the last check is not listed late, and a blank alert cap means 2', () => {
  const env = fresh();
  env.setNow('2026-11-23T09:30:00Z'); // Run 1 missing
  env.ctx.watchdog();
  assert.strictEqual(env.post({ action: 'board' }).data.watchdog.late.length, 1);
  env.append(OUT_A, ['A-3', '2026-11-23 09:45', 'heartbeat', 'Owner', '', 'Run 1', '', '', 'N', 'done', 'team', '']);
  assert.strictEqual(env.post({ action: 'board' }).data.watchdog.late.length, 0, 'the board drops it before the next check');
  env.post({ action: 'note', role: 'C', text: 'Note 1' }); // a note rewrites the digest
  assert.ok(!env.rows('Digest').some(x => x[0] === 'late run'), 'the digest drops it too');
  const blank = fresh();
  blank.state.sheets.Settings.rows.forEach(r => { if (r[0] === 'Max alerts per day') r[1] = ''; });
  blank.setNow('2026-11-23T09:30:00Z');
  assert.strictEqual(blank.ctx.watchdog().alerted, 1, 'blank cap still alerts');
});

test('runs due before the watchdog was installed are not reported', () => {
  const env = fresh('2026-11-23T09:30:00Z'); // installed 09:30 Monday, after the 09:00 deadline
  const r = env.ctx.watchdog();
  assert.deepStrictEqual([r.checked, r.late], [0, 0]);
});

test('a wrong key is refused', () => {
  const env = fresh();
  const res = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ key: 'nope', action: 'board' }) } }).text);
  assert.strictEqual(res.ok, false); assert.strictEqual(res.auth, true);
});

test('the board shows reports, what needs the owner, queues and run status', () => {
  const env = fresh();
  env.append(OUT_A, ['A-1', '2026-11-23 08:31', 'report', 'Owner', '', 'Report 1', 'Text 1', '', 'N', 'new', 'team', '']);
  env.append(OUT_A, ['A-1-2', '2026-11-23 08:31', 'heartbeat', 'Owner', '', 'Run 1', '', '', 'N', 'done', 'team', '']);
  env.append(OUT_C, ['C-1', '2026-11-23 08:40', 'request', 'Assistant A', '', 'Request 1', 'Text of request 1', '', 'N', 'new', 'team', '']);
  env.append(OUT_B, ['B-1', '2026-11-23 08:50', 'request', 'Owner', '', 'Request 2', 'Text of request 2', '2026-11-24', 'Y', 'new', 'team', '']);
  env.setNow('2026-11-23T09:30:00Z');
  const b = env.post({ action: 'board' }).data;
  assert.strictEqual(b.people[0].name, 'Assistant A');
  assert.strictEqual(b.people[0].reports[0].subject, 'Report 1');
  assert.strictEqual(b.people[0].queue.length, 1); assert.strictEqual(b.people[0].queue[0].from, 'Assistant C');
  assert.strictEqual(b.needs.length, 1); assert.strictEqual(b.needs[0].from, 'Assistant B');
  // A report marked Y is flagged on its card and never becomes a standing request; an old request drops off after two weeks.
  env.append(OUT_A, ['A-2', '2026-11-23 09:10', 'report', 'Owner', '', 'Report 2', 'Text 2', '', 'Y', 'new', 'team', '']);
  env.append(OUT_B, ['B-0', '2026-11-01 08:50', 'request', 'Owner', '', 'Request 0', '', '', 'Y', 'new', 'team', '']);
  const b2 = env.post({ action: 'board' }).data;
  assert.deepStrictEqual(b2.needs.map(n => n.id), ['B-1']); assert.strictEqual(b2.people[0].reports[0].needs, true);
  const status = Object.fromEntries(b.runs.map(r => [r.run, r.status]));
  assert.deepStrictEqual(status, { 'Run 1': 'ok', 'Run 2': 'not today', 'Run 3': 'due', 'Run 4': 'off' });
});

test('roles, labels and the dial words come from the Settings tab', () => {
  const env = fresh();
  const set = (k, v) => env.state.sheets.Settings.rows.forEach(r => { if (r[0] === k) r[1] = v; });
  let b = env.post({ action: 'board' }).data;
  assert.deepStrictEqual(b.people.map(p => [p.role, p.label]), [['A', 'A'], ['B', 'B'], ['C', 'C']], 'a label defaults to its role');
  assert.deepStrictEqual(b.dials, ['mode 1', 'mode 2', 'mode 3']);
  set('B label', 'Label B'); set('Roles', 'B, A');
  b = env.post({ action: 'board' }).data;
  assert.deepStrictEqual(b.people.map(p => [p.role, p.label]), [['B', 'Label B'], ['A', 'A']], 'cards follow the Roles order');
  assert.strictEqual(env.post({ action: 'note', role: 'C', text: 'Note 1' }).ok, false, 'a role left out of Roles takes no note');
});

test('a sheet made before the Roles row keeps its roles, and setup adds only new rows, at the end', () => {
  const env = makeEnv({ now: new Date('2026-11-23T07:00:00Z') });
  const old = [['Setting', 'Value', 'What it does'], ['A name', 'Assistant A', ''], ['B name', 'Assistant B', ''], ['C name', 'Assistant C', ''], ['Owner name', 'Owner', ''],
    ['Dial', 'mode 2', ''], ['Quiet hours start', '20:00', ''], ['Quiet hours end', '08:00', ''], ['Max alerts per day', '2', '']];
  env.seed('Settings', old);
  assert.deepStrictEqual(env.ctx.roles_(env.ctx.settings_()), ['A', 'B', 'C']);
  env.ctx.setup();
  const rows = env.rows('Settings');
  assert.deepStrictEqual(rows.slice(0, old.length), old, 'existing rows stay where they were');
  const val = Object.fromEntries(rows.map(r => [r[0], r[1]]));
  assert.deepStrictEqual([val['Roles'], val['A label'], val['Dial options']], ['A, B, C', 'A', '']);
  assert.deepStrictEqual(Object.keys(env.state.sheets).filter(n => n.startsWith('Out_')).sort(), [OUT_A, OUT_B, OUT_C, 'Out_HQ']);
  assert.deepStrictEqual(env.post({ action: 'board' }).data.dials, ['mode 2'], 'without Dial options the Dial offers only its value');
  assert.strictEqual(env.post({ action: 'dial', value: 'mode 3' }).ok, false);
});

test('a reply answers a request once; a note and the dial are recorded', () => {
  const env = fresh();
  env.append(OUT_B, ['B-1', '2026-11-23 08:50', 'request', 'Owner', '', 'Request 1', 'Text of request 1', '', 'Y', 'new', 'team', '']);
  let b = env.post({ action: 'reply', re: 'B-1', state: 'done', note: 'Note 1' }).data;
  assert.strictEqual(b.needs.length, 0);
  env.post({ action: 'reply', re: 'B-1', state: 'declined' });
  const hq = env.rows('Out_HQ');
  assert.strictEqual(hq.length, 2, 'the first answer stands');
  assert.deepStrictEqual([hq[1][2], hq[1][3], hq[1][4], hq[1][9], hq[1][10]], ['reply', 'Assistant B', 'B-1', 'done', 'owner']);
  b = env.post({ action: 'note', role: 'C', text: 'Note 2\nLine 2' }).data;
  assert.strictEqual(b.people[2].queue[0].subject, 'Note 2');
  b = env.post({ action: 'dial', value: 'mode 3' }).data;
  assert.strictEqual(b.dial, 'mode 3');
  assert.strictEqual(env.post({ action: 'dial', value: 'mode 9' }).ok, false);
  assert.strictEqual(env.post({ action: 'reply', re: 'missing', state: 'done' }).ok, false);
});

test('the digest holds only what is open, and is rewritten after a check and after a reply', () => {
  const env = fresh();
  env.append(OUT_A, ['A-0', '2026-11-20 08:31', 'report', 'Owner', '', 'Report 0', 'Text 0', '', 'N', 'new', 'team', '']);
  env.append(OUT_A, ['A-1', '2026-11-23 08:31', 'report', 'Owner', '', 'Report 1', 'Text 1', '', 'N', 'new', 'team', '']);
  env.append(OUT_A, ['A-1-2', '2026-11-23 08:31', 'heartbeat', 'Owner', '', 'Run 1', '', '', 'N', 'done', 'team', '']);
  env.append(OUT_C, ['C-1', '2026-11-23 08:40', 'request', 'Assistant A', '', 'Request 1', 'Text of request 1', '', 'N', 'new', 'team', '']);
  env.append(OUT_B, ['B-1', '2026-11-23 08:50', 'request', 'Owner', '', 'Request 2', 'Text of request 2', '2026-11-24', 'Y', 'new', 'team', '']);
  env.setNow('2026-11-24T00:00:00Z'); // 00:00 Tuesday: Run 3 never reported on Monday
  env.ctx.watchdog();
  let d = env.rows('Digest').slice(1);
  assert.deepStrictEqual(d.map(r => r[0]), ['updated', 'needs owner', 'waiting', 'latest report', 'late run']);
  assert.strictEqual(d[0][2], '2026-11-24 00:00');
  assert.deepStrictEqual([d[1][1], d[1][3], d[1][4]], ['B-1', 'Assistant B', 'Owner']);
  assert.deepStrictEqual([d[2][1], d[2][3], d[2][4]], ['C-1', 'Assistant C', 'Assistant A']);
  assert.deepStrictEqual([d[3][1], d[3][7]], ['A-1', 'Text 1']);
  assert.deepStrictEqual([d[4][2], d[4][6]], ['2026-11-23', 'Run 3']);
  env.post({ action: 'reply', re: 'B-1', state: 'done' });
  d = env.rows('Digest').slice(1);
  assert.deepStrictEqual(d.map(r => r[0]), ['updated', 'waiting', 'latest report', 'late run'], 'the answered request leaves the digest');
});

test('setup leaves exactly one hourly trigger, even after duplicates', () => {
  const env = fresh();
  env.state.triggers.push({ getHandlerFunction: () => 'watchdog' }, { getHandlerFunction: () => 'watchdog' }, { getHandlerFunction: () => 'other' });
  env.ctx.setup();
  assert.strictEqual(env.state.triggers.filter(t => t.getHandlerFunction() === 'watchdog').length, 1);
  assert.strictEqual(env.state.triggers.length, 2, 'other triggers are left alone');
});

test('a new connection code replaces the old one', () => {
  const env = fresh();
  const old = env.state.props.KEY;
  env.ctx.rotateKey();
  assert.notStrictEqual(env.state.props.KEY, old);
  const res = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ key: old, action: 'board' }) } }).text);
  assert.strictEqual(res.auth, true);
  assert.strictEqual(env.post({ action: 'ping' }).ok, true);
  assert.strictEqual(JSON.parse(env.ctx.doPost({ postData: { contents: 'null' } }).text).auth, true);
});

test('a failed or unreachable alert is recorded, and the check still finishes', () => {
  const env = fresh(undefined, { pushThrows: true });
  env.setNow('2026-11-23T09:30:00Z');
  const r = env.ctx.watchdog();
  assert.deepStrictEqual([r.late, r.alerted], [1, 0]);
  assert.strictEqual(env.rows('Watchdog')[1][5], 'late');
  assert.strictEqual(env.rows('Watchdog')[1][6], '', 'not marked alerted, so the next check tries again');
  assert.strictEqual(env.state.sheets.Watchdog.rows[0][9], '2026-11-23 09:30');
  assert.ok(env.rows('Digest').some(x => x[0] === 'late run'));
  const w = env.post({ action: 'board' }).data.watchdog;
  assert.ok(/could not be reached/.test(w.alertError) && !/abcdefghijklmnop1234/.test(w.alertError));
});

test('a busy sheet skips the hourly check instead of failing', () => {
  const env = fresh();
  env.state.lockBusy = true;
  assert.strictEqual(env.ctx.watchdog().busy, true);
  assert.strictEqual(env.post({ action: 'ping' }).ok, false);
});

test('the daily cap counts pushes, not the runs named in them', () => {
  const env = fresh();
  env.append('Expected', ['Run 5', 'B', 'Daily', '09:10', 'Y', '', '']);
  env.append('Expected', ['Run 6', 'B', 'Daily', '10:00', 'Y', '', '']);
  env.setNow('2026-11-23T09:30:00Z'); // two runs missing, one push
  env.ctx.watchdog();
  assert.strictEqual(env.state.pushes.length, 1);
  env.setNow('2026-11-23T10:30:00Z'); // a third run missing, a second push is allowed
  env.ctx.watchdog();
  assert.strictEqual(env.state.pushes.length, 2);
});

test('owner text that looks like a formula is stored as text, and only recent rows are read', () => {
  const env = fresh();
  env.append(OUT_B, ['B-1', '2026-11-23 08:50', 'request', 'Owner', '', '=1+1', '@SUM(A1)', '', 'Y', 'new', 'team', '']);
  env.post({ action: 'note', role: 'B', text: '=HYPERLINK("http://x","y")' });
  env.post({ action: 'reply', re: 'B-1', state: 'done', note: '-2+3' });
  env.rows('Out_HQ').slice(1).forEach(r => { assert.ok(!/^[=+\-@]/.test(r[5]) && !/^[=+\-@]/.test(r[6])); });
  assert.ok(env.rows('Digest').slice(1).every(r => r.every(v => !/^[=+\-@]/.test(String(v)))));
  env.ctx.OUT_ROWS_ = 1;
  env.append(OUT_B, ['B-2', '2026-11-23 09:00', 'request', 'Owner', '', 'Request 2', '', '', 'Y', 'new', 'team', '']);
  assert.deepStrictEqual(env.post({ action: 'board' }).data.needs.map(n => n.id), ['B-2']);
});

console.log(passed + ' checks passed');
