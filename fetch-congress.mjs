#!/usr/bin/env node
/* fetch-congress.mjs
   Writes billlive.js: the Congress.gov record for every bill number in BILL_IDS (billmeta.js).

   Usage:
     CONGRESS_API_KEY=... node fetch-congress.mjs [siteDir]
     node fetch-congress.mjs [siteDir] --mock mock.mjs      (testing: answers come from mock.mjs, not the API)
   siteDir holds billmeta.js, and the last billlive.js if there is one (default: this folder). billlive.js is written there.
   Get a free key at https://api.congress.gov/sign-up/. Needs Node 18 or newer.

   For each bill number it records:
     the bill itself: title, introduced date, sponsor, cosponsor count, policy area, latest action, CBO estimates, public law;
     cosp:      every current cosponsor [bioguide ID, party, state, date joined, 1 if original];
     related:   bills Congress.gov links to it (identical companions, related bills), with who linked them;
     actions:   floor, conference, presidential and law actions, newest first, with any roll call votes;
     stage:     the furthest step it has reached (introduced, reported, passed-house, passed-senate, passed-both, to-president, vetoed, law);
     summary:   the latest official summary by the Congressional Research Service, as plain paragraphs;
     text:      the latest text version and links to read it;
     subjects, committees.
   And for the whole site:
     votes:      each roll call vote on these bills, with totals and how every member voted. House votes come from the
                 Congress.gov House vote API (118th Congress on); Senate votes from Senate.gov.
     publicLaws: every public law of this Congress and the last, with the date it was enacted.
     crs:        CRS reports that cover these bills. The API can't search reports by bill, so each run reads up to
                 CRS_PER_RUN reports, oldest update first, and remembers where it stopped.
   If a lookup fails, the bill keeps what the last billlive.js had for it, marked stale. Roll call votes never change,
   so votes already in billlive.js aren't looked up again. */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const API = "https://api.congress.gov/v3";
const KEY = process.env.CONGRESS_API_KEY || process.env.CONGRESS_GOV_API_KEY || process.env.API_KEY || "";
const args = process.argv.slice(2);
const mi = args.indexOf("--mock");
const mockFile = mi >= 0 ? args[mi + 1] : null;
const siteDir = args.filter((a, i) => !(mi >= 0 && (i === mi || i === mi + 1)))[0] || ".";
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const CRS_START = "2023-01-01T00:00:00Z";   /* first run reads CRS reports updated since this date */
const CRS_PER_RUN = 1200;                   /* report lookups per run; keeps a run well under the 5,000-an-hour limit */
const SUMMARY_MAX = 4000;                    /* characters of a CRS summary kept; the rest is on Congress.gov */
const KEEP_TYPES = new Set(["Floor", "President", "BecameLaw", "Veto", "ResolvingDifferences", "Discharge"]);

if (!KEY && !mockFile) { console.error("No API key. Set CONGRESS_API_KEY (a free key from https://api.congress.gov/sign-up/)."); process.exit(1); }
let mock = null;
if (mockFile) mock = (await import(pathToFileURL(path.resolve(mockFile)).href)).default;

/* ---- the site's files ---- */
async function loadScript(file, names) {
  let code;
  try { code = await fs.readFile(file, "utf8"); } catch { return {}; }
  const ctx = vm.createContext({ console });
  vm.runInContext(`${code}\n;globalThis.__out={${names.map(n => `${n}:typeof ${n}==="undefined"?undefined:${n}`).join(",")}};`, ctx, { filename: file });
  return ctx.__out;
}
const { BILL_META = {}, BILL_IDS = {} } = await loadScript(path.join(siteDir, "billmeta.js"), ["BILL_META", "BILL_IDS"]);
const { BILL_LIVE: OLD = null } = await loadScript(path.join(siteDir, "billlive.js"), ["BILL_LIVE"]);
if (!Object.keys(BILL_IDS).length) { console.error("billmeta.js has no BILL_IDS, so there's nothing to look up. billlive.js was not changed."); process.exit(1); }

