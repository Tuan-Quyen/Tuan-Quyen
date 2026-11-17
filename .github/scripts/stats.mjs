// Builds the GitHub activity card (activity.svg) and a plain-text copy of the numbers
// inside README.md (for ATS / AI tools that ignore images).
// Data: GitHub GraphQL API (needs a token, e.g. GITHUB_TOKEN in Actions) + REST for stars/languages.
// Writes only when a number changes, so the hourly schedule does not create empty commits.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const USER = process.env.GH_USER || "Tuan-Quyen";
const README = process.env.README_PATH || "README.md";
const OUT = process.argv[2] || "activity.svg";
const TOKEN = process.env.GITHUB_TOKEN;
const headers = { Accept: "application/vnd.github+json", "User-Agent": "profile-stats" };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

async function rest(path, accept) {
  const res = await fetch(`https://api.github.com${path}`, { headers: accept ? { ...headers, Accept: accept } : headers });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}
async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

const now = new Date();
const YEAR = now.getUTCFullYear();

// ---------- contributions, one calendar year at a time (API limit is 1 year per query) ----------
const Q = `query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from, to:$to) {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      commitContributionsByRepository(maxRepositories:100) { repository { nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories:100) { repository { nameWithOwner } }
      issueContributionsByRepository(maxRepositories:100) { repository { nameWithOwner } }
    }
  }
}`;
const user = await rest(`/users/${USER}`);
const since = new Date(user.created_at).getUTCFullYear();

const perYear = {};
for (let y = since; y <= YEAR; y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === YEAR ? now.toISOString() : `${y}-12-31T23:59:59Z`;
  const c = (await gql(Q, { login: USER, from, to })).user.contributionsCollection;
  const repos = new Set([
    ...c.commitContributionsByRepository, ...c.pullRequestContributionsByRepository, ...c.issueContributionsByRepository,
  ].map(r => r.repository.nameWithOwner));
  perYear[y] = { commits: c.totalCommitContributions, prs: c.totalPullRequestContributions, issues: c.totalIssueContributions, repos };
}
const allRepos = new Set(Object.values(perYear).flatMap(v => [...v.repos]));
const sum = k => Object.values(perYear).reduce((a, v) => a + v[k], 0);

// ---------- stars (owned, non-fork public repos) ----------
const owned = (await rest(`/users/${USER}/repos?per_page=100&type=owner`)).filter(r => !r.fork && !r.private);
let starsTotal = 0, starsYear = 0;
for (const r of owned.filter(r => r.stargazers_count > 0)) {
  starsTotal += r.stargazers_count;
  const d = await gql(`query($o:String!,$n:String!){ repository(owner:$o,name:$n){ stargazers(first:100){ edges { starredAt } } } }`, { o: USER, n: r.name });
  starsYear += d.repository.stargazers.edges.filter(e => new Date(e.starredAt).getUTCFullYear() === YEAR).length;
}

const total = { stars: starsTotal, commits: sum("commits"), prs: sum("prs"), issues: sum("issues"), contributed: allRepos.size };
const year = { stars: starsYear, commits: perYear[YEAR].commits, prs: perYear[YEAR].prs, issues: perYear[YEAR].issues, contributed: perYear[YEAR].repos.size };

// ---------- languages (owned public repos, excluding the profile repo) ----------
const langBytes = {};
for (const r of owned.filter(r => r.name.toLowerCase() !== USER.toLowerCase())) {
  for (const [k, v] of Object.entries(await rest(`/repos/${USER}/${r.name}/languages`))) langBytes[k] = (langBytes[k] || 0) + v;
}
for (const k of ["CMake", "C++", "C", "Objective-C", "Ruby", "Shell", "HTML", "Batchfile", "Starlark"]) delete langBytes[k];
if ((langBytes.Swift || 0) < 50_000) delete langBytes.Swift;
const lt = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1;
let top = Object.entries(langBytes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, b]) => ({ name, pct: b / lt }));
const ts = top.reduce((a, l) => a + l.pct, 0) || 1;
top = top.map(l => ({ ...l, pct: l.pct / ts }));
const pct = l => `${Math.round(l.pct * 100)}%`;

