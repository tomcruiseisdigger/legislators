#!/usr/bin/env node
/* fetch-catalog.mjs
   Builds the "Bills by Policy Area" catalog: every bill and resolution in the current Congress, from the Congress.gov API.

   Usage:
     CONGRESS_API_KEY=... SITE_URL=https://foundingfathers.neocities.org node fetch-catalog.mjs [outDir]
   Options:
     --site-dir <dir>   read the previous catalog from a folder instead of SITE_URL (for testing)
     --mock <file.mjs>  answer API calls (and CBO pages) from a test file instead of the API
     --budget <n>       most API lookups this run (default 4000; the API allows 5,000 an hour per key)
     --minutes <n>      stop starting new bills after this many minutes (default 45)
     --cbo-max <n>      most CBO pages to read this run (default 300)
     --congress <n>     build a Congress other than the current one
     --force            check for changes even if the catalog was checked less than a day ago
   Writes into outDir (default catalog-out):
     catalog/congresses.json            the Congresses that have a catalog
     catalog/<C>/index.json             policy areas with counts, and a search list of every bill
     catalog/<C>/area-<slug>.json       one per policy area: a row for each bill, newest action first
     catalog/<C>/d/<type>-<n>.json      full details (summary, actions, cosponsors, related bills, text, CBO figures), 100 bill numbers a file
     catalog/<C>/fiscal.json            CBO figures for every bill with an estimate, for Famous Bills and the Data page
     catalog/<C>/sponsors/<id>.json     each member's sponsored bills
     catalog/<C>/sponsor-counts.json    every member's count of sponsored bills, for the Politicians pages
     catalog/<C>/state.json             what's been fetched, so the next run carries on
     upload.txt                         the files that changed this run, for the workflow to upload
   Each run first lists the bills Congress.gov changed since the last run, then fetches details for bills that are new or
   changed, newest activity first, until the budget or time runs out. The first catalog takes about a day of hourly runs.
   When a new Congress starts, the new one gets its own catalog and the last one stays on the site as an archive.

   CBO figures: for a bill with a CBO cost estimate, the run picks the estimate that matches the bill (see pickEstimate),
   reads the summary table on CBO's page, and keeps direct spending, revenues, the deficit change and spending subject to
   appropriation. Those set the Spending and Revenue marks on the site. An estimate that can't be matched cleanly gets no
   marks and a "check" note instead. If CBO's page can't be read, the note and the run's log say why (the HTTP status or
   network error). cbo-overrides.json, at the top of the site next to index.html, fixes the rare case the
   rules get wrong. For each Congress, give a bill key (hr1234, s55, ...) one of:
     {"use": "https://www.cbo.gov/publication/61234"}   use this estimate, even one Congress.gov doesn't list
     {"skip": ["https://www.cbo.gov/publication/60000"]} never use these estimates for this bill
     {"none": true}                                     show no marks for this bill
   Add "why": "..." to any of them; it's shown on the bill's page. Example: {"119": {"hr1234": {"use": "...", "why": "..."}}}.
   Changing a bill's entry makes the next run read it again. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.congress.gov/v3";
const KEY = process.env.CONGRESS_CATALOG_KEY || process.env.CONGRESS_API_KEY || "";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flagged = new Set(); ["--site-dir", "--mock", "--budget", "--minutes", "--congress", "--cbo-max"].forEach(n => { const i = args.indexOf(n); if (i >= 0) { flagged.add(i); flagged.add(i + 1); } });
const outDir = args.filter((a, i) => !flagged.has(i) && !a.startsWith("--"))[0] || "catalog-out";
const siteDir = opt("--site-dir", null), mockFile = opt("--mock", null);
const BUDGET = +opt("--budget", 4000), MINUTES = +opt("--minutes", 45), CBO_MAX = +opt("--cbo-max", 300);
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
const hash = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/* ---- CBO cost estimates ----
   PARSE_V: bump it when the reading rules change, and every bill with an estimate is read again on the next runs. */