/* ---- HTTP ---- */
let calls = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class NotFound extends Error {}
async function api(p, params = {}) {
  calls++;
  if (mock) { const r = await mock(p, params); if (r === null || r === undefined) throw new NotFound(p); return r; }
  const u = new URL(API + p);
  for (const [k, v] of Object.entries({ format: "json", ...params })) u.searchParams.set(k, v);
  u.searchParams.set("api_key", KEY);
  for (let tryNo = 1; ; tryNo++) {
    let res;
    try { res = await fetch(u, { headers: { Accept: "application/json" } }); }
    catch (e) { if (tryNo >= 3) throw e; await sleep(2000 * tryNo); continue; }
    if (res.status === 404) throw new NotFound(p);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && tryNo < 4) { await sleep(res.status === 429 ? 60000 : 3000 * tryNo); continue; }
    throw new Error(`${p}: HTTP ${res.status}`);
  }
}
/* Every page of a list. key is the list's name in the response, e.g. "cosponsors". */
async function apiAll(p, key, params = {}, maxPages = 40) {
  const out = [];
  for (let page = 0, offset = 0; page < maxPages; page++) {
    const j = await api(p, { ...params, limit: 250, offset });
    const items = pick(j, key) || [];
    out.push(...items);
    if (items.length < 250 || !(j.pagination && j.pagination.next)) break;
    offset += 250;
  }
  return out;
}
async function getText(url) {
  calls++;
  if (mock) { const r = await mock(url, {}); if (r == null) throw new NotFound(url); return r; }
  const res = await fetch(url, { headers: { "User-Agent": "FoundingFathers.earth bill tracker" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
/* The first array or object found under any of the names given (the API's names vary in case). */
function pick(j, ...keys) {
  for (const k of keys) {
    if (!j) return undefined;
    const found = Object.keys(j).find(x => x.toLowerCase() === k.toLowerCase());
    if (found !== undefined) return j[found];
  }
  return undefined;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/* ---- bill numbers ---- */
const TYPES = { hr:["H.R.","house-bill"], s:["S.","senate-bill"], hjres:["H.J.Res.","house-joint-resolution"], sjres:["S.J.Res.","senate-joint-resolution"],
  hconres:["H.Con.Res.","house-concurrent-resolution"], sconres:["S.Con.Res.","senate-concurrent-resolution"], hres:["H.Res.","house-resolution"], sres:["S.Res.","senate-resolution"] };
const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"));
const label = (type, num) => `${TYPES[type][0]} ${num}`;
const billUrl = (cong, type, num) => `https://www.congress.gov/bill/${ord(cong)}-congress/${TYPES[type][1]}/${num}`;
const ent = s => String(s || "").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const day = d => d ? String(d).slice(0, 10) : null;
let cy = +TODAY.slice(0, 4); if (`${cy}-01-03` > TODAY) cy--; const CURRENT_CONG = Math.floor((cy - 1789) / 2) + 1;

const versions = [];
for (const [id, list] of Object.entries(BILL_IDS)) {
  const cong0 = (BILL_META[id] || [])[0];
  for (const spec of list) {
    const m = String(spec).toLowerCase().match(/^(?:(\d+)\/)?([a-z]+)(\d+)$/);
    if (!m || !TYPES[m[2]]) { console.warn(`BILL_IDS ${id}: can't read "${spec}"`); continue; }
    const cong = +(m[1] || cong0);
    if (!cong) { console.warn(`BILL_IDS ${id}: no Congress for "${spec}" (add it to BILL_META)`); continue; }
    versions.push({ id, cong, type: m[2], num: +m[3] });
  }
}
const oldOf = v => ((OLD && OLD.bills && OLD.bills[v.id]) || []).find(o => o.cong === v.cong && o.type === v.type && o.num === v.num);

/* ---- what one bill's actions add up to ---- */
function stageOf(actions) {
  const t = actions.map(a => `${a.type || ""} ${a.text || ""}`);
  const has = re => t.some(x => re.test(x));
  if (has(/Became Public Law|BecameLaw/)) return "law";
  if (has(/Vetoed by President|Pocket Vetoed/i) && !has(/Passed over veto/i)) return "vetoed";
  if (has(/Presented to President/i)) return "to-president";
  const h = has(/Passed\/agreed to in House|^Floor Passed House|On passage Passed|Passed House/i);
  const s = has(/Passed\/agreed to in Senate|Passed Senate/i);
  if (h && s) return "passed-both";
  if (h) return "passed-house";
  if (s) return "passed-senate";
  if (has(/Reported (by|to House|to Senate|with|without)|Ordered to be Reported|Placed on (the )?(Union|House|Senate Legislative) Calendar/i)) return "reported";
  return "introduced";
}
const tally = text => { const m = String(text || "").match(/(?:Vote|vote|Nays|votes)[.:]?\s*(\d+)\s*-\s*(\d+)/); return m ? [+m[1], +m[2]] : null; };
const voteKey = v => `${v.ch === "House" ? "h" : "s"}-${v.cong}-${v.sess}-${v.roll}`;
/* Official summary HTML as plain paragraphs; list items start with "• ". */
function paras(html) {
  const blocks = String(html || "").replace(/\r?\n/g, " ").split(/<\/(?:p|li|h\d|div)>|<br\s*\/?>/i)
    .map(b => (/<li[\s>]/i.test(b) ? "• " : "") + ent(b.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(b => b && b !== "•");
  const out = []; let n = 0, cut = false;
  for (const b of blocks) { if (n + b.length > SUMMARY_MAX && out.length) { cut = true; break; } out.push(b); n += b.length; }
  return { p: out, cut };
}

async function fetchVersion(v) {
  const base = `/bill/${v.cong}/${v.type}/${v.num}`;
  const old = oldOf(v);
  const e = { label: label(v.type, v.num), cong: v.cong, type: v.type, num: v.num, url: billUrl(v.cong, v.type, v.num) };
  let b;
  try { b = pick(await api(base), "bill"); }
  catch (err) {
    if (err instanceof NotFound) return { ...e, error: "not-found", fetched: TODAY };
    console.warn(`${e.label} (${v.id}): ${err.message}`);
    return old && !old.error ? { ...old, stale: true } : { ...e, error: "fetch-failed", fetched: TODAY };
  }
  const sp = (b.sponsors || [])[0] || {};
  Object.assign(e, {
    title: ent(b.title), intro: day(b.introducedDate), sponsor: sp.fullName || "", sponsorId: sp.bioguideId || "",
    cosponsors: (b.cosponsors && b.cosponsors.count) || 0, policy: (b.policyArea && b.policyArea.name) || "",
    latest: b.latestAction ? { date: day(b.latestAction.actionDate), text: ent(b.latestAction.text) } : null,
    cbo: (b.cboCostEstimates || []).map(c => ({ title: ent(c.title).trim(), url: c.url, date: day(c.pubDate) })),
    laws: (b.laws || []).map(l => `${/private/i.test(l.type) ? "Pvt.L." : "P.L."} ${l.number}`),
    updated: day(b.updateDate), fetched: TODAY
  });
  /* The rest are separate lookups. One that fails keeps what the last run found. */
  const part = async (name, fn) => { try { await fn(); } catch (err) { if (old && old[name] !== undefined) { e[name] = old[name]; e.stale = true; } if (!(err instanceof NotFound)) console.warn(`${e.label} ${name}: ${err.message}`); } };
  await part("cosp", async () => {
    const list = await apiAll(base + "/cosponsors", "cosponsors");
    e.cosp = list.filter(c => !c.sponsorshipWithdrawnDate).map(c => [c.bioguideId || c.bioguidId, c.party || "", c.state || "", day(c.sponsorshipDate), /true/i.test(String(c.isOriginalCosponsor)) ? 1 : 0]);
    const w = list.length - e.cosp.length; if (w) e.cospWithdrawn = w;
  });
  await part("related", async () => {
    const list = await apiAll(base + "/relatedbills", "relatedBills");
    e.related = list.filter(r => TYPES[String(r.type).toLowerCase()]).map(r => {
      const t = String(r.type).toLowerCase(), la = r.latestAction || r.lastestAction;
      const det = r.relationshipDetails || [];
      return { label: label(t, r.number), cong: +r.congress, type: t, num: +r.number, title: ent(r.title), url: billUrl(+r.congress, t, r.number),
        rel: [...new Set(det.map(d => d.type))], by: [...new Set(det.map(d => d.identifiedBy))], latest: la ? { date: day(la.actionDate), text: ent(la.text) } : null };
    });
  });
  await part("actions", async () => {
    const list = await apiAll(base + "/actions", "actions", {}, 10);
    e.stage = stageOf(list);
    const seen = new Set(), votes = new Map(), keep = [];
    for (const a of list) {
      const rv = a.recordedVotes || [];
      if (!KEEP_TYPES.has(a.type) && !rv.length) continue;
      const k = `${day(a.actionDate)}|${a.text}`; if (seen.has(k)) continue; seen.add(k);
      const vs = rv.map(r => ({ ch: r.chamber, cong: +r.congress, sess: +r.sessionNumber, roll: +r.rollNumber, date: day(r.date), url: r.url }));
      vs.forEach(x => votes.set(voteKey(x), { ...x, text: ent(a.text) }));
      keep.push({ date: day(a.actionDate), type: a.type, text: ent(a.text), votes: vs.map(voteKey) });
    }
    e.actions = keep.slice(0, 40);
    e.voteRefs = [...votes.values()];
  });
  await part("summary", async () => {
    const list = await apiAll(base + "/summaries", "summaries");
    const s = list.sort((x, y) => String(x.actionDate || "").localeCompare(String(y.actionDate || "")) || String(x.updateDate || "").localeCompare(String(y.updateDate || ""))).pop();
    e.summary = s ? { date: day(s.actionDate), desc: s.actionDesc || "", ...paras(s.text) } : null;
  });
  await part("text", async () => {
    const list = await apiAll(base + "/text", "textVersions");
    const t = list.sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")))[0];
    if (!t) { e.text = null; return; }
    const f = type => ((t.formats || []).find(x => x.type === type) || {}).url;
    e.text = { type: t.type || "", date: day(t.date), url: f("Formatted Text") || f("PDF") || f("Formatted XML") || "", pdf: f("PDF") || "" };
  });
  await part("subjects", async () => {
    const j = await api(base + "/subjects", { limit: 250 });
    const s = pick(j, "subjects") || {};
    e.subjects = (s.legislativeSubjects || []).map(x => x.name).filter(Boolean);
  });
  await part("committees", async () => {
    const list = await apiAll(base + "/committees", "committees");
    e.committees = list.map(c => ({ name: c.name, chamber: c.chamber }));
  });
  return e;
}

/* ---- roll call votes ---- */
const castCode = c => /^(yea|aye|yes)$/i.test(c) ? "Y" : /^(nay|no)$/i.test(c) ? "N" : /present/i.test(c) ? "P" : "X";
async function houseVote(r) {
  const p = `/house-vote/${r.cong}/${r.sess}/${r.roll}`;
  const v = pick(await api(p), "houseRollCallVote") || {};
  const totals = {};
  for (const t of v.votePartyTotal || []) {
    const party = (t.party && (t.party.type || t.party.name)) || t.voteParty || "?";
    totals[party] = [+t.yeaTotal || 0, +t.nayTotal || 0, +t.presentTotal || 0, +t.notVotingTotal || 0];
  }
  const mv = pick(await api(p + "/members", { limit: 500 }), "houseRollCallVoteMemberVotes") || {};
  const members = { Y: [], N: [], P: [], X: [] };
  for (const m of mv.results || []) members[castCode(m.voteCast)].push(m.bioguideID || m.bioguideId);
  return { q: v.voteQuestion || "", result: v.result || "", totals, members, ids: "bioguide" };
}
async function senateVote(r) {
  const xml = await getText(r.url);
  const tag = (s, t) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? ent(m[1]).trim() : ""; };
  const members = { Y: [], N: [], P: [], X: [] }, totals = {};
  for (const m of xml.match(/<member>[\s\S]*?<\/member>/g) || []) {
    const c = castCode(tag(m, "vote_cast")), party = tag(m, "party") || "?";
    members[c].push(tag(m, "lis_member_id"));
    const t = totals[party] || (totals[party] = [0, 0, 0, 0]); t["YNPX".indexOf(c)]++;
  }
  return { q: tag(xml, "vote_question_text") || tag(xml, "question"), result: tag(xml, "vote_result_text") || tag(xml, "vote_result"), totals, members, ids: "lis" };
}

/* ---- public laws ---- */
async function publicLaws() {
  const out = [];
  for (const cong of [CURRENT_CONG - 1, CURRENT_CONG]) {
    const list = await apiAll(`/law/${cong}`, "bills");
    for (const b of list) for (const l of b.laws || []) {
      if (!/public/i.test(l.type)) continue;
      const t = String(b.type).toLowerCase(), la = b.latestAction || {};
      out.push([l.number, day(la.actionDate), TYPES[t] ? label(t, b.number) : `${b.type} ${b.number}`, ent(b.title)]);
    }
  }
  return out.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || a[0].localeCompare(b[0], undefined, { numeric: true }));
}

/* ---- CRS reports that cover these bills ---- */
async function crsReports(keys) {
  const prev = (OLD && OLD.crs) || {};
  const reports = { ...(prev.reports || {}) };
  const prevKeys = new Set(prev.keys || []);
  /* A bill added to BILL_IDS since the last run means older reports have to be read again for it. */
  const restart = [...keys].some(k => !prevKeys.has(k));
  const from = restart || !prev.cursor ? CRS_START : prev.cursor;
  const list = (await apiAll("/crsreport", "CRSReports", { fromDateTime: from, toDateTime: NOW.replace(/\.\d+Z$/, "Z") }, 60))
    .sort((a, b) => String(a.updateDate).localeCompare(String(b.updateDate)));
  const batch = list.slice(0, CRS_PER_RUN);
  await pool(batch, 4, async r => {
    try {
      const d = pick(await api(`/crsreport/${r.id}`), "CRSReport") || {};
      const hits = (d.relatedMaterials || []).map(m => {
        const t = String(m.type || "").toLowerCase();
        if (t === "pub" || t === "public law") return `pl-${m.number}`;
        return TYPES[t] ? `${m.congress}-${t}-${m.number}` : null;
      }).filter(k => k && keys.has(k));
      if (hits.length) {
        const pdf = (d.formats || []).find(f => /pdf/i.test(f.format || f.type || ""));
        const u = String(d.url || r.url || "").replace(/^(?!https?:)/, "https://");
        reports[r.id] = { t: ent(d.title || r.title), d: day(d.publishDate || r.publishDate), u: u.includes("api.congress.gov") ? `https://www.congress.gov/crs-product/${r.id}` : u, pdf: pdf ? pdf.url : "", b: [...new Set(hits)] };
      }
    } catch (err) { if (!(err instanceof NotFound)) console.warn(`CRS ${r.id}: ${err.message}`); }
  });
  const done = batch.length === list.length;
  return { cursor: done ? NOW.replace(/\.\d+Z$/, "Z") : batch[batch.length - 1].updateDate, keys: [...keys].sort(), reports,
    progress: done ? "up to date" : `read ${batch.length} of ${list.length} reports updated since ${day(from)}; continues next run` };
}

/* ---- run ---- */
const bills = {};
const entries = await pool(versions, 4, fetchVersion);
versions.forEach((v, i) => (bills[v.id] = bills[v.id] || []).push(entries[i]));

const votes = { ...((OLD && OLD.votes) || {}) };
const refs = new Map(); entries.forEach(e => (e.voteRefs || []).forEach(r => refs.set(voteKey(r), r)));
await pool([...refs.entries()], 3, async ([k, r]) => {
  if (votes[k] && !votes[k].error) return;
  const base = { ch: r.ch, cong: r.cong, sess: r.sess, roll: r.roll, date: r.date, url: r.url, tally: tally(r.text) };
  try {
    if (r.ch === "House" && r.cong >= 118) votes[k] = { ...base, ...(await houseVote(r)) };
    else if (r.ch === "Senate" && r.url) votes[k] = { ...base, ...(await senateVote(r)) };
    else votes[k] = base;
  } catch (err) { console.warn(`Vote ${k}: ${err.message}`); votes[k] = { ...base, error: "fetch-failed" }; }
});
entries.forEach(e => delete e.voteRefs);
const used = new Set(entries.flatMap(e => (e.actions || []).flatMap(a => a.votes || [])));
for (const k of Object.keys(votes)) if (!used.has(k)) delete votes[k]; /* drop votes no listed bill points to any more */

let laws = (OLD && OLD.publicLaws) || [];
try { laws = await publicLaws(); } catch (err) { console.warn(`Public laws: ${err.message}`); }

const keys = new Set();
for (const v of versions) keys.add(`${v.cong}-${v.type}-${v.num}`);
for (const e of entries) for (const l of e.laws || []) keys.add(`pl-${l.replace(/^\S+\s/, "")}`);
let crs = (OLD && OLD.crs) || null;
try { crs = await crsReports(keys); } catch (err) { console.warn(`CRS reports: ${err.message}`); }

const nOk = entries.filter(e => !e.error).length, nFail = entries.filter(e => e.error === "fetch-failed" || e.stale).length;
const out = `/* ---------------- BILL LIVE ----------------
   The Congress.gov record for each bill number in BILL_IDS (billmeta.js), written by fetch-congress.mjs.
   Don't edit by hand: the next run replaces this file. To change which bills are looked up, edit BILL_IDS.
   index.html shows this on each bill's page and works without it.
   bills: id -> one entry per bill number. votes: roll call votes on those bills. publicLaws: [law, date enacted, bill, title].
   crs: CRS reports that cover these bills, found by reading reports a batch at a time. */
const BILL_LIVE = {
  fetched: ${JSON.stringify(NOW)},
  source: "Congress.gov API (api.congress.gov/v3), Library of Congress; Senate roll call votes from Senate.gov",
  congress: ${CURRENT_CONG},
  bills: {
${Object.entries(bills).map(([id, list]) => `    ${JSON.stringify(id)}: ${JSON.stringify(list)}`).join(",\n")}
  },
  votes: {
${Object.entries(votes).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}
  },
  publicLaws: ${JSON.stringify(laws)},
  crs: ${JSON.stringify(crs)}
};
`;
await fs.writeFile(path.join(siteDir, "billlive.js"), out);
console.log(`Wrote billlive.js: ${nOk} of ${entries.length} bill numbers found, ${refs.size} roll call votes, ${laws.length} public laws, ${crs ? Object.keys(crs.reports).length : 0} CRS reports (${crs ? crs.progress : "not read"}). ${calls} lookups.`);
if (nFail) console.log(`${nFail} bill number(s) couldn't be fully updated and kept their last record.`);
