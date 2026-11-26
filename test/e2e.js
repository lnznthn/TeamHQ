// Opens the app in Chrome with its built-in sample data and checks the main flows. Needs Playwright and Chrome.
const { chromium } = require('playwright');
const path = require('path'), http = require('http'), fs = require('fs'), assert = require('assert');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
(async () => {
  const server = http.createServer((req, res) => {
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
    // Every control is at least 44 px high on a phone, 40 px with a mouse.
    const small = await page.evaluate(min => [...document.querySelectorAll('button,a.btn,a.tbtn')].filter(b => b.getBoundingClientRect().height < min).map(b => b.className + ':' + b.getBoundingClientRect().height), v.w < 900 ? 44 : 40);
    assert.deepStrictEqual(small, [], 'control sizes');
    // Colour pairs from the tokens: text needs 4.5:1, borders and focus rings 3:1.
    const ratios = await page.evaluate(() => {
      const css = n => { const e = document.createElement('i'); e.style.color = 'var(--' + n + ')'; document.body.appendChild(e); const c = getComputedStyle(e).color.match(/[\d.]+/g).map(Number); e.remove(); return c; };
      const lum = c => { const [r, g, b] = c.slice(0, 3).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
      const ratio = (a, b) => { const x = lum(css(a)), y = lum(css(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const text = [['text', 'bg'], ['muted', 'bg'], ['muted', 'raise'], ['attn', 'bg'], ['danger', 'bg'], ['on-accent', 'accent'], ['text', 'field'], ['text', 'raise']];
      const ui = [['edge', 'bg'], ['edge', 'field'], ['accent-edge', 'bg'], ['text', 'bg']];
      return { text: text.map(p => [p.join('/'), ratio(...p)]), ui: ui.map(p => [p.join('/'), ratio(...p)]) };
    });
    ratios.text.forEach(r => assert.ok(r[1] >= 4.5, v.name + ' text contrast ' + r));
    ratios.ui.forEach(r => assert.ok(r[1] >= 3, v.name + ' control contrast ' + r));
    console.log(v.name, 'text', ratios.text.map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '), '| ui', ratios.ui.map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '));
    await shot('-end');
    await page.close();
  }
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