const PARSE_V = 1;
const UA = `FoundingFathers.earth bill catalog${SITE_URL ? ` (${SITE_URL})` : ""}`;
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2}), (\\d{4})";
const isoOf = s => { const m = String(s || "").match(new RegExp(MONTH_RE, "i")); return m ? `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };
/* CBO pages use named entities that Congress.gov text doesn't. */
const entx = s => ent(String(s || "").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&minus;/g, "−").replace(/&[rl]squo;/g, "'").replace(/&[rl]dquo;/g, '"').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
const cellText = h => entx(String(h).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/* A table cell as millions of dollars. "*" is CBO's mark for less than $500,000 either way, counted as 0. Footnote letters are dropped. */
function cellNum(s) {
  let x = String(s || "").replace(/[,$\s]/g, "").replace(/[–—−]/g, "-");
  if (/^-?\*$/.test(x)) return 0;
  x = x.replace(/^(-?\d+(?:\.\d+)?)[a-z]{1,2}$/i, "$1");
  return /^-?\d+(\.\d+)?$/.test(x) ? +x : null;
}
const SPAN_RE = /^(\d{4})\s*[-–—]\s*(\d{4})$/;
/* Reads the version line and the "At a Glance" summary table from a CBO cost estimate page.
   Returns {title, ver, verDate, span, ds, rev, def, sap, sapSpan, ns, noTable}. Amounts are millions of dollars; null = not estimated. */
function parseCbo(html) {
  const body = String(html || "");
  const text = entx(body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|h\d|li|tr|td|th|span|section|header|time)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const verM = text.match(new RegExp(`(?:^|\\n)\\s*((?:As (?:ordered reported|reported|passed|introduced|enacted|amended|posted|cleared|specified|modified|approved|signed|provided|transmitted)|Public Law [\\d-]+ as enacted)[^\\n]{0,240}?${MONTH_RE})`, "i"));
  const out = { title: h1 ? cellText(h1[1]) : "", ver: verM ? verM[1].replace(/\s+/g, " ").trim() : "", verDate: verM ? isoOf(verM[1]) : null,
    span: "", ds: null, rev: null, def: null, sap: null, sapSpan: "", ns: false, noTable: false };
  for (const tb of body.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cellText)).filter(r => r.length);
    const find = re => rows.find(r => re.test(r[0] || ""));
    const dsR = find(/^direct spending/i), revR = find(/^revenues?\b/i), defR = find(/deficit/i), sapR = find(/subject to appropriation/i);
    if (!dsR && !revR && !defR) continue;
    const scale = /billions of dollars/i.test(cellText(tb)) ? 1000 : 1;
    const head = rows.find(r => r.some(c => SPAN_RE.test(c))) || [];
    const spanAt = j => { const h = head[head.length - 1 - j]; return h && SPAN_RE.test(h) ? h.replace(/\s*[-–—]\s*/, "–") : ""; }; /* j counts from the right */
    const last = r => { if (!r || r.length < 2) return null; const v = cellNum(r[r.length - 1]); return v === null ? null : v * scale; };
    out.span = spanAt(0); out.ds = last(dsR); out.rev = last(revR); out.def = last(defR);
    if (sapR) for (let j = 0; j < sapR.length - 1; j++) { const v = cellNum(sapR[sapR.length - 1 - j]); if (v !== null) { out.sap = v * scale; out.sapSpan = spanAt(j); break; } }
    return out;
  }
  if (/would not (significantly )?affect direct spending or revenues/i.test(text)) { out.ds = 0; out.rev = 0; out.def = 0; out.ns = true; return out; }
  out.noTable = true;
  return out;
}

/* Bill numbers named in an estimate's title, as [type, number]. "U.S." isn't read as a Senate bill. */
const LABEL_RE = /(?<![A-Za-z.])(H\.\s?R\.|S\.|H\.\s?J\.\s?Res\.|S\.\s?J\.\s?Res\.|H\.\s?Con\.\s?Res\.|S\.\s?Con\.\s?Res\.|H\.\s?Res\.|S\.\s?Res\.)\s?(\d+)/gi;
const estNums = t => [...String(t || "").matchAll(LABEL_RE)].map(m => [m[1].replace(/[.\s]/g, "").toLowerCase(), +m[2]]).filter(([t]) => TYPES[t]);
const titlePart = t => String(t || "").replace(LABEL_RE, " ").replace(/^\s*(estimated budgetary effects of|cost estimate for|budgetary effects of)\s+/i, " ")
  .replace(/^[\s,;:&–—-]+|^\s*(and|&)\s+/gi, " ").replace(/^[\s,;:&–—-]+/, "").trim();
const normT = s => String(s || "").toLowerCase().replace(/[’‘'`]/g, "").replace(/\bof (19|20)\d\d\b/g, " ").replace(/\b(the|a|an)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
/* Pick the estimate that belongs to this bill. A bill number can be reused for different text, so Congress.gov sometimes lists
   estimates for earlier contents too. Rules, in order: an override wins; an estimate titled for another bill number is never
   used; otherwise the estimate whose title matches the bill's current title (then one of its short titles), newest first. */
function pickEstimate(k, list, titles, ov) {
  const [t, n] = splitKey(k);
  if (ov && ov.use) return { est: list.find(e => e.url === ov.use) || { url: ov.use, title: ov.title || "", date: ov.date || null }, pinned: true };
  const skip = new Set((ov && ov.skip) || []), left = list.filter(e => !skip.has(e.url));
  if (!left.length) return { est: null, why: "Every CBO estimate Congress.gov lists for this bill is excluded in cbo-overrides.json." };
  const disp = normT(titles.display), shorts = titles.short.map(normT).filter(Boolean);
  const like = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 10 && (a.includes(b) || b.includes(a))));
  const scored = left.map(e => {
    const nums = estNums(e.title), mine = nums.some(([a, b]) => a === t && b === n);
    if (nums.length && !mine) return { e, s: 0, other: nums.map(([a, b]) => label(a, b)).join(" and ") };
    const tp = normT(titlePart(e.title));
    if (!tp) return { e, s: mine ? 1 : 0 };
    return { e, s: like(disp, tp) ? 3 : shorts.some(x => like(x, tp)) ? 2 : 0 };
  });
  const ok = scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s || String(b.e.date || "").localeCompare(String(a.e.date || "")));
  if (ok.length) return { est: ok[0].e };
  const other = scored.find(x => x.other);
  return { est: null, why: other
    ? `Congress.gov lists a CBO estimate titled for ${other.other}, not ${label(t, n)}. It may be a companion bill's estimate.`
    : `None of the ${left.length === 1 ? "CBO estimate" : `${left.length} CBO estimates`} Congress.gov lists has this bill's title, so the number may have been reused for different text.` };
}
/* The estimate's version line names a date (ordered reported on May 21, 2025, and so on). That step should be in the bill's own actions. */
function versionCheck(p, d, actions) {
  if (!p.verDate) return "";
  if (/public law|enacted/i.test(p.ver)) return (d.laws || []).length ? "" : `CBO's estimate covers a law as enacted, but Congress.gov lists no public law for ${d.label}.`;
  if (/posted on the website|rules committee print|transmitted/i.test(p.ver)) return "";
  const t = Date.parse(p.verDate), dates = [d.intro, ...actions.map(a => day(a.actionDate))].filter(Boolean);
  if (dates.some(x => Math.abs(Date.parse(x) - t) <= 3 * 864e5)) return "";
  return `CBO's estimate covers the version "${p.ver}", but ${d.label}'s Congress.gov actions show nothing near that date.`;
}
let cboRead = 0;
/* Why CBO page reads failed this run (reason -> count), and a few of them printed as they happen, so the log shows the cause. */
const cboWhy = {}, cboWarned = new Set();
const warnCbo = (url, msg) => { if (cboWarned.size < 5 || cboWarned.has(url)) { cboWarned.add(url); console.warn(`CBO page ${url}: ${msg}`); } };
async function getCboPage(url, pages) {
  const hit = pages[url]; if (hit && hit.v === PARSE_V) return hit;
  if (cboRead >= CBO_MAX) return null;
  cboRead++;
  let html = null, why = "";
  if (mock) html = await mock("cbo", { url });
  else for (let t = 1; t <= 3; t++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
      if (res.ok) { html = await res.text(); break; }
      why = `HTTP ${res.status}`;
      warnCbo(url, `${why} on try ${t} (server: ${res.headers.get("server") || "unknown"}; content-type: ${res.headers.get("content-type") || "unknown"})`);
      if (res.status === 404 || (res.status < 500 && res.status !== 429)) break;
    } catch (e) {
      why = `network error: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}`;
      warnCbo(url, `${why} on try ${t}`);
    }
    await sleep(3000 * t);
  }
  if (!mock) await sleep(400); /* go easy on cbo.gov */
  if (html == null) { why = why || "no response"; cboWhy[why] = (cboWhy[why] || 0) + 1; return { v: PARSE_V, err: true, why }; } /* not kept, so a later run tries again */
  const p = { v: PARSE_V, at: TODAY, ...parseCbo(html) }; pages[url] = p; return p;
}