// ---------- SVG ----------
const COLORS = ["#19C3A6", "#FFB547", "#9AA8FF", "#F2789F", "#5E74B8"];
const fmt = n => n.toLocaleString("en-US");
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ROWS = [
  ["stars", "Stars earned"],
  ["commits", "Commits"],
  ["prs", "Pull requests"],
  ["issues", "Issues"],
  ["contributed", "Contributed to (repos)"],
];
const CW = 1200, PAD = 48, GAP = 20, PW = (CW - PAD * 2 - GAP) / 2, ROW_H = 38, PANEL_TOP = 40;
const PANEL_H = 64 + ROWS.length * ROW_H + 8;
const FRAMES = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1];
const STEP = 0.09; // seconds per count-up frame

// count-up: stacked text frames; each intermediate frame is visible only while its animation runs
function counter(value, x, y, delay) {
  const vals = [...new Set(FRAMES.map(f => Math.round(value * f)))];
  return vals.map((v, i) => {
    const last = i === vals.length - 1;
    const d = (delay + i * STEP).toFixed(2);
    return `<text x="${x}" y="${y}" class="v ${last ? "fin" : "fr"}" text-anchor="end" style="animation-delay:${d}s">${fmt(v)}</text>`;
  }).join("");
}
function panel(title, data, px, accent, base) {
  const rows = ROWS.map(([k, label], i) => {
    const y = PANEL_TOP + 64 + i * ROW_H;
    const d = base + 0.25 + i * 0.12;
    return `<g class="row" style="animation-delay:${d.toFixed(2)}s">
      ${i ? `<line x1="${px + 24}" y1="${y - 26}" x2="${px + PW - 24}" y2="${y - 26}" stroke="#22366A"/>` : ""}
      <circle cx="${px + 30}" cy="${y - 5}" r="4" fill="${accent}"/>
      <text x="${px + 44}" y="${y}" class="k">${esc(label)}</text>
    </g>${counter(data[k], px + PW - 24, y, d + 0.1)}`;
  }).join("");
  return `<g class="pn" style="animation-delay:${base.toFixed(2)}s">
    <rect x="${px}" y="${PANEL_TOP}" width="${PW}" height="${PANEL_H}" rx="18" fill="#13224A" stroke="#22366A"/>
    <rect x="${px + 24}" y="${PANEL_TOP + 22}" width="28" height="4" rx="2" fill="${accent}"/>
    <text x="${px + 62}" y="${PANEL_TOP + 29}" class="t">${esc(title)}</text>
  </g>${rows}`;
}

const BAR_Y = PANEL_TOP + PANEL_H + 40;
const H = BAR_Y + 64;
const BW = CW - PAD * 2;
let bx = PAD;
const bar = top.map((l, i) => {
  const w = Math.max(6, l.pct * BW);
  const r = `<rect x="${bx.toFixed(1)}" y="${BAR_Y}" width="${(w - 4).toFixed(1)}" height="10" rx="5" fill="${COLORS[i]}"/>`;
  bx += w;
  return r;
}).join("");
let lx = PAD;
const legend = top.map((l, i) => {
  const g = `<circle cx="${lx + 5}" cy="${BAR_Y + 36}" r="5" fill="${COLORS[i]}"/><text x="${lx + 17}" y="${BAR_Y + 41}" class="lg">${esc(l.name)} <tspan class="lp">${pct(l)}</tspan></text>`;
  lx += 44 + (l.name.length + 4) * 8.4;
  return g;
}).join("");

