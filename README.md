# finance-79venture

Finance web app for 79 Ventures, served from Railway. The live address is under the service's Settings → Networking in Railway.

The page is the P&L / balance sheet / forecast / budget / tax dashboard for 79 Ventures Sdn Bhd and Arabina Eco Tiny Homes
Sdn Bhd. It is one self-contained file with no build step.

## Structure

- `public/` — the site. `public/index.html` is the dashboard, and the home page.
- `server.js` — small static server with no dependencies. Serves `public/` and exposes `/health`.
- `apps-script/` — the Google Apps Script web app, which is the version that reads from Drive. Not served by `server.js`.

## Where the figures come from

The dashboard reads the consolidation workbook; it never hard-codes company figures. It has two ways to get one, and which
one applies depends on where the page is running:

| Running on | Data source |
|---|---|
| Railway (this repo) | `/api/consol.xlsx` — `server.js` fetches the workbook from Drive, with **Open Excel file…** as fallback |
| Apps Script web app (`apps-script/`) | Google Drive, via the signed-in user's own access |

Google sends no CORS headers, so the browser cannot fetch the workbook itself; `server.js` fetches it and passes the bytes
through, cached for a minute. The file ID is `CONSOL_FILE_ID` in Railway Variables, defaulting to the consolidation workbook.
The ID comes only from the environment, never from the request.

**This path needs the workbook shared as "Anyone with the link – Viewer", and the site has no login.** So both the workbook
and the figures on the page are readable by anyone who has the URL. Until a login is added, treat this deployment as public.
If the endpoint returns `not_shared`, the page says so and falls back to **Open Excel file…**.

The Apps Script version avoids that: it reads Drive as the signed-in user, behind a Google sign-in restricted to the
`79ventures.biz` domain, with the file staying private.

The default workbook is `02.10.2026_Consol+Mgmt Fee_2026.xlsx` (Drive ID in `DEF` in `public/index.html`), with tabs
`3. Latest 79V P&L-Mthly`, `3.1 79V BS`, `4. Latest Arabina PNL-Mthly`, `4.1 Arabina BS`. Change these under **Data source**
on the page. Tax assumptions, forecast and budget inputs and thresholds are saved in the browser's local storage.

## Asset Management

The **Asset Management** section reads the asset master data workbook (`Asset Management-Master Data.xlsx`, tabs
`Asset Register` and `Category Rates`) and works out the fixed asset register, monthly depreciation, the fixed asset
schedule, low value assets and data checks for the chosen financial year. A copy of the register as at 15 Oct 2026
is embedded in the page as the fallback when the workbook cannot be read.

- On claude.ai and the Apps Script version it reads the workbook from Drive directly.
- On Railway it reads `/api/assets.xlsx`, which `server.js` fetches from Drive. The file ID is `ASSETS_FILE_ID` in Railway
  Variables, defaulting to the master data workbook. Like the consolidation workbook, this needs the file shared
  "Anyone with the link – Viewer"; until it is, use **Open Excel file…** in the section.

