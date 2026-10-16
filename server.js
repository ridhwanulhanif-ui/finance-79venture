// Minimal static server, no dependencies. Serves ./public on Railway's $PORT.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createAuth, safeNext, loginPage } = require("./auth");
const { createQbo } = require("./qbo");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const auth = createAuth();
console.log(auth.enabled
  ? `sign-in required: ${auth.users.size} account(s) in AUTH_USERS`
  : "AUTH_USERS is not set: the site is open to anyone with the URL");

// The consolidation workbook, fetched server-side because Google sends no CORS headers.
// Override with CONSOL_FILE_ID in Railway Variables. The file must be shared "anyone with the link".
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || "").slice(0, 7);
const STARTED_AT = new Date().toISOString();
const FILE_ID = process.env.CONSOL_FILE_ID || "1mx6JMUwsWpLx_4BT2vTy71bYGmIlXqCT";
// The two cashflow workbooks the bank reconciliation compares against. Without these the bank
// check cannot run here at all: the Drive connector only exists inside claude.ai, so on this
// server the page had a button that could never succeed.
const CF_IDS = {
  v: process.env.CF79V_FILE_ID || "1HG-szfIeeKbhgg7k7KD1_9i2UEDLOzPulsDibEXrSUQ",
  a: process.env.CFARABINA_FILE_ID || "1wWDiW5UHSnYx3IeK8US23uBK0cMYq3uXgwckgTzS_Hg",
};
// The forecast workbook whose Forecast2 tab holds the margin targets the board set.
const FC_ID = process.env.FORECAST_FILE_ID || "1dGsuzK1g5KOAVNdWNm6yf5BI3ETMQEpD";
// Responses sheet of the petty cash Written Explanation Form (Google Form), shown as printable forms.
const WEF_ID = process.env.WEF_FILE_ID || "1X5wNONJuO2zK0hijpqpXqMpL7QOhVeRT72hWstN1spE";
// The asset master data workbook (Asset Register and Category Rates tabs) for Asset Management.
const ASSETS_ID = process.env.ASSETS_FILE_ID || "1L3S_2owmKweiF0ctIf9zgW8fW1KERoi3";
// Responses of the Shell card holder Google Form, read by the Fuel Card Log.
const FUEL_FORM_ID = process.env.FUEL_FORM_FILE_ID || "1c257rqN7p5cCS_G-r3s5_1ekheFlzIN_dyMfZT1AO6Q";
// UPDATED PETTY CASH LISTING: each holder's tab, checked against QuickBooks in the Petty Cash section.
const PC_ID = process.env.PETTY_CASH_FILE_ID || "175L0xWlKOLnWXiNzZOAQD_Gjsgk5etouT8ESp5i3Jvs";
const CACHE_MS = 60_000;
const caches = new Map();

// Fixed ID from the environment, never from the request, so the request cannot steer the fetch.
async function fetchWorkbook(id) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new Error("bad_id");
  // An uploaded .xlsx comes down through uc?export=download. A native Google Sheet does not: that
  // URL answers with an HTML page for it, so it has to be exported instead. The consolidation file
  // is the first kind and both cashflow workbooks are the second, so try one then the other.
  const urls = [
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
  ];
  let lastStatus = 0;
  for (const url of urls) {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { lastStatus = r.status; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    // A workbook is a ZIP ("PK"). Anything else is a sign-in, scan-warning or not-a-file page.
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) continue;
    const cd = r.headers.get("content-disposition") || "";
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    let title = "";
    try {
      title = m ? decodeURIComponent(m[1]).replace(/[^\x20-\x7e]/g, "").trim() : "";
    } catch {
      title = "";
    }
    return { buf, title };
  }
  // Neither form gave a workbook. A 5xx means Google is having trouble; anything else means the
  // file is not readable without signing in, i.e. not shared "anyone with the link".
  throw new Error(lastStatus >= 500 ? "upstream_" + lastStatus : "not_shared");
}