/* ---- 1. the previous state, and what changed on Congress.gov ---- */
const base = `catalog/${C}`;
const state = (await readSite(`${base}/state.json`)) || { congress: C, listedAt: null, bills: {}, hashes: {} };
const B = state.bills, PAGES = state.cboPages || (state.cboPages = {});
/* Overrides. If the file can't be read, nothing is read again because of it; the last figures stay. */
let OVR = {}, ovOK = true;
try { const o = await readSite("cbo-overrides.json"); OVR = (o && (o[C] || o[String(C)])) || {}; }
catch (e) { ovOK = false; console.warn(`cbo-overrides.json couldn't be read, so it's ignored this run: ${e.message}`); }
const ovHash = k => hash(JSON.stringify(OVR[k] || null));
/* Bills whose CBO figures need reading: new or changed estimates, new reading rules, a changed override, or a page that failed before. */
function needsFiscal(k) {
  const b = B[k]; if (!b || !b.d) return false;
  const want = b.cbo || (OVR[k] && OVR[k].use);
  if (!want) return !!b.f;
  if (b.fp !== PARSE_V) return true;
  if (ovOK && b.fo !== ovHash(k)) return true;
  return !!(b.f && b.f[4] === 2 && b.ft !== TODAY);
}
/* Once every bill has details, a run does nothing until a day has passed since the last check. */
const caughtUp = Object.values(B).length && Object.values(B).every(b => b.d && b.d === b.u) && !Object.keys(B).some(needsFiscal);
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
/* Sets d.fiscal (shown on the bill's page) and B[k].f, the compact [direct spending, revenues, deficit, subject to appropriation, flag]
   that the policy area lists and fiscal.json carry. Flag: 0 marks shown, 1 check (no marks), 2 CBO's page couldn't be read, 3 none by hand.
   Returns "later" when this run has read its share of CBO pages; the bill is read on the next run. */
