#!/usr/bin/env node
/* fetch-legislators.mjs
   Writes legislators.js, the service records behind the Politicians pages, from the congress-legislators dataset
   (https://github.com/unitedstates/congress-legislators, public domain).

   Usage:
     node fetch-legislators.mjs [siteDir]                downloads the dataset
     node fetch-legislators.mjs [siteDir] --data <dir>   reads legislators-current.json and legislators-historical.json from <dir>
   siteDir is the folder with politicians.js and bills.js (default: this folder). legislators.js is written there.
   Needs Node 18 or newer. Run it with fetch-congress.mjs; once a day is plenty.

   legislators.js holds:
     every member serving today (legislators-current),
     everyone named in politicians.js or on a bill in bills.js, matched by name,
     and anyone who left office during the current Congress.
   Names are matched on full name, first or nickname plus last name, and common nicknames (Chris = Christopher).
   A "st" in politicians.js narrows the match to people who served that state; an "id" (bioguide ID) skips matching.
   Names that don't match, or match more than one person, are listed at the end of the run and in legislators.js.
   If the download fails, legislators.js is left as it was. */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const BASE = "https://unitedstates.github.io/congress-legislators/";
const args = process.argv.slice(2);
const di = args.indexOf("--data");
const dataDir = di >= 0 ? args[di + 1] : null;
const siteDir = args.filter((a, i) => !(di >= 0 && (i === di || i === di + 1)))[0] || ".";
const TODAY = new Date().toISOString().slice(0, 10);

/* The current Congress began Jan 3 of the latest odd year. Members who left after that are kept, so they show as retired. */
let cy = +TODAY.slice(0, 4); if (cy % 2 === 0) cy--; if (`${cy}-01-03` > TODAY) cy -= 2;
const CONGRESS_START = `${cy}-01-03`;

/* ---- read the site's data files ---- */
async function loadScript(file, names) {
  let code;
  try { code = await fs.readFile(file, "utf8"); } catch { console.warn(`Not found, skipped: ${file}`); return {}; }
  const ctx = vm.createContext({ console });
  vm.runInContext(`${code}\n;globalThis.__out={${names.map(n => `${n}:typeof ${n}==="undefined"?undefined:${n}`).join(",")}};`, ctx, { filename: file });
  return ctx.__out;
}
const { POLS = {} } = await loadScript(path.join(siteDir, "politicians.js"), ["POLS"]);
const { BILLS = [] } = await loadScript(path.join(siteDir, "bills.js"), ["BILLS"]);

/* ---- get the dataset ---- */
async function getJSON(name) {
  if (dataDir) return JSON.parse(await fs.readFile(path.join(dataDir, name + ".json"), "utf8"));
  const res = await fetch(BASE + name + ".json", { headers: { "User-Agent": "FoundingFathers.earth legislators build" } });
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}
let current, historical;
try { [current, historical] = await Promise.all([getJSON("legislators-current"), getJSON("legislators-historical")]); }
catch (e) { console.error(`Couldn't get the dataset, so legislators.js was not changed. ${e.message}`); process.exit(1); }
if (!dataDir && current.length < 400) { console.error(`legislators-current has only ${current.length} members, which looks wrong. legislators.js was not changed.`); process.exit(1); }

/* Some records put the nickname in the first name, e.g. "Nicole (Nikki)". Move it to nickname. */
for (const r of [...current, ...historical]) {
  const n = r.name || (r.name = {}), m = String(n.first || "").match(/^(.*?)\s*\((.+)\)$/);
  if (m) { n.first = m[1]; if (!n.nickname) n.nickname = m[2]; }
}
const byId = new Map();
for (const r of historical) if (r.id && r.id.bioguide && r.terms && r.terms.length) byId.set(r.id.bioguide, { r, cur: false });
for (const r of current) if (r.id && r.id.bioguide && r.terms && r.terms.length) byId.set(r.id.bioguide, { r, cur: true });

