// Opens the app in Chrome with its built-in sample data and checks the main flows. Needs Playwright and Chrome.
const { chromium } = require('playwright');
const path = require('path'), http = require('http'), fs = require('fs'), assert = require('assert');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
// Hash of the shared block: from the first marker's opening /* to the end marker's closing */, nothing after.
const sharedHash = (html) => { const m = '/* end shared look */', a = html.indexOf('/* Shared look 1'), b = html.indexOf(m) + m.length; return require('crypto').createHash('sha256').update(html.slice(a, b)).digest('hex').slice(0, 16); };
(async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.strictEqual(sharedHash(html), '33c0af2999cecd8b', 'shared look block');
  // Every font the page names is in the offline file list, and every file in that list exists.
  const shell0 = /const SHELL = (\[[^;]*\]);/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8')), listed = shell0 ? eval(shell0[1]) : [];
  const fonts = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map(m => './' + m[1]);
  assert.ok(fonts.length === 5 && fonts.every(f => listed.includes(f)), 'every font in the page is in the offline file list: ' + fonts.filter(f => !listed.includes(f)));
  assert.deepStrictEqual(listed.filter(f => !fs.existsSync(path.join(root, f.replace(/\/$/, '/index.html')))), [], 'every file in the offline file list exists');
  // Stand-ins for the two apps the shell frames, served from memory: one text field each, noting the resume signals and keys they get and whether the field lost focus while its tab was still shown.
  const standIn = name => '<!doctype html><title>' + name + '</title><body><input id="f"><script>window.seen = 0; window.keys = ""; document.addEventListener("visibilitychange", () => window.seen++); document.addEventListener("keydown", e => window.keys += e.key); f.addEventListener("blur", () => window.shownAtBlur = frameElement.classList.contains("on"));</scr' + 'ipt>';
  const server = http.createServer((req, res) => {
    const app = /^\/(Docket|ledger)\/$/.exec(req.url);
    if (app) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(standIn(app[1])); return; }
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0].replace(/\/$/, '/index.html')));
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  }).listen(0);
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ executablePath: '/usr/bin/google-chrome' }));
  const errors = [];
  for (const v of [{ name: 'phone-light', w: 390, h: 844, scheme: 'light' }, { name: 'phone-dark', w: 390, h: 844, scheme: 'dark' }, { name: 'desk-light', w: 1280, h: 800, scheme: 'light' }, { name: 'desk-dark', w: 1280, h: 800, scheme: 'dark' }]) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h }, colorScheme: v.scheme, deviceScaleFactor: 2 });
    page.on('pageerror', e => errors.push(v.name + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(v.name + ': ' + m.text()); });
    await page.goto(base + '#demo');
    await page.waitForSelector('.sec');
    const shot = n => page.screenshot({ path: path.join(__dirname, 'shots', v.name + n + '.png'), fullPage: true });
    assert.strictEqual(await page.locator('section[aria-labelledby^="h-"]:has(.acts)').count(), 3, 'three assistant cards');
    assert.ok((await page.locator('.banner.danger').innerText()).includes('Run 2 did not report'));
    // Runs that are not today stay out of the list and are only counted.
    const runs = await page.locator('#h-runs').locator('xpath=..').innerText();
    assert.ok(!runs.includes('Run 4') && runs.includes('1 not scheduled today'), 'quiet runs are counted, not listed');
    assert.ok(runs.includes('Run 3') && runs.includes('reported'), 'due and reported runs are listed');
    // Earlier reports sit behind a disclosure.
    assert.ok(!(await page.locator('body').innerText()).includes('Text of report 0.'));
    await shot('');
    await page.locator('[data-id="more:A"]').click();
    assert.strictEqual(await page.locator('[data-id="more:A"]').getAttribute('aria-expanded'), 'true');
    assert.ok((await page.locator('body').innerText()).includes('Report 0'));
    await page.locator('[data-id="more:A"]').click();
    // Approve the waiting request with a note.
    await page.locator('[data-id="need:B-2"]').click();
    await page.locator('[data-note="B-2"]').fill('Note 1');
    // A sync while the note is being typed, and the redraw that follows, must keep the typed text.
    await page.locator('[data-note="B-2"]').focus();
    await page.evaluate(() => sync());
    await page.waitForFunction(() => !S.busy);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('[data-note="B-2"]').inputValue(), 'Note 1', 'typed note survives a sync');
    await page.locator('[data-a="reply"][data-state="done"]').focus();
    await shot('-open');
    await page.locator('[data-a="reply"][data-state="done"]').click();
    await page.waitForSelector('text=No decision is waiting on you.');
    // Leave a note for the third assistant; it shows up in that card's queue.
    await page.locator('[data-a="note"][data-role="C"]').click();
    assert.strictEqual(await page.locator('.sheet').getAttribute('aria-modal'), 'true');
    assert.ok(await page.evaluate(() => document.querySelector('main').inert), 'page behind the dialog is inert');
    assert.ok(await page.evaluate(() => document.querySelector('.strip').inert), 'the strip is inert behind the dialog too');
    await page.locator('#noteText').fill('Note 2\nLine 2');
    await shot('-note');
    await page.locator('[data-a="sendNote"]').click();
    await page.waitForSelector('text=1 waiting for Assistant C');
    assert.ok(await page.evaluate(() => document.activeElement.dataset.role === 'C'), 'focus returns to the control that opened the dialog');
    // The dial.
    await page.locator('[data-a="dial"][data-v="mode 3"]').click();
    await page.waitForSelector('[data-v="mode 3"][aria-pressed="true"]');
    // Nothing overflows sideways.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, 'no sideways scroll (' + over + ')');
    // Every control is at least 44 px on its shorter side on a phone, 40 px with a mouse.
    const small = await page.evaluate(min => [...document.querySelectorAll('button,a.btn,a.tbtn')].map(b => [b, Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)]).filter(x => x[1] < min).map(x => (x[0].className || x[0].textContent) + ':' + x[1]), v.w < 900 ? 44 : 40);
    assert.deepStrictEqual(small, [], 'control sizes');
    // Colour pairs from the tokens: text needs 4.5:1, borders and focus rings 3:1.
    const ratios = await page.evaluate(() => {
      const css = n => { if (!getComputedStyle(document.documentElement).getPropertyValue('--' + n).trim()) throw new Error('empty token --' + n); const e = document.createElement('i'); e.style.color = 'var(--' + n + ')'; document.body.appendChild(e); const c = getComputedStyle(e).color.match(/[\d.]+/g).map(Number); e.remove(); return c; };
      const lum = c => { const [r, g, b] = c.slice(0, 3).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
      const ratio = (a, b) => { const x = lum(css(a)), y = lum(css(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const text = [['text', 'bg'], ['muted', 'bg'], ['muted', 'raise'], ['attn', 'bg'], ['danger', 'bg'], ['on-accent', 'accent-fill'], ['text', 'field'], ['text', 'raise'], ['accent', 'bg'], ['accent', 'field'], ['on-sel', 'sel'], ['ink', 'well'], ['ok', 'bg'], ['on-inv', 'danger']];
      const ui = [['edge', 'bg'], ['edge', 'field'], ['accent-fill', 'bg'], ['text', 'bg'], ['sel', 'well']];
      return { text: text.map(p => [p.join('/'), ratio(...p)]), ui: ui.map(p => [p.join('/'), ratio(...p)]) };
    });
    ratios.text.forEach(r => assert.ok(r[1] >= 4.5, v.name + ' text contrast ' + r));
    ratios.ui.forEach(r => assert.ok(r[1] >= 3, v.name + ' control contrast ' + r));
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.body).boxSizing), 'border-box', v.name + ' the rule after the shared block still applies');
    console.log(v.name, 'text', ratios.text.map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '), '| ui', ratios.ui.map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '));
    await shot('-end');
    // A tab's frame fills the window under the strip.
    await page.locator('.strip [data-v="docket"]').click();
    const box = await page.evaluate(() => { const r = document.querySelector('iframe.on').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, document.querySelector('.strip').getBoundingClientRect().bottom]; });
    const under = v.w < 900 ? 45 : 41;
    assert.deepStrictEqual(box, [0, under, v.w, v.h, under], v.name + ' frame fills the window under the strip');
    await page.close();
  }
  // The shell on a phone with touch: the strip and a frame without and with a notch, then the tabs.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const shell = await ctx.newPage(), cdp = await ctx.newCDPSession(shell);
  shell.on('pageerror', e => errors.push('shell: ' + e.message));
  await shell.goto(base + '#demo'); await shell.waitForSelector('.sec');
  const edges = () => shell.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(), f = document.querySelector('iframe.on'); return { strip: r('.strip').bottom, head: r('header.top').top, headEnd: r('header.top').bottom, main: r('main').top, frame: f && [r('iframe.on').top, r('iframe.on').bottom] }; });
  const tabTo = v => shell.locator('.strip [data-v="' + v + '"]').click();
  const inTab = (name, fn) => shell.frames().find(f => new URL(f.url()).pathname === '/' + name + '/').evaluate(fn);
  const look = () => ({ text: document.querySelector('#f').value, body: document.activeElement === document.body, keys: window.keys, seen: window.seen, width: frameElement.getBoundingClientRect().width });
  assert.strictEqual(await shell.locator('iframe').count(), 0, 'no frame before a tab is opened');
  await tabTo('docket');
  assert.strictEqual(await shell.locator('iframe').count(), 1, 'the frame is made when its tab is first opened');
  const state = () => shell.evaluate(() => ({ on: [...document.querySelectorAll('iframe.on')].map(f => f.title).join(), current: [...document.querySelectorAll('.strip [aria-current=page]')].map(b => b.dataset.v).join(), hq: getComputedStyle(document.querySelector('.app')).visibility, plain: [...document.querySelectorAll('iframe')].every(f => !f.hasAttribute('sandbox') && !f.hasAttribute('allow')) }));
  assert.deepStrictEqual(await state(), { on: 'Docket', current: 'docket', hq: 'hidden', plain: true }, 'on the Docket tab only its frame shows, its tab is marked, HQ is hidden, and the frame has no sandbox or allow attribute');
  let e = await edges();
  assert.deepStrictEqual([e.strip, e.frame], [45, [45, 844]], 'without a notch the strip ends at 45 px and the frame runs from there to the bottom');
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34 } });
  e = await edges();
  assert.deepStrictEqual([e.strip, e.frame], [92, [92, 810]], 'with a notch the strip ends at 92 px and the frame runs from there to 810 px');
  await shell.frameLocator('iframe[title="Docket"]').locator('#f').click();
  await shell.keyboard.type('abc');
  // Chosen as a finger chooses it on a phone, where a tap leaves focus where it was: the tab being left gives its focus up by itself, before it is hidden.
  const left = await shell.evaluate(() => { document.querySelector('.strip [data-v="ledger"]').click(); return document.querySelector('iframe[title="Docket"]').contentWindow.shownAtBlur; });
  assert.strictEqual(left, true, 'leaving a tab takes focus off its field first');
  await shell.waitForFunction(() => { const f = document.querySelector('iframe[title="Ledger"]'); return f.contentDocument.querySelector('#f') && f.contentDocument.hasFocus(); });
  await shell.keyboard.type('xy');
  assert.deepStrictEqual(await inTab('ledger', look), { text: '', body: true, keys: 'xy', seen: 0, width: 390 }, 'keys typed on the Ledger tab go to its page, not to a field');
  assert.deepStrictEqual(await inTab('Docket', look), { text: 'abc', body: true, keys: 'abc', seen: 0, width: 390 }, 'the tab that was left keeps its text and its size, loses focus and gets no keys');
  await tabTo('docket');
  assert.deepStrictEqual(await inTab('Docket', look), { text: 'abc', body: true, keys: 'abc', seen: 1, width: 390 }, 'back on its tab an app is told once that it is on screen again, and no field takes focus');
  await tabTo('hq');
  assert.ok(await shell.evaluate(() => document.activeElement.dataset.v === 'hq' && location.hash === '#demo') && await shell.locator('#h-needs').isVisible(), 'going to HQ focuses its tab button, and the address and sample data stay');
  assert.deepStrictEqual(await state(), { on: '', current: 'hq', hq: 'visible', plain: true }, 'back on HQ no frame shows and the HQ tab is marked');
  e = await edges();
  assert.ok(e.head === e.strip && e.main === e.headEnd, 'on HQ the header starts under the strip and the page under the header');
  await shell.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  e = await edges();
  assert.ok(await shell.evaluate(() => scrollY > 0) && e.head === e.strip, 'scrolled to the end, the header stays under the strip');
  await shell.locator('[data-a="toggle"][data-id^="need:"]').first().click();
  // The look on a phone with a notch, in both themes: the strip's chosen tab, the band over the home bar, the Dial and the fields.
  const look3 = () => shell.evaluate(() => {
    const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = rgb(c).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const cs = (el, pseudo) => getComputedStyle(el, pseudo), strip = cs(document.querySelector('.strip')).backgroundColor;
    const on = cs(document.querySelector('.strip [aria-current=page]')), off = [...document.querySelectorAll('.strip button:not([aria-current])')].map(b => ratio(cs(b).color, strip));
    const probe = document.createElement('i'); probe.style.color = 'var(--surface)'; document.body.appendChild(probe); const surface = cs(probe).color; probe.remove();
    const band = document.querySelector('iframe.on') ? cs(document.querySelector('.frames'), '::after') : null, dial = document.querySelector('[data-a="dial"][aria-pressed="true"]');
    return { rule: on.borderBottomWidth, same: on.color === on.borderBottomColor, on: ratio(on.color, strip), off: Math.min(...off),
      band: band && [band.height, band.backgroundColor === surface, band.visibility], dial: dial && [cs(dial).backgroundColor, cs(dial).color],
      fields: [...document.querySelectorAll('input,textarea')].map(f => parseFloat(cs(f).fontSize)) };
  });
  for (const scheme of ['light', 'dark']) {
    await shell.emulateMedia({ colorScheme: scheme });
    let l = await look3();
    assert.ok(l.rule === '3px' && l.same && l.on >= 4.5 && l.off >= 4.5, scheme + ': the chosen tab is one colour for its text and its 3 px rule, and every tab reads against the strip ' + JSON.stringify(l));
    assert.ok(l.fields.length && l.fields.every(n => n >= 16), scheme + ': every field is at least 16 px on touch ' + l.fields);
    if (scheme === 'dark') assert.deepStrictEqual(l.dial, ['rgb(43, 102, 246)', 'rgb(255, 255, 255)'], 'in dark mode the chosen Dial option is the blue block with white text');
    await tabTo('docket');
    l = await look3();
    assert.deepStrictEqual(l.band, ['34px', true, 'visible'], scheme + ': with a tab open, the band over the home bar is 34 px of the surface colour');
    assert.ok(l.rule === '3px' && l.same && l.on >= 4.5 && l.off >= 4.5, scheme + ': the same holds with the Docket tab chosen ' + JSON.stringify(l));
    await tabTo('hq');
  }
  await shell.emulateMedia({ colorScheme: 'light' });
  // A dialog asked for while an HQ field has focus is drawn only when the field loses it. Leaving HQ first must not draw it behind the tab.
  await shell.evaluate(() => { document.querySelector('[data-note]').focus(); document.querySelector('[data-a="note"]').click(); document.querySelector('.strip [data-v="docket"]').click(); });
  await shell.waitForTimeout(500);
  assert.ok(await shell.evaluate(() => !document.querySelector('.strip').inert && !document.querySelector('.sheet')), 'a dialog not yet drawn is dropped when HQ is left, so the strip stays usable');
  await tabTo('hq');
  assert.strictEqual((await state()).current, 'hq', 'and HQ can be reached again');
  await ctx.close();
  // The connection form refuses a malformed code and accepts a well-formed one.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://script.google.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Wrong key', auth: true }) }));
  await page.goto(base);
  const shot0 = () => page.screenshot({ path: path.join(__dirname, 'shots', 'welcome.png') });
  await page.waitForSelector('text=Connect it to your Team Board');
  await shot0();
  await page.locator('[data-a="status"]').first().click();
  await page.locator('#connText').fill('nonsense');
  await page.locator('[data-a="saveConn"]').click();
  await page.waitForSelector('text=That does not look like a connection code.');
  await page.locator('#connText').fill('https://script.google.com/macros/s/SAMPLE/exec#samplekeysamplekeysample');
  await page.locator('[data-a="saveConn"]').click();
  await page.waitForSelector('.sync.err');
  await browser.close(); server.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('e2e checks passed');
})().catch(e => { console.error(e); process.exit(1); });