async function readFiscal(k, d, actions, titleList) {
  const ov = OVR[k] || null, b = B[k];
  const set = (f, fm) => { b.f = f; b.fm = fm; b.fp = PARSE_V; if (ovOK) b.fo = ovHash(k); };
  if (!(d.cbo || []).length && !(ov && ov.use)) { delete d.fiscal; set(null, null); return; }
  if (ov && ov.none) { const why = ov.why || "Marks turned off by hand in cbo-overrides.json."; d.fiscal = { flag: 3, why }; set([null, null, null, null, 3], [null, null, why]); return; }
  const pk = pickEstimate(k, d.cbo || [], { display: d.title, short: (titleList || []).filter(x => /short/i.test(x.titleType || "")).map(x => ent(x.title)) }, ov);
  if (!pk.est) { d.fiscal = { flag: 1, why: pk.why }; set([null, null, null, null, 1], [null, null, pk.why]); return; }
  const p = await getCboPage(pk.est.url, PAGES);
  if (!p) return "later";
  if (p.err) { const why = `CBO's page couldn't be read on the last try (${p.why || "no reason recorded"}). The next run tries again.`; d.fiscal = { flag: 2, why, url: pk.est.url, title: pk.est.title, date: pk.est.date }; set([null, null, null, null, 2], [pk.est.url, pk.est.date, why]); b.ft = TODAY; return; }
  let why = pk.pinned ? "" : versionCheck(p, d, actions || []);
  if (!why && p.noTable) why = "CBO's page has no standard summary table, so no marks were set. Open the estimate to see its figures.";
  const flag = why ? 1 : 0, date = pk.est.date || null;
  d.fiscal = { url: pk.est.url, title: pk.est.title || p.title, date, ver: p.ver, span: p.span, ds: p.ds, rev: p.rev, def: p.def, sap: p.sap, sapSpan: p.sapSpan,
    ns: p.ns, flag, why, pinned: !!pk.pinned, note: (ov && ov.why) || "" };
  set([p.ds, p.rev, p.def, p.sap, flag], [pk.est.url, date, why]);
}
const fiscalDone = new Set();
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
  /* CBO figures. Titles are only looked up for bills with an estimate to match. */
  const ov = OVR[k] || {};
  const titles = d.cbo.length && !ov.use && !ov.none ? await apiAll(p + "/titles", "titles", {}, 1) : [];
  if (await readFiscal(k, d, actions, titles) !== "later") fiscalDone.add(k);
  else { B[k].fp = null; const old = (await loadChunk(chunkOf(k)))[k]; if (old && old.fiscal) d.fiscal = old.fiscal; } /* keep the last figures until it's read again on the next run */
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