/* ---- name matching ---- */
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/["“”‘’'.,()]/g, "").replace(/[-‐–]/g, " ").replace(/\s+/g, " ").trim();
const SUFFIX_RE = / (jr|sr|ii|iii|iv|v)$/;
const splitSuffix = k => { const m = k.match(SUFFIX_RE); return m ? [k.slice(0, m.index), m[1]] : [k, ""]; };
const NICK = { al:["albert","alan","alfred"], alex:["alexander","alexandra","alejandro"], andy:["andrew"], bernie:["bernard"], bill:["william"], billy:["william"],
  bob:["robert"], bobby:["robert"], brad:["bradley"], chris:["christopher","christine","christina"], chuck:["charles"], chip:["charles"], dan:["daniel"], danny:["daniel"],
  dave:["david"], dick:["richard"], don:["donald"], doug:["douglas"], ed:["edward","edwin"], gerry:["gerald"], greg:["gregory"], hank:["henry"], jim:["james"],
  jimmy:["james"], joe:["joseph"], jon:["jonathan"], ken:["kenneth"], larry:["lawrence"], liz:["elizabeth"], maggie:["margaret"], mike:["michael"], nick:["nicholas"],
  pat:["patrick","patricia"], pete:["peter"], rick:["richard"], rob:["robert"], ron:["ronald"], sam:["samuel"], steve:["steven","stephen"], ted:["edward","theodore"],
  tim:["timothy"], tom:["thomas"], tommy:["thomas"], tony:["anthony"], val:["valerie"], vic:["victor"], will:["william"] };

const fullIdx = new Map(), lastIdx = new Map();
const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
for (const [id, { r }] of byId) {
  const n = r.name || {};
  const firsts = [n.first, n.nickname].filter(Boolean);
  const lasts = [n.last, ...(n.other_names || []).map(o => o.last)].filter(Boolean);
  const keys = new Set([n.official_full]);
  for (const f of firsts) for (const l of lasts) { keys.add(`${f} ${l}`); if (n.middle) keys.add(`${f} ${n.middle} ${l}`); }
  for (const k of keys) if (k) add(fullIdx, splitSuffix(norm(k))[0], id);
  for (const l of lasts) add(lastIdx, norm(l), id);
}
/* First-name check for "Chris Murphy" style names. A first initial counts the middle name too ("W. Gregory Steube"). */
const firstOK = (qf, n) => [n.first, n.nickname, /^[A-Z]\.$/.test(n.first || "") ? n.middle : null].filter(Boolean).map(norm)
  .some(f => f === qf || (qf.length >= 3 && f.startsWith(qf)) || (NICK[qf] || []).includes(f));

/* Name shown for people the site doesn't name itself: nickname and last name if there's a nickname ("Bernie Sanders"),
   else the official full name without middle initials ("Marjorie Taylor Greene", "Richard Durbin"). */
const autoName = n => {
  if (n.nickname) return [n.nickname, n.last, n.suffix].filter(Boolean).join(" ");
  if (n.official_full) return n.official_full.split(" ").filter((t, i) => i === 0 || !/^[A-Z]\.$/.test(t)).join(" ");
  const first = /^[A-Z]\.$/.test(n.first || "") && n.middle ? `${n.first} ${n.middle}` : n.first;
  return [first, n.last, n.suffix].filter(Boolean).join(" ");
};
const yearSpan = r => `${r.terms[0].start.slice(0, 4)}–${r.terms[r.terms.length - 1].end.slice(0, 4)}`;
const label = id => { const { r } = byId.get(id); return `${autoName(r.name)} (${id}, ${r.terms[r.terms.length - 1].state}, ${yearSpan(r)})`; };

function resolve(name, hint) {
  if (hint.id) return byId.has(hint.id) ? { id: hint.id } : { err: `id ${hint.id} isn't in the dataset` };
  const [base, suf] = splitSuffix(norm(name));
  let cands = [...(fullIdx.get(base) || [])];
  if (!cands.length) {
    const t = base.split(" ");
    for (const l of [t.slice(1).join(" "), t[t.length - 1]]) {
      const ids = [...(lastIdx.get(l) || [])].filter(id => firstOK(t[0], byId.get(id).r.name));
      if (ids.length) { cands = ids; break; }
    }
  }
  if (!cands.length) return { err: "no one by that name in the dataset" };
  if (hint.st) {
    const inSt = cands.filter(id => byId.get(id).r.terms.some(x => x.state === hint.st));
    if (!inSt.length) return { err: `matched ${cands.map(label).join("; ")}, but not in ${hint.st}` };
    cands = inSt;
  }
  if (cands.length > 1) { /* "Sr." picks the record marked Sr., else the one with no suffix */
    const sfx = id => norm(byId.get(id).r.name.suffix);
    const same = cands.filter(id => sfx(id) === suf);
    if (same.length) cands = same; else if (suf) { const none = cands.filter(id => !sfx(id)); if (none.length) cands = none; }
  }
  if (cands.length > 1) { const c = cands.filter(id => byId.get(id).cur); if (c.length) cands = c; }
  if (cands.length > 1) return { err: `more than one match: ${cands.map(label).join("; ")}. Add id:"…" in politicians.js` };
  return { id: cands[0] };
}

const wanted = new Map(); /* name -> hint */
for (const [n, m] of Object.entries(POLS)) wanted.set(n, { id: m.id, st: m.st });
for (const b of BILLS) for (const n of b.people || []) if (!wanted.has(n)) wanted.set(n, {});
const names = {}, problems = [];
for (const [n, hint] of wanted) { const r = resolve(n, hint); if (r.id) names[n] = r.id; else problems.push([n, r.err]); }

/* ---- build the records ---- */
const PARTY_CODE = { Democrat:"D", Republican:"R", Independent:"I", Socialist:"S", "American Labor":"AL", "Democratic Republican":"DR", "Democratic-Republican":"DR" };
const pc = p => PARTY_CODE[p] || p || "";
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
function build(id) {
  const { r, cur } = byId.get(id);
  const terms = [];
  for (const t of r.terms) { /* consecutive terms in one chamber, for one party, become one stretch */
    const ch = t.type === "sen" ? "Senate" : "House", p = pc(t.party), L = terms[terms.length - 1];
    if (L && L[0] === ch && L[3] === p && days(L[2], t.start) <= 366) L[2] = t.end; else terms.push([ch, t.start, t.end, p]);
  }
  const last = r.terms[r.terms.length - 1];
  const o = { n: autoName(r.name), st: last.state, party: pc(last.party), terms };
  if (last.caucus && last.caucus !== last.party) o.caucus = pc(last.caucus);
  if (last.type === "rep" && last.district != null) o.dist = last.district;
  if (cur) o.cur = 1;
  if (r.id.lis) o.lis = r.id.lis; /* Senate.gov's member ID, used to match Senate roll call votes */
  return o;
}
const include = new Set(Object.values(names));
for (const [id, { r, cur }] of byId) if (cur || r.terms[r.terms.length - 1].end > CONGRESS_START) include.add(id);
const people = {};
for (const id of [...include].sort()) people[id] = build(id);

/* Display names: the name used on the site where there is one, else first (or nickname) and last name.
   Two people with the same name get their state added, e.g. "Mike Rogers (AL)". */
const aliasOf = {}; for (const [n, id] of Object.entries(names)) if (!aliasOf[id]) aliasOf[id] = n;
for (const id in people) if (aliasOf[id]) people[id].n = aliasOf[id];
const taken = new Map(); for (const id in people) { const k = norm(people[id].n); taken.set(k, (taken.get(k) || 0) + 1); }
for (const id in people) if (!aliasOf[id] && taken.get(norm(people[id].n)) > 1) people[id].n += ` (${people[id].st})`;

/* ---- write legislators.js ---- */
const nCur = Object.values(people).filter(p => p.cur).length;
const head = { fetched: new Date().toISOString(), source: "https://github.com/unitedstates/congress-legislators", congressStart: CONGRESS_START, current: nCur, total: Object.keys(people).length };
const out = `/* legislators.js, written by fetch-legislators.mjs. Don't edit it by hand: it's replaced on every run.
   Notes, exit reasons and party overrides go in politicians.js.
   Source: the congress-legislators dataset (public domain), ${head.source}
   people: bioguide ID -> {n: name shown, st, party, caucus (if it differs), dist (House district, 0 = at-large), cur (1 if serving), lis (Senate ID),
     terms: [[chamber, from, to, party]], consecutive terms merged}
   names: each name used in politicians.js or bills.js -> bioguide ID. problems: names that didn't match, and why. */
const LEGISLATORS = {
  ${Object.entries(head).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(", ")},
  names:${JSON.stringify(names, null, 0)},
  problems:${JSON.stringify(problems)},
  people:{
${Object.entries(people).map(([id, p]) => `    ${JSON.stringify(id)}:${JSON.stringify(p)}`).join(",\n")}
  }
};
`;
await fs.writeFile(path.join(siteDir, "legislators.js"), out);
console.log(`Wrote legislators.js: ${head.total} people, ${nCur} serving now. Matched ${Object.keys(names).length} of ${wanted.size} names from politicians.js and bills.js.`);
if (problems.length) { console.log(`\n${problems.length} name(s) need a look:`); for (const [n, e] of problems) console.log(`  ${n}: ${e}`); }