// key picks the id from the table above, never from the request, so a caller cannot steer the
// fetch at some other Drive file.
async function serveWorkbook(res, key) {
  const id = key === "consol" ? FILE_ID : key === "fc" ? FC_ID : key === "wef" ? WEF_ID : key === "am" ? ASSETS_ID : key === "fuel" ? FUEL_FORM_ID : key === "pc" ? PC_ID : CF_IDS[key];
  if (!id) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "unknown_workbook" }));
    return;
  }
  const cache = caches.get(key);
  if (cache && Date.now() - cache.at < CACHE_MS) {
    res.writeHead(200, cache.headers);
    res.end(cache.buf);
    return;
  }
  try {
    const { buf, title } = await fetchWorkbook(id);
    const headers = {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Consol-Title": encodeURIComponent(title),
      "X-Consol-Fetched": new Date().toISOString(),
    };
    caches.set(key, { buf, headers, at: Date.now() });
    res.writeHead(200, headers);
    res.end(buf);
  } catch (err) {
    const code = err && err.message === "not_shared" ? "not_shared" : "upstream";
    console.error("workbook fetch failed (" + key + "):", (err && err.message) || err);
    res.writeHead(code === "not_shared" ? 403 : 502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: code }));
  }
}


// Shared records for the Admin tasks and the Fuel Card Log: on claude.ai these live in the artifact's
// database, here in one JSON file. Put DATA_DIR on a Railway volume, or every deploy starts it empty.
// Only these collections exist, and only for a signed-in user: the site is public until AUTH_USERS is set.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const qbo = createQbo({ dataDir: DATA_DIR });
const STORE_COLS = new Set(["admtasks", "admdone", "fuelcards", "fuelmoves", "fuelcfg"]);
let store = null;
function loadStore() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { store = {}; }
  return store;
}
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STORE_FILE);
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = "", over = false;
    req.on("data", (c) => { if (over) return; body += c; if (body.length > limit) { over = true; resolve(undefined); } });
    req.on("end", () => { if (over) return; try { const v = JSON.parse(body || "{}"); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : undefined); } catch { resolve(undefined); } });
    req.on("error", () => resolve(undefined));
  });
}
async function handleStore(req, res, urlPath, user) {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (!auth.enabled) { send(403, { error: "sign_in_not_configured" }); return; }
  const m = /^\/api\/store\/([a-z]+)(?:\/([A-Za-z0-9_\-.~:@+]{1,200}))?$/.exec(urlPath);
  if (!m || !STORE_COLS.has(m[1])) { send(404, { error: "unknown_collection" }); return; }
  const [, col, id] = m, S = loadStore(), C = (S[col] = S[col] || {});
  if (req.method === "GET" && !id) { send(200, { docs: Object.entries(C).map(([k, v]) => ({ id: k, data: v })) }); return; }
  if (req.method === "GET") { send(C[id] ? 200 : 404, C[id] ? { id, data: C[id] } : { error: "not_found" }); return; }
  if (!id) { send(405, { error: "method" }); return; }
  if (req.method === "DELETE") { delete C[id]; saveStore(); send(200, { ok: true }); return; }
  if (req.method !== "PUT" && req.method !== "PATCH") { send(405, { error: "method" }); return; }
  const body = await readJson(req);
  if (!body) { send(400, { error: "bad_body" }); return; }
  if (Object.keys(C).length >= 20000 && !C[id]) { send(507, { error: "store_full" }); return; }
  C[id] = req.method === "PATCH" ? { ...(C[id] || {}), ...body } : body;
  saveStore();
  console.log(`store ${req.method} ${col}/${id} by ${user}`);
  send(200, { ok: true });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  // Nobody has a reason to frame this page, and framing it is how a sign-in form gets spoofed.
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

function readForm(req, limit = 4096) {
  return new Promise((resolve) => {
    let body = "", over = false;
    req.on("data", (c) => { if (over) return; body += c; if (body.length > limit) { over = true; resolve(null); } });
    req.on("end", () => { if (!over) resolve(new URLSearchParams(body)); });
    req.on("error", () => resolve(null));
  });
}

async function handleLogin(req, res, url) {
  if (req.method === "GET") {
    if (!auth.enabled || auth.userOf(req)) {
      res.writeHead(302, { Location: safeNext(url.searchParams.get("next")) }).end();
      return;
    }
    res.writeHead(200, HTML_HEADERS).end(loginPage({ next: url.searchParams.get("next") || "/" }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }).end(); return; }
  const ip = auth.clientIp(req);
  const form = await readForm(req);
  const name = form ? form.get("username") || "" : "";
  const next = form ? form.get("next") : "/";
  if (auth.tooManyFails(ip)) {
    res.writeHead(429, HTML_HEADERS).end(loginPage({ error: "Too many attempts. Wait fifteen minutes and try again.", next, user: name }));
    return;
  }
  if (!form || !(await auth.verifyPassword(name, form.get("password")))) {
    auth.noteFail(ip);
    console.warn("sign-in failed for", JSON.stringify(String(name).slice(0, 80)), "from", ip);
    res.writeHead(401, HTML_HEADERS).end(loginPage({ error: "That username and password do not match.", next, user: name }));
    return;
  }
  console.log("signed in:", name.trim().toLowerCase(), "from", ip);
  res.writeHead(303, { Location: safeNext(next), "Set-Cookie": auth.cookieHeader(req, auth.issue(name), auth.sessionMs), "Cache-Control": "no-store" }).end();
}

const server = http.createServer(async (req, res) => {
  let urlPath, url;
  try {
    url = new URL(req.url, "http://localhost");
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (urlPath === "/login") { await handleLogin(req, res, url); return; }
  if (urlPath === "/logout") {
    res.writeHead(303, { Location: "/login", "Set-Cookie": auth.cookieHeader(req, "", 0), "Cache-Control": "no-store" }).end();
    return;
  }

  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    // Which build is live is otherwise invisible: a page that looks unchanged after a deploy could
    // be a stale deploy or a cached file, and there is no way to tell them apart from the browser.
    res.end(JSON.stringify({ ok: true, commit: COMMIT, startedAt: STARTED_AT }));
    return;
  }

  if (urlPath === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("User-agent: *\nDisallow: /\n");
    return;
  }

  // Everything below needs a signed-in user once accounts exist.
  const user = auth.enabled ? auth.userOf(req) : null;
  if (auth.enabled && !user) {
    if (urlPath.startsWith("/api/")) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "sign_in_required" }));
    } else {
      res.writeHead(302, { Location: "/login?next=" + encodeURIComponent(url.pathname + url.search), "Cache-Control": "no-store" }).end();
    }
    return;
  }

  if (urlPath === "/api/me") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ user, auth: auth.enabled }));
    return;
  }

  // QuickBooks: connect each company once, then the Petty Cash check reads it live.
  if (urlPath === "/qbo/connect") {
    try { res.writeHead(302, { Location: qbo.connectUrl(url.searchParams.get("co"), user), "Cache-Control": "no-store" }).end(); }
    catch (err) { res.writeHead(err.code === "not_configured" ? 503 : 400, { "Content-Type": "text/plain; charset=utf-8" }).end(err.message); }
    return;
  }
  if (urlPath === "/qbo/callback") {
    try {
      const r = await qbo.callback(url.searchParams, user);
      console.log("QuickBooks connected:", r.co, r.realm, "by", user || "(no sign-in)");
      res.writeHead(303, { Location: "/?qbo=" + r.co, "Cache-Control": "no-store" }).end();
    } catch (err) {
      console.error("QuickBooks connect failed:", err.code, err.message);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("QuickBooks was not connected: " + err.message);
    }
    return;
  }
  if (urlPath === "/api/qbo/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(qbo.status()));
    return;
  }
  if (urlPath === "/api/qbo/report" && req.method === "POST") {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
    const body = await readJson(req);
    if (!body) { send(400, { error: { code: "bad_request", message: "Bad request." } }); return; }
    try { send(200, await qbo.report(body.co, body)); }
    catch (err) {
      console.error("QuickBooks report failed:", err.code || "", err.message);
      send(err.code === "bad_request" ? 400 : err.code === "not_connected" ? 409 : 502, { error: { code: err.code || "qbo_error", message: err.message } });
    }
    return;
  }

  if (urlPath.startsWith("/api/store/")) {
    handleStore(req, res, urlPath, user).catch((err) => {
      console.error("store failed:", (err && err.message) || err);
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "store_failed" })); }
    });
    return;
  }

  const WORKBOOK_ROUTES = {
    "/api/consol.xlsx": "consol",
    "/api/cashflow-79v.xlsx": "v",
    "/api/cashflow-arabina.xlsx": "a",
    "/api/forecast.xlsx": "fc",
    "/api/explanation-forms.xlsx": "wef",
    "/api/petty-cash.xlsx": "pc",
    "/api/assets.xlsx": "am",
    "/api/fuel-form.xlsx": "fuel",
  };
  if (WORKBOOK_ROUTES[urlPath]) {
    serveWorkbook(res, WORKBOOK_ROUTES[urlPath]);
    return;
  }

  if (urlPath.endsWith("/")) urlPath += "index.html";

  // Resolve inside PUBLIC_DIR only; reject anything that escapes it.
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      // The dashboard is one HTML file, so without this the browser keeps serving
      // the version it cached and a deploy looks like it did nothing.
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      ...(ext === ".html" ? { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" } : {}),
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`finance-79venture listening on port ${PORT}`);
});
