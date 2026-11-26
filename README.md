# Team HQ

Team HQ is a front desk for a small team of AI assistants that work for one person. It runs in a browser on a phone and on a computer and shows three things: what each assistant last reported, which requests are waiting on the owner, and whether today's scheduled runs happened.

The data lives in a Google Sheet that you own, called the Team Board. Each assistant appends rows to its own tab. A script in the sheet checks once an hour that every expected run reported, and sends a short phone alert through [ntfy](https://ntfy.sh) when one did not. The check runs on Google's side, so it keeps working when the assistants cannot run.

## What it does

- **Needs you** lists requests an assistant marked for the owner. Approve or decline with an optional note; the answer is appended to the board for the assistant to read.
- **Team** has one card per assistant, in the order of the Roles setting: the latest report, earlier reports, handoffs waiting for that assistant, a button that opens its chat room, and a note box. The first card's latest report starts open.
- **Runs today** shows each expected run as reported, due, late or not watched.
- **Dial** sets how much the team may notify, using the words listed in the Settings tab. The assistants read it from the sheet.

## Tabs

A strip at the top holds three tabs: HQ, Docket and Ledger. HQ is this app. Docket and Ledger are two separate apps served from the same site (`../Docket/` and `../ledger/`); each opens in a frame the first time its tab is chosen and stays loaded after that. Team HQ opens on HQ every time it starts: no tab is remembered, and the address does not change with the tab.

Choosing a tab takes focus out of the tab being left, so its keyboard closes, and gives focus to the chosen page without putting it in a field. An app that was already loaded is told that it is back on screen, so it syncs. While a dialog is open in HQ, the strip is inert like the page behind the dialog.

Each of the three apps keeps its own data and its own connection. Inside Team HQ, Docket and Ledger read the storage this browser or Home Screen icon already holds for them; where there is none, each tab asks for its own connection code once. On an iPhone a Home Screen icon has storage of its own, so the Team HQ icon needs each app's code once.

The link in HQ that opened the task list is gone, because the Docket tab replaces it. The `Task app` row of the Settings tab is no longer read by the app and can stay where it is. A copy hosted without the two other apps shows the host's not-found page in their tabs.

## Set up

1. Create a Google Sheet. Open **Extensions > Apps Script**, replace the editor's contents with `apps-script/Code.gs`, and save.
2. In the Apps Script editor, open **Project Settings** and set the time zone you live in. Set the same time zone for the spreadsheet under **File > Settings**.
3. Reload the sheet. Choose **Team HQ > Set up or repair** and approve the permissions it asks for (the sheet, an hourly timer, and sending the alert to ntfy.sh).
4. In the **Settings** tab, list the assistants' roles under **Roles** (separated by commas, in the order of their cards), then fill the **Dial options** and the owner's name. Run **Team HQ > Set up or repair** again: it adds a name, label, room and desk row for each role and a tab for each name. Fill those rows, then list the scheduled runs in the **Expected** tab: the run's name, the role that posts it (one of the roles), the days it runs (`Daily`, `Mon-Fri`, `Sat`), and the time by which it should have reported.
5. Install the ntfy app on the phone and subscribe to a topic made of 16 or more random letters and digits. Choose **Team HQ > Set the alert topic**, paste the topic, then **Team HQ > Send a test alert**. The topic works like a password, so the alerts carry run names only.
6. In the Apps Script editor choose **Deploy > New deployment > Web app**, with **Execute as: Me** and **Who has access: Anyone**. The key from the next step is what protects the data.
7. Copy the **Web app URL** (it ends in `/exec`). Back in the sheet choose **Team HQ > Show connection code** to get the key. The connection code is the URL, then `#`, then the key.
8. Open the app, tap the status button at the top right, paste the code, and choose **Save**. Repeat on each device.

On an iPhone, open the app in Safari and choose **Share > Add to Home Screen** so it opens like an app.

To host your own copy, fork this repository and turn on GitHub Pages for the `main` branch.

## The sheet

| Tab | Writer | Purpose |
| --- | --- | --- |
| `Out_<name>` (one per assistant) | That assistant | Reports, handoffs, replies and one `heartbeat` row per scheduled run. Rows are appended and never edited. |
| `Out_HQ` | The app | The owner's approvals, declines and notes. |
| `Expected` | The owner | The runs the watchdog looks for. |
| `Settings` | The owner | The roles, and for each its name, label, room and desk links; the owner's name; the dial and its words; quiet hours and the daily alert cap. New rows are always added at the end. The `Task app` row is unused since version 1.3.0. |
| `Watchdog` | The script | One row per run per day: reported, late, and when an alert went out. |
| `Digest` | The script | Only what is still open: requests waiting on the owner, handoffs waiting for each assistant, each assistant's latest report, and late runs. Assistants read this tab so they never load the full history. |

A scheduled run reports by appending a row whose Kind is `heartbeat` and whose Subject is the run's exact name from the Expected tab.

## Updating

The app updates by itself the next time it opens with signal. When `apps-script/Code.gs` changes, paste the new file over the old one, run **Team HQ > Set up or repair**, then choose **Deploy > Manage deployments > Edit > Version: New version** so the web address stays the same.

## Privacy

The repository holds code and placeholder sample data only. Roles, labels, names, the dial's words, links, reports, the sheet ID, the alert topic and the connection key exist only in your sheet, in its script properties and on your devices.

## Development

```
node test/backend.test.js   # the Apps Script code against in-memory stand-ins for Google's services
node test/e2e.js            # the app in Chrome with its sample data (needs Playwright and Chrome)
```

Fonts: Geist and Bebas Neue, SIL Open Font License 1.1 (see `fonts/README.md`).
