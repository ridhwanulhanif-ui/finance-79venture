// Minimal static server, no dependencies. Serves ./public on Railway's $PORT.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

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
  const r = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error("upstream_" + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  // A workbook is a ZIP ("PK"). Anything else is Google's sign-in or scan-warning page,
  // which means the file is not shared publicly.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("not_shared");
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

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    // Which build is live is otherwise invisible: a page that looks unchanged after a deploy could
    // be a stale deploy or a cached file, and there is no way to tell them apart from the browser.
    res.end(JSON.stringify({ ok: true, commit: COMMIT, startedAt: STARTED_AT }));
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

  if (urlPath === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("User-agent: *\nDisallow: /\n");
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
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`finance-79venture listening on port ${PORT}`);
});