/* ---- 2b. CBO figures for bills whose details are already in the catalog ----
   Catches up bills fetched before CBO figures were added, and re-reads bills when an override or the reading rules change. */
const fiscalTodo = Object.keys(B).filter(k => !fiscalDone.has(k) && needsFiscal(k))
  .sort((a, b) => String((B[b].la || [])[0] || "").localeCompare(String((B[a].la || [])[0] || "")));
let fixed = 0, fiscalLeft = 0;
await pool(fiscalTodo, 2, async k => {
  if (out() || cboRead >= CBO_MAX) { fiscalLeft++; return; }
  try {
    const name = chunkOf(k), chunk = await loadChunk(name), d = chunk[k];
    if (!d) { B[k].d = null; return; } /* details are missing: fetch them again on the next run */
    const [t, n] = splitKey(k), p = `/bill/${C}/${t}/${n}`, ov = OVR[k] || {};
    const needApi = (d.cbo || []).length && !ov.use && !ov.none;
    const actions = needApi ? await apiAll(p + "/actions", "actions", {}, 2) : [];
    const titles = needApi ? await apiAll(p + "/titles", "titles", {}, 1) : [];
    if (await readFiscal(k, d, actions, titles) === "later") { fiscalLeft++; return; }
    touched.add(name); fixed++;
  } catch (e) { if (e instanceof RateLimited) { if (!limited) console.warn("The API's hourly limit was reached; stopping for this run."); limited = true; fiscalLeft++; } else { failed++; if (failed <= 20) console.warn(`${k} (CBO): ${e.message}`); } }
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
      b.cc || 0, b.d ? b.st : -1, b.bp || 0, b.cbo || 0, b.law || "", (b.d && b.f) || 0]; });
  put(`${base}/area-${slug(a)}.json`, { congress: C, name: a, rows });
}
const nDetailed = keys.filter(k => B[k].d).length;
put(`${base}/index.json`, { congress: C, fetched: NOW, total: keys.length, detailed: nDetailed, stages: STAGES,
  areas: areaList.map(a => { const ks = areas.get(a); return { name: a, slug: slug(a), n: ks.length, passed: ks.filter(k => B[k].st >= 2 && B[k].d).length, law: ks.filter(k => B[k].st === 7).length }; }),
  bills: keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(k => [k, String(B[k].title || "").slice(0, 150), areaList.indexOf(areaName(k)), B[k].d ? B[k].st : -1]) });