const summary = `Total: ${total.stars} stars, ${total.commits} commits, ${total.prs} pull requests, ${total.issues} issues, contributed to ${total.contributed} repositories. ${YEAR}: ${year.stars} stars, ${year.commits} commits, ${year.prs} pull requests, ${year.issues} issues, contributed to ${year.contributed} repositories. Top languages: ${top.map(l => `${l.name} ${pct(l)}`).join(", ")}.`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${H}" viewBox="0 0 ${CW} ${H}" role="img" aria-label="GitHub activity. ${esc(summary)}">
  <defs>
    <pattern id="d" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#9AA8FF" fill-opacity=".16"/></pattern>
    <radialGradient id="g" cx="90%" cy="0%" r="60%"><stop offset="0" stop-color="#19C3A6" stop-opacity=".18"/><stop offset="1" stop-color="#19C3A6" stop-opacity="0"/></radialGradient>
    <clipPath id="barclip"><rect x="${PAD}" y="${BAR_Y - 2}" width="${BW}" height="14" class="grow"/></clipPath>
    <style>
      text { font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; }
      .t { font-size: 18px; font-weight: 700; fill: #FFFFFF; letter-spacing: .5px; }
      .k { font-size: 16px; fill: #C9D2E6; }
      .v { font-size: 20px; font-weight: 700; fill: #FFFFFF; font-variant-numeric: tabular-nums; }
      .s { font-size: 14px; fill: #A9B4CC; }
      .lg { font-size: 14px; fill: #C9D2E6; }
      .lp { fill: #8D9AB8; }
      .pn, .row, .fin { opacity: 0; animation: in .5s cubic-bezier(.2,.8,.2,1) forwards; }
      .fin { animation-duration: .01s; }
      .fr { opacity: 0; animation: blink ${STEP}s steps(1); }
      .grow { transform-origin: ${PAD}px 0; transform: scaleX(0); animation: grow 1.1s 1.2s cubic-bezier(.2,.8,.2,1) forwards; }
      .lgw { opacity: 0; animation: in .5s 1.6s ease-out forwards; }
      @keyframes in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @keyframes blink { from { opacity: 1; } to { opacity: 1; } }
      @keyframes grow { to { transform: scaleX(1); } }
      @media (prefers-reduced-motion: reduce) {
        .pn, .row, .fin, .lgw { animation: none; opacity: 1; }
        .fr { display: none; }
        .grow { animation: none; transform: none; }
      }
    </style>
  </defs>
  <rect width="${CW}" height="${H}" rx="22" fill="#0B1630"/>
  <rect width="${CW}" height="${H}" rx="22" fill="url(#d)"/>
  <rect width="${CW}" height="${H}" rx="22" fill="url(#g)"/>
  ${panel("TOTAL", total, PAD, COLORS[0], 0)}
  ${panel(String(YEAR), year, PAD + PW + GAP, COLORS[1], 0.15)}
  <text x="${PAD}" y="${BAR_Y - 14}" class="s lgw">Top languages across public repositories</text>
  <g clip-path="url(#barclip)">${bar}</g>
  <g class="lgw">${legend}</g>
</svg>
`;

// ---------- README: card + text copy ----------
const body = [
  `<img src="./${OUT}" width="100%" alt="GitHub activity. ${esc(summary)}">`,
  ``,
  `<details>`,
  `<summary>Activity data as text</summary>`,
  ``,
  `| | Stars earned | Commits | Pull requests | Issues | Contributed to (repos) |`,
  `|---|---|---|---|---|---|`,
  `| Total | ${fmt(total.stars)} | ${fmt(total.commits)} | ${fmt(total.prs)} | ${fmt(total.issues)} | ${fmt(total.contributed)} |`,
  `| ${YEAR} | ${fmt(year.stars)} | ${fmt(year.commits)} | ${fmt(year.prs)} | ${fmt(year.issues)} | ${fmt(year.contributed)} |`,
  ``,
  `Top languages: ${top.map(l => `${l.name} ${pct(l)}`).join(", ")}`,
  ``,
  `</details>`,
].join("\n");
const footer = `<sub>Counters come from the GitHub API and refresh hourly. Most of my professional work lives in private client repositories and is not counted here.</sub>`;
const START = "<!-- STATS:START (generated by .github/scripts/stats.mjs, do not edit) -->";
const re = /<!-- STATS:START[\s\S]*?<!-- STATS:END -->/;

if (!existsSync(README)) throw new Error(`${README} not found`);
const md = readFileSync(README, "utf8");
if (!re.test(md)) throw new Error("STATS markers not found in README");
const changed = !md.match(re)[0].includes(body) || !existsSync(OUT) || readFileSync(OUT, "utf8") !== svg;
if (changed) {
  writeFileSync(README, md.replace(re, `${START}\n${body}\n\n${footer}\n<!-- STATS:END -->`));
  writeFileSync(OUT, svg);
  console.log("Stats updated");
} else {
  console.log("No change in numbers; leaving files untouched");
}
console.log({ total, year, top });