Depreciation follows the workbook's own formulas: straight-line from the purchase month at the category rate, capped at
the opening net book value, up to and including the disposal month. Purchases from 1 January 2026 under RM1,000 are low
value assets, expensed at purchase. Opening NBV at 1 January 2026 is taken from column P of the Asset Register when it
holds a number (the workbook's estimate, or the audited figure typed over it).

New purchases are added on claude.ai under **New Purchase**: upload the invoice (image or PDF), Claude reads the lines,
finance checks them and saves. Saved assets, edits and disposals live in the artifact's database and are merged with the
workbook rows (same Asset ID = edit of that row). **Download master data (Excel)** gives the combined register in the
workbook's layout. On Railway the section is read-only.

The **QuickBooks check** tab compares the worksheet with QuickBooks (79 Ventures) at a chosen month end: cost and
accumulated depreciation per category (trial balance at 31 December 2025 and at the month end) and each month's
depreciation journal (Depreciation Expense ledger). Every difference is listed as an alert, worst first, with the known
cause where one fits (disposals not taken out, items under RM1,000 capitalised, assets marked under recognized, assets
with no date) and the amount left unexplained. On Railway it reads QuickBooks through the server's own connection
(`/api/qbo/report`, the one Petty Cash uses, which may now also read the Depreciation Expense ledger); on claude.ai it
uses the viewer's QuickBooks connector.

## Petty Cash: live QuickBooks check on Railway

**Petty Cash → QB vs Sheet Check** compares each holder's tab in *UPDATED PETTY CASH LISTING* with the
`Petty Cash - …` accounts in QuickBooks Arabina and 79V, and re-reads both every minute while it is open. On
claude.ai it uses the viewer's connectors. On Railway the server reads them itself:

- the sheet through `/api/petty-cash.xlsx` (`PETTY_CASH_FILE_ID`; the file must be shared "anyone with the link");
- QuickBooks through `/api/qbo/report` (`qbo.js`), which only serves the trial balance and the general ledger of
  `Petty Cash…` accounts, cached for 50 seconds.

One-time setup for QuickBooks:

1. At developer.intuit.com create an app (QuickBooks Online and Payments, scope *Accounting*) and get its
   **production** keys. Add the redirect URI `https://<your Railway domain>/qbo/callback`.
2. In Railway Variables set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_REDIRECT_URI` (that same URL). Put
   `DATA_DIR` on a Railway volume (e.g. mount a volume at `/data` and set `DATA_DIR=/data`) so the QuickBooks
   tokens survive a redeploy.
3. Signed in to the site, open `/qbo/connect?co=a` and pick **Arabina Eco Tiny Homes**, then `/qbo/connect?co=v`
   and pick **79 Ventures**. The server refuses the wrong company. `/api/qbo/status` shows what is connected.

Tokens are stored in `DATA_DIR/qbo-tokens.json` and refreshed automatically; if Intuit revokes them (about 100
days unused, or a password change), the section shows the reconnect links again.

## Admin and Fuel Card Log

The **Admin** section holds the admin team's recurring tasks (payroll, statutory payments, tax, bank, filings) and the
**Fuel Card Log**: who took each Shell Fleet card, when it came back and whether the receipts were handed in. A card
returned within 24 hours is on time, 24–48 hours is the grace period, past 48 hours it is late, and at 72 hours HR is
alerted for a show cause letter.

- On claude.ai both live in the artifact's database.
- On Railway they live in `store.json` under `DATA_DIR` (default `./data`, git-ignored), through `/api/store/…`.
  **Attach a Railway volume and set `DATA_DIR` to its mount path** (e.g. `/data`), or every deploy starts the list
  empty. The store answers only when sign-in is on (`AUTH_USERS` set), and records who made each change.
- The two are separate: ticks and card moves made on claude.ai do not appear on Railway, and the other way round.
- The HR alert emails from the viewer's Gmail only on claude.ai; on Railway it is recorded in the log only.
- The log is built from the responses of the Shell card holder Google Form (`FUEL_FORM_FILE_ID`), read live on each
  load. On Railway that sheet must be shared "anyone with the link", like the other workbooks.

## Deploy the Apps Script web app

Deploy from a **`@79ventures.biz` account** — a personal gmail account has no Workspace domain, so the domain restriction
in `appsscript.json` is not available to it. The deploying account needs access to the workbook, and the dashboard reads
Drive as that account.

1. script.google.com → New project.
2. Copy in `apps-script/Code.gs`; add an HTML file named **Index** with the contents of `apps-script/Index.html`; and under
   Project settings → *Show "appsscript.json"*, replace it with `apps-script/appsscript.json`.
3. Deploy → New deployment → Web app → *Execute as: Me*, *Who has access: anyone in 79ventures.biz*, then authorise.

It asks for full Drive, Docs and external-request scopes: the bank statement scan OCRs PDF statements by copying them to
Docs and deleting the copy, and native Sheets are exported through the Drive API.

`apps-script/Index.html` must stay byte-identical to `public/index.html`. After editing the page:

```
npm run sync:gas     # copy public/index.html -> apps-script/Index.html
npm run check:gas    # verify the two match
```

## Run locally

```
npm start
```

Then open http://localhost:3000.

## Deploy

Railway deploys the `main` branch automatically and runs `npm start`. The server reads the port from `PORT`, which Railway sets.

Secrets (API keys, passwords) go in Railway Variables, never in this repo.

## Sign-in

Set these two in Railway Variables and the whole site — page and workbook downloads alike — needs a sign-in.
Until `AUTH_USERS` is set the site stays open to anyone with the URL, so a deploy cannot lock everyone out.

| Variable | Value |
|---|---|
| `AUTH_USERS` | One line per person: `username:salt:hash`. Several people: one per line, or comma-separated. |
| `SESSION_SECRET` | Any random string of 32+ characters. Without it everyone is signed out on each redeploy. |

Make a line for someone (asks for the password twice, shows nothing, prints only the hash):

```
npm run hash-password -- boss@79ventures.biz
```

- **Take someone's access away:** delete their line from `AUTH_USERS`. It applies at once, even to a browser that is already signed in.
- **Change a password:** make a new line for the same username and replace the old one.
- **Sign everyone out:** change `SESSION_SECRET`.

A sign-in lasts seven days. Ten wrong passwords from one address lock that address out for fifteen minutes.
Sign-ins and failures are written to the Railway logs.

## Working on this repo

Work on a separate branch and open a pull request. Anything merged to `main` goes live.

**This repo is public, and so is everything in `public/`.** Accounting workbooks, bank statements and exports are
git-ignored — keep it that way, and keep company figures out of the code.
