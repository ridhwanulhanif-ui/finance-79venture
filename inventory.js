// Inventory Warehouse download (/api/inventory.csv, signed-in users only): every line posted this year
// to the warehouse hardware stock accounts in QuickBooks, as CSV for Excel or Google Sheets. Each
// purchase is put in an item group from its memo and counted against the other purchases of the same
// month, the same way the page's Inventory Warehouse section does. Keep CATS in step with IW_CATS in
// public/index.html.
const ACCOUNTS = { v: "Inventory Hardware-Danial", a: "Inventory Hardware - Danial" };
const CO_NAME = { v: "79V", a: "Arabina" };
const CATS = [
  ["Bifold door", /bi ?fold/],
  ["Toilet & sanitary", /toilet|tandas|p ?-?trap|wall ?hung|water closet|sanitary|faucet|\btap\b|bidet|sink|basin|bathroom/],
  ["Welding", /welding/],
  ["Electrical", /electric|\belec\b|soket|socket|switch|\bmcb\b|exhaust fan|lampu|\blamp|\bled\b|down ?light|wiring|cable|\bwire|nut box|casing|lid cover|vivace|\b\dg\dw\b/],
  ["Tiles", /\btiles?\b|jubin/],
  ["Screws & bolts", /skru|screw|bolt|wafer head|\bsds\b|rivet/],
  ["Aluminium", /alumin/],
  ["Cement board & wood plank", /cement ?board|wood ?plank|plywood/],
  ["Metal deck & roofing", /metal ?deck|longrun|roofing|\broof|batten|\bsection\b|hip capping/],
  ["Tools", /measuring tape|tape measure|cutter|tangga|ladder|shovel|\btools?\b/],
  ["Steel, channel & pipe", /c channel|\b[sr]hs\b|hollow|besi|steel|pipe|stair plate|chequered plate|flat bar|angle|channel/],
  ["Paint, coating & sealant", /\bcat\b|paint|primer|latex|thinner|coat|spray|silicone|sealant/],
  ["Artificial grass", /artificial grass|rumput/],
  ["Windows", /tingkap|window/],
  ["Slab formwork", /acuan|formwork/],
  ["Cabinet", /cabinet/]];
const OTHER = "Other hardware (memo names no item)";
const category = (memo) => { const s = String(memo || "").toLowerCase(); const c = CATS.find(([, re]) => re.test(s)); return c ? c[0] : OTHER; };
const vendorKey = (s) => String(s || "").toUpperCase().replace(/\(.*?\)/g, " ").replace(/\b(SDN|BHD|ENTERPRISE|TRADING)\b\.?/g, " ").replace(/[^A-Z0-9]+/g, " ").trim();
const r2 = (x) => Math.round((x || 0) * 100) / 100;

// A supplier credit note cancels the purchase it reverses, as iwCredits does on the page: the earlier
// purchase from that supplier with the most lines of the same amounts (the latest on a tie).
function credits(out) {
  const cr = new Map();
  out.filter((r) => r.amt < 0 && /credit|refund/i.test(r.typ)).forEach((c) => { if (!cr.has(c.tx)) cr.set(c.tx, []); cr.get(c.tx).push(c); });
  cr.forEach((C) => {
    const k = vendorKey(C[0].name), d = C[0].d, by = new Map();
    out.filter((r) => r.buy && vendorKey(r.name) === k && r.d <= d).forEach((r) => { if (!by.has(r.tx)) by.set(r.tx, []); by.get(r.tx).push(r); });
    const match = (L) => { const left = L.slice(), got = []; C.forEach((c) => { const i = left.findIndex((r) => Math.abs(r.amt + c.amt) < 0.005); if (i >= 0) got.push(left.splice(i, 1)[0]); }); return got; };
    const best = [...by.values()].map((L) => ({ L, got: match(L) })).filter((x) => x.got.length).sort((a, b) => b.got.length - a.got.length || (a.L[0].d < b.L[0].d ? 1 : -1))[0];
    if (best) best.got.forEach((p) => { p.buy = false; p.typ += " (cancelled by credit note " + (C[0].num || "") + ")"; });
  });
}