/* fiscal.json: key -> [direct spending, revenues, deficit, subject to appropriation, flag, estimate URL, estimate date, note]. */
const fiscal = {};
for (const k of keys) if (B[k].d && B[k].f) fiscal[k] = [...B[k].f, ...(B[k].fm || [null, null, ""])];
const nCbo = keys.filter(k => B[k].d && B[k].cbo).length, nRead = Object.keys(fiscal).length, nChecks = Object.values(fiscal).filter(f => f[4] === 1).length;
put(`${base}/fiscal.json`, { congress: C, v: PARSE_V, fetched: NOW, withEstimate: nCbo, bills: fiscal });
const spons = {};
for (const k of keys) if (B[k].sp && B[k].sp[1]) (spons[B[k].sp[1]] = spons[B[k].sp[1]] || []).push(k);
for (const [id, ks] of Object.entries(spons)) put(`${base}/sponsors/${id}.json`, ks.sort(byLatest).map(k => [k, B[k].title || "", B[k].st, (B[k].la || [])[0] || null]));
/* Everyone's counts in one small file, for the Politicians pages: id -> [sponsored, passed a chamber, became law]. */
put(`${base}/sponsor-counts.json`, Object.fromEntries(Object.entries(spons).map(([id, ks]) => [id, [ks.length, ks.filter(k => B[k].st >= 2).length, ks.filter(k => B[k].st === 7).length]])));
const cong = (await readSite("catalog/congresses.json")) || {};
cong[C] = { fetched: NOW, total: keys.length, detailed: nDetailed };
put("catalog/congresses.json", cong);
/* Keep only the CBO pages a bill still uses. */
const usedPages = new Set(keys.map(k => B[k].fm && B[k].fm[0]).filter(Boolean));
for (const u of Object.keys(PAGES)) if (!usedPages.has(u)) delete PAGES[u];

/* Only files whose content changed are uploaded. state.json holds the fingerprints, so it's written last. */
const upload = [];
const stamped = new Set([`${base}/index.json`, `${base}/fiscal.json`, "catalog/congresses.json"]); /* these hold the build time, so they're compared without it */
const unstamp = s => s.replace(/"fetched":"[^"]*"/g, "");
for (const [rel, content] of files) { const h = hash(stamped.has(rel) ? unstamp(content) : content); if (state.hashes[rel] !== h) { upload.push(rel); state.hashes[rel] = h; } }
const stateRel = `${base}/state.json`;
if (upload.length || done || listed || fixed) { files.set(stateRel, JSON.stringify(state)); upload.push(stateRel); }
await fs.mkdir(outDir, { recursive: true });
for (const rel of upload) { const f = path.join(outDir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, files.get(rel)); }
await fs.writeFile(path.join(outDir, "upload.txt"), upload.join("\n") + "\n");
const left = keys.filter(k => !B[k].d || B[k].d !== B[k].u).length;
console.log(`${ord(C)} Congress: ${keys.length} bills, ${nDetailed} with details. Fetched ${done} this run${failed ? `, ${failed} failed` : ""}; ${left} still to fetch. ${calls} lookups. ${upload.length} files to upload.`);
console.log(`CBO: ${nCbo} bills with an estimate, ${nRead} read (${nChecks} to check). ${cboRead} CBO pages read this run, ${fixed} older bills caught up${fiscalLeft ? `, ${fiscalLeft} left for the next run` : ""}.`);
const cboFails = Object.entries(cboWhy);
if (cboFails.length) console.log(`CBO pages that couldn't be read this run: ${cboFails.map(([w, c]) => `${w} x${c}`).join(", ")}.`);
