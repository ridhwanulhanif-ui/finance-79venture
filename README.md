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
