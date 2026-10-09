// Minimal static server, no dependencies. Serves ./public on Railway's $PORT.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createAuth, safeNext, loginPage } = require("./auth");

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
  const id = key === "consol" ? FILE_ID : CF_IDS[key];
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

  const WORKBOOK_ROUTES = {
    "/api/consol.xlsx": "consol",
    "/api/cashflow-79v.xlsx": "v",
    "/api/cashflow-arabina.xlsx": "a",
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
