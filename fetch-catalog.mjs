#!/usr/bin/env node
/* fetch-catalog.mjs
   Builds the "Bills by Policy Area" catalog: every bill and resolution in the current Congress, from the Congress.gov API.

   Usage:
     CONGRESS_API_KEY=... SITE_URL=https://foundingfathers.neocities.org node fetch-catalog.mjs [outDir]
   Options:
     --site-dir <dir>   read the previous catalog from a folder instead of SITE_URL (for testing)
     --mock <file.mjs>  answer API calls from a test file instead of the API
     --budget <n>       most API lookups this run (default 4000; the API allows 5,000 an hour per key)
     --minutes <n>      stop starting new bills after this many minutes (default 45)
     --congress <n>     build a Congress other than the current one
     --force            check for changes even if the catalog was checked less than a day ago
   Writes into outDir (default catalog-out):
     catalog/congresses.json            the Congresses that have a catalog
     catalog/<C>/index.json             policy areas with counts, and a search list of every bill
     catalog/<C>/area-<slug>.json       one per policy area: a row for each bill, newest action first
     catalog/<C>/d/<type>-<n>.json      full details (summary, actions, cosponsors, related bills, text), 100 bill numbers a file
     catalog/<C>/sponsors/<id>.json     each member's sponsored bills
     catalog/<C>/sponsor-counts.json    every member's count of sponsored bills, for the Politicians pages
     catalog/<C>/state.json             what's been fetched, so the next run carries on
     upload.txt                         the files that changed this run, for the workflow to upload
   Each run first lists the bills Congress.gov changed since the last run, then fetches details for bills that are new or
   changed, newest activity first, until the budget or time runs out. The first catalog takes about a day of hourly runs.
   When a new Congress starts, the new one gets its own catalog and the last one stays on the site as an archive. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.congress.gov/v3";
const KEY = process.env.CONGRESS_CATALOG_KEY || process.env.CONGRESS_API_KEY || "";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flagged = new Set(); ["--site-dir", "--mock", "--budget", "--minutes", "--congress"].forEach(n => { const i = args.indexOf(n); if (i >= 0) { flagged.add(i); flagged.add(i + 1); } });
const outDir = args.filter((a, i) => !flagged.has(i))[0] || "catalog-out";
const siteDir = opt("--site-dir", null), mockFile = opt("--mock", null);
const BUDGET = +opt("--budget", 4000), MINUTES = +opt("--minutes", 45);
const START = Date.now(), NOW = new Date().toISOString().replace(/\.\d+Z$/, "Z"), TODAY = NOW.slice(0, 10);
let cy = +TODAY.slice(0, 4); if (`${cy}-01-03` > TODAY) cy--;
const C = +opt("--congress", Math.floor((cy - 1789) / 2) + 1);
const SUMMARY_MAX = 3000, KEEP_TYPES = new Set(["Floor", "President", "BecameLaw", "Veto", "ResolvingDifferences", "Discharge"]);
const UNASSIGNED = "Not yet assigned";

if (!KEY && !mockFile) { console.error("No API key. Set CONGRESS_CATALOG_KEY or CONGRESS_API_KEY."); process.exit(1); }
if (!SITE_URL && !siteDir) { console.error("Set SITE_URL (or --site-dir) so the previous catalog can be read."); process.exit(1); }
const mock = mockFile ? (await import(pathToFileURL(path.resolve(mockFile)).href)).default : null;

/* ---- reading the previous catalog ---- */
async function readSite(rel) {
  try {
    if (siteDir) return JSON.parse(await fs.readFile(path.join(siteDir, rel), "utf8"));
    const res = await fetch(`${SITE_URL}/${rel}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { if (e.code === "ENOENT") return null; throw new Error(`Couldn't read ${rel} from the site: ${e.message}`); }
}

/* ---- the API ---- */
let calls = 0, limited = false;
class NotFound extends Error {}
class RateLimited extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, params = {}) {
  calls++;
  if (mock) { const r = await mock(p, params); if (r == null) throw new NotFound(p); if (r === "429") throw new RateLimited(p); return r; }
  const u = new URL(API + p);
  for (const [k, v] of Object.entries({ format: "json", ...params })) u.searchParams.set(k, v);
  u.searchParams.set("api_key", KEY);
  for (let t = 1; ; t++) {
    let res;
    try { res = await fetch(u, { headers: { Accept: "application/json" } }); }
    catch (e) { if (t >= 3) throw e; await sleep(2000 * t); continue; }
    if (res.status === 404) throw new NotFound(p);
    if (res.status === 429) throw new RateLimited(p);
    if (res.ok) return res.json();
    if (res.status >= 500 && t < 3) { await sleep(3000 * t); continue; }
    throw new Error(`${p}: HTTP ${res.status}`);
  }
}
const pick = (j, k) => { if (!j) return undefined; const f = Object.keys(j).find(x => x.toLowerCase() === k.toLowerCase()); return f === undefined ? undefined : j[f]; };
async function apiAll(p, key, params = {}, maxPages = 4) {
  const out = [];
  for (let page = 0, offset = 0; page < maxPages; page++, offset += 250) {
    const j = await api(p, { ...params, limit: 250, offset });
    const items = pick(j, key) || []; out.push(...items);
    if (items.length < 250 || !(j.pagination && j.pagination.next)) break;
  }
  return out;
}

/* ---- shared helpers (the same rules as fetch-congress.mjs and index.html) ---- */
const TYPES = { hr:["H.R.","house-bill"], s:["S.","senate-bill"], hjres:["H.J.Res.","house-joint-resolution"], sjres:["S.J.Res.","senate-joint-resolution"],
  hconres:["H.Con.Res.","house-concurrent-resolution"], sconres:["S.Con.Res.","senate-concurrent-resolution"], hres:["H.Res.","house-resolution"], sres:["S.Res.","senate-resolution"] };
const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"));
const label = (t, n) => `${TYPES[t][0]} ${n}`;
const billUrl = (c, t, n) => `https://www.congress.gov/bill/${ord(c)}-congress/${TYPES[t][1]}/${n}`;
const ent = s => String(s || "").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const day = d => d ? String(d).slice(0, 10) : null;
const slug = n => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const STAGES = ["introduced", "reported", "passed-house", "passed-senate", "passed-both", "to-president", "vetoed", "law"];
function stageOf(actions) {
  const t = actions.map(a => `${a.type || ""} ${a.text || ""}`), has = re => t.some(x => re.test(x));
  if (has(/Became Public Law|BecameLaw/)) return "law";
  if (has(/Vetoed by President|Pocket Vetoed/i) && !has(/Passed over veto/i)) return "vetoed";
  if (has(/Presented to President/i)) return "to-president";
  const h = has(/Passed\/agreed to in House|On passage Passed|Passed House/i), s = has(/Passed\/agreed to in Senate|Passed Senate/i);
  if (h && s) return "passed-both"; if (h) return "passed-house"; if (s) return "passed-senate";
  if (has(/Reported (by|to House|to Senate|with|without)|Ordered to be Reported|Placed on (the )?(Union|House|Senate Legislative) Calendar/i)) return "reported";
  return "introduced";
}
function paras(html) {
  const blocks = String(html || "").replace(/\r?\n/g, " ").split(/<\/(?:p|li|h\d|div)>|<br\s*\/?>/i)
    .map(b => (/<li[\s>]/i.test(b) ? "• " : "") + ent(b.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(b => b && b !== "•");
  const out = []; let n = 0, cut = false;
  for (const b of blocks) { if (n + b.length > SUMMARY_MAX && out.length) { cut = true; break; } out.push(b); n += b.length; }
  return { p: out, cut };
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }
const keyOf = (t, n) => `${t}${n}`;
const splitKey = k => { const m = k.match(/^([a-z]+)(\d+)$/); return [m[1], +m[2]]; };
const chunkOf = k => { const [t, n] = splitKey(k); return `d/${t}-${Math.floor(n / 100)}.json`; };

/* ---- 1. the previous state, and what changed on Congress.gov ---- */
const base = `catalog/${C}`;
const state = (await readSite(`${base}/state.json`)) || { congress: C, listedAt: null, bills: {}, hashes: {} };
const B = state.bills;
/* Once every bill has details, a run does nothing until a day has passed since the last check. */
const caughtUp = Object.values(B).length && Object.values(B).every(b => b.d && b.d === b.u);
if (caughtUp && state.listedAt && Date.now() - Date.parse(state.listedAt) < 20 * 36e5 && !args.includes("--force")) {
  await fs.mkdir(outDir, { recursive: true }); await fs.writeFile(path.join(outDir, "upload.txt"), "");
  console.log(`${ord(C)} Congress catalog is up to date; last checked ${state.listedAt}. Nothing to do until a day has passed.`);
  process.exit(0);
}
let listed = 0;
const listFrom = state.listedAt ? new Date(Date.parse(state.listedAt) - 864e5).toISOString().replace(/\.\d+Z$/, "Z") : null; /* a day's overlap, to be safe */
try {
  const list = await apiAll(`/bill/${C}`, "bills", listFrom ? { fromDateTime: listFrom, toDateTime: NOW } : {}, 200);
  for (const it of list) {
    const t = String(it.type || "").toLowerCase(); if (!TYPES[t]) continue;
    const k = keyOf(t, it.number), b = B[k] || (B[k] = { d: null });
    b.title = ent(it.title); b.la = it.latestAction ? [day(it.latestAction.actionDate), ent(it.latestAction.text)] : b.la || null;
    b.u = it.updateDateIncludingText || it.updateDate || b.u;
  }
  state.listedAt = NOW; listed = list.length;
  console.log(`Listed ${list.length} bill${list.length === 1 ? "" : "s"} ${listFrom ? "changed since the last run" : "(first run)"}.`);
} catch (e) {
  if (e instanceof RateLimited) { limited = true; console.warn("The API's hourly limit was reached while listing bills."); }
  else if (e instanceof NotFound) { state.listedAt = NOW; console.log(`Congress.gov has no bills for the ${ord(C)} Congress yet.`); }
  else throw e;
}

/* ---- 2. details for new and changed bills ---- */
const chunks = new Map(), touched = new Set();
function loadChunk(name) { if (!chunks.has(name)) chunks.set(name, readSite(`${base}/${name}`).then(j => j || {})); return chunks.get(name); }
async function fetchDetail(k) {
  const [t, n] = splitKey(k), p = `/bill/${C}/${t}/${n}`;
  let bill;
  try { bill = pick(await api(p), "bill"); }
  catch (e) { if (e instanceof NotFound) { delete B[k]; return; } throw e; }
  const sp = (bill.sponsors || [])[0] || {};
  const d = { label: label(t, n), url: billUrl(C, t, n), title: ent(bill.title), intro: day(bill.introducedDate),
    sp: sp.bioguideId ? [ent(sp.fullName), sp.bioguideId, sp.party || "", sp.state || ""] : null,
    cc: (bill.cosponsors && bill.cosponsors.count) || 0, area: (bill.policyArea && bill.policyArea.name) || "",
    la: bill.latestAction ? [day(bill.latestAction.actionDate), ent(bill.latestAction.text)] : null,
    cbo: (bill.cboCostEstimates || []).map(c => ({ title: ent(c.title).trim(), url: c.url, date: day(c.pubDate) })),
    laws: (bill.laws || []).map(l => `${/private/i.test(l.type) ? "Pvt.L." : "P.L."} ${l.number}`), fetched: TODAY };
  const actions = await apiAll(p + "/actions", "actions", {}, 2);
  d.stage = stageOf(actions);
  const seen = new Set();
  d.actions = actions.filter(a => KEEP_TYPES.has(a.type) || (a.recordedVotes || []).length).filter(a => { const x = `${a.actionDate}|${a.text}`; if (seen.has(x)) return false; seen.add(x); return true; })
    .slice(0, 25).map(a => [day(a.actionDate), ent(a.text), (a.recordedVotes || []).map(v => [v.chamber, +v.rollNumber, v.url])]);
  const sums = await apiAll(p + "/summaries", "summaries", {}, 1);
  const s = sums.sort((x, y) => String(x.actionDate || "").localeCompare(String(y.actionDate || "")) || String(x.updateDate || "").localeCompare(String(y.updateDate || ""))).pop();
  d.summary = s ? { date: day(s.actionDate), desc: s.actionDesc || "", ...paras(s.text) } : null;
  d.cosp = d.cc ? (await apiAll(p + "/cosponsors", "cosponsors", {}, 3)).filter(c => !c.sponsorshipWithdrawnDate).map(c => [c.bioguideId || c.bioguidId, c.party || "", c.state || "", /true/i.test(String(c.isOriginalCosponsor)) ? 1 : 0]) : [];
  d.related = (await apiAll(p + "/relatedbills", "relatedBills", {}, 1)).filter(r => TYPES[String(r.type).toLowerCase()]).slice(0, 12).map(r => {
    const rt = String(r.type).toLowerCase(); return [+r.congress, rt, +r.number, ent(r.title), [...new Set((r.relationshipDetails || []).map(x => x.type))]];
  });
  const tv = (await apiAll(p + "/text", "textVersions", {}, 1)).sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")))[0];
  if (tv) { const f = ty => ((tv.formats || []).find(x => x.type === ty) || {}).url; d.text = { type: tv.type || "", date: day(tv.date), url: f("Formatted Text") || f("PDF") || "", pdf: f("PDF") || "" }; }
  const parties = new Set([d.sp ? d.sp[2] : "", ...d.cosp.map(c => c[1])]);
  /* the row the policy area list shows, kept in state.json */
  Object.assign(B[k], { title: d.title, la: d.la, intro: d.intro, sp: d.sp, cc: d.cc, area: d.area, st: STAGES.indexOf(d.stage),
    bp: parties.has("D") && parties.has("R") ? 1 : 0, cbo: d.cbo.length ? 1 : 0, law: d.laws.join(" "), d: B[k].u || NOW });
  const name = chunkOf(k), chunk = await loadChunk(name);
  chunk[k] = d; touched.add(name);
}
const pending = Object.keys(B).filter(k => !B[k].d || B[k].d !== B[k].u)
  .sort((a, b) => (!!B[a].d - !!B[b].d) || String((B[b].la || [])[0] || "").localeCompare(String((B[a].la || [])[0] || "")));
let done = 0, failed = 0;
const out = () => limited || calls + 8 > BUDGET || (Date.now() - START) / 6e4 > MINUTES;
await pool(pending, 4, async k => {
  if (out()) return;
  try { await fetchDetail(k); done++; }
  catch (e) { if (e instanceof RateLimited) { if (!limited) console.warn("The API's hourly limit was reached; stopping for this run."); limited = true; } else { failed++; if (failed <= 20) console.warn(`${k}: ${e.message}`); } }
});

/* ---- 3. write the catalog ---- */
const files = new Map(); /* relative path -> content */
const put = (rel, obj) => files.set(rel, JSON.stringify(obj));
for (const name of touched) put(`${base}/${name}`, await chunks.get(name));
const keys = Object.keys(B);
const areaName = k => B[k].d ? (B[k].area || UNASSIGNED) : UNASSIGNED;
const areas = new Map();
for (const k of keys) { const a = areaName(k); if (!areas.has(a)) areas.set(a, []); areas.get(a).push(k); }
const byLatest = (a, b) => String((B[b].la || [])[0] || "").localeCompare(String((B[a].la || [])[0] || "")) || a.localeCompare(b, undefined, { numeric: true });
const areaList = [...areas.keys()].sort((a, b) => (a === UNASSIGNED) - (b === UNASSIGNED) || a.localeCompare(b));
for (const a of areaList) {
  const rows = areas.get(a).sort(byLatest).map(k => { const b = B[k];
    return [k, b.title || "", b.intro || null, (b.la || [])[0] || null, String((b.la || [])[1] || "").slice(0, 220), b.sp ? b.sp[0] : "", b.sp ? b.sp[1] : "", b.sp ? b.sp[2] : "", b.sp ? b.sp[3] : "",
      b.cc || 0, b.d ? b.st : -1, b.bp || 0, b.cbo || 0, b.law || ""]; });
  put(`${base}/area-${slug(a)}.json`, { congress: C, name: a, rows });
}
const nDetailed = keys.filter(k => B[k].d).length;
put(`${base}/index.json`, { congress: C, fetched: NOW, total: keys.length, detailed: nDetailed, stages: STAGES,
  areas: areaList.map(a => { const ks = areas.get(a); return { name: a, slug: slug(a), n: ks.length, passed: ks.filter(k => B[k].st >= 2 && B[k].d).length, law: ks.filter(k => B[k].st === 7).length }; }),
  bills: keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(k => [k, String(B[k].title || "").slice(0, 150), areaList.indexOf(areaName(k)), B[k].d ? B[k].st : -1]) });
const spons = {};
for (const k of keys) if (B[k].sp && B[k].sp[1]) (spons[B[k].sp[1]] = spons[B[k].sp[1]] || []).push(k);
for (const [id, ks] of Object.entries(spons)) put(`${base}/sponsors/${id}.json`, ks.sort(byLatest).map(k => [k, B[k].title || "", B[k].st, (B[k].la || [])[0] || null]));
/* Everyone's counts in one small file, for the Politicians pages: id -> [sponsored, passed a chamber, became law]. */
put(`${base}/sponsor-counts.json`, Object.fromEntries(Object.entries(spons).map(([id, ks]) => [id, [ks.length, ks.filter(k => B[k].st >= 2).length, ks.filter(k => B[k].st === 7).length]])));
const cong = (await readSite("catalog/congresses.json")) || {};
cong[C] = { fetched: NOW, total: keys.length, detailed: nDetailed };
put("catalog/congresses.json", cong);

/* Only files whose content changed are uploaded. state.json holds the fingerprints, so it's written last. */
const hash = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const upload = [];
const stamped = new Set([`${base}/index.json`, "catalog/congresses.json"]); /* these hold the build time, so they're compared without it */
const unstamp = s => s.replace(/"fetched":"[^"]*"/g, "");
for (const [rel, content] of files) { const h = hash(stamped.has(rel) ? unstamp(content) : content); if (state.hashes[rel] !== h) { upload.push(rel); state.hashes[rel] = h; } }
const stateRel = `${base}/state.json`;
if (upload.length || done || listed) { files.set(stateRel, JSON.stringify(state)); upload.push(stateRel); }
await fs.mkdir(outDir, { recursive: true });
for (const rel of upload) { const f = path.join(outDir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, files.get(rel)); }
await fs.writeFile(path.join(outDir, "upload.txt"), upload.join("\n") + "\n");
const left = keys.filter(k => !B[k].d || B[k].d !== B[k].u).length;
console.log(`${ord(C)} Congress: ${keys.length} bills, ${nDetailed} with details. Fetched ${done} this run${failed ? `, ${failed} failed` : ""}; ${left} still to fetch. ${calls} lookups. ${upload.length} files to upload.`);