function lines(rep, co) {
  const meta = rep && rep.raw_report && rep.raw_report.metadata;
  const keys = ((meta && meta.Columns && meta.Columns.Column) || []).map((c) => ((c.MetaData || []).find((m) => m.Name === "ColKey") || {}).Value);
  const val = (cd, k) => { const i = keys.indexOf(k); return i >= 0 && cd[i] && cd[i].value != null ? String(cd[i].value) : ""; };
  const out = [];
  for (const x of (rep && rep.raw_report && rep.raw_report.rows) || []) {
    const cd = x.row && x.row.ColData;
    if (!cd) continue;
    const d = val(cd, "tx_date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const typ = val(cd, "txn_type"), amt = r2(parseFloat(val(cd, "subt_nat_amount").replace(/,/g, "")) || 0);
    const ti = keys.indexOf("txn_type"), memo = val(cd, "memo").replace(/\s+/g, " ").trim();
    out.push({ co, d, m: d.slice(0, 7), typ, tx: co + ":" + ((cd[ti] && cd[ti].id) || val(cd, "doc_num") || d + amt), num: val(cd, "doc_num"),
      name: val(cd, "name"), memo, amt, buy: !/journal|transfer|adjust/i.test(typ) && amt > 0, cat: category(memo) });
  }
  credits(out);
  return out;
}

// Times the same group (item, supplier, supplier + amount) was bought in the row's month, counting
// one transaction once even when it has several lines.
function counts(rows, keyOf) {
  const m = new Map();
  rows.filter((r) => r.buy).forEach((r) => { const k = r.m + "|" + keyOf(r); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(r.tx); });
  return (r) => (r.buy ? m.get(r.m + "|" + keyOf(r)).size : "");
}

const cell = (v) => {
  if (typeof v === "number") return String(v);
  let s = String(v == null ? "" : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // text only: a memo must not run as a formula in the sheet
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function inventoryCsv(qbo) {
  const now = new Date(Date.now() + 8 * 3600_000); // Malaysia time
  const to = now.toISOString().slice(0, 10), from = to.slice(0, 4) + "-01-01";
  const columns = ["tx_date", "txn_type", "doc_num", "name", "memo", "split_acc", "subt_nat_amount"];
  const reps = await Promise.all(["v", "a"].map((co) => qbo.report(co, { report_type: "general_ledger", start_date: from, end_date: to, account: [{ name: ACCOUNTS[co] }], columns })));
  const rows = ["v", "a"].flatMap((co, i) => lines(reps[i], co)).sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  const nItem = counts(rows, (r) => r.cat), nVend = counts(rows, (r) => vendorKey(r.name)), nSame = counts(rows, (r) => vendorKey(r.name) + "|" + r.amt.toFixed(2));
  const head = ["Company", "Date", "Month", "Type", "Num", "Supplier", "Memo", "Item group", "Amount (RM)", "Purchase",
    "Times this item bought this month", "Times this supplier this month", "Same supplier same amount this month", "Flag", "Read at (MYT)"];
  const at = now.toISOString().slice(0, 19).replace("T", " ");
  const body = rows.map((r) => {
    const a = nItem(r), b = nVend(r), c = nSame(r);
    const flag = !r.buy ? "Stock movement" : c > 1 ? "Check: possible double payment" : a > 1 && r.cat !== OTHER ? "Repeat item this month" : b > 1 ? "Repeat supplier this month" : "";
    return [CO_NAME[r.co], r.d, r.m, r.typ, r.num, r.name, r.memo, r.buy ? r.cat : "", r.amt, r.buy ? "Yes" : "No", a, b, c, flag, at].map(cell).join(",");
  });
  return [head.map(cell).join(","), ...body].join("\r\n") + "\r\n";
}

module.exports = { inventoryCsv };
