// Builds stats.svg for the profile README from the public GitHub REST API.
// Runs in GitHub Actions (GITHUB_TOKEN) or locally (unauthenticated, 60 req/h).
import { writeFileSync } from "node:fs";

const USER = process.env.GH_USER || "Tuan-Quyen";
const OUT = process.argv[2] || "stats.svg";
const headers = { Accept: "application/vnd.github+json", "User-Agent": "profile-stats" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function get(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

const year = new Date().getUTCFullYear();
const repos = (await get(`/users/${USER}/repos?per_page=100&type=owner`)).filter(r => !r.fork && !r.private);
const own = repos.filter(r => r.name.toLowerCase() !== USER.toLowerCase());

let commitsThisYear = 0;
try {
  const q = encodeURIComponent(`author:${USER} committer-date:>=${year}-01-01`);
  commitsThisYear = (await get(`/search/commits?q=${q}&per_page=1`)).total_count;
} catch (e) { console.warn("commit search failed:", e.message); }

const langBytes = {};
for (const r of own) {
  const langs = await get(`/repos/${USER}/${r.name}/languages`);
  for (const [k, v] of Object.entries(langs)) langBytes[k] = (langBytes[k] || 0) + v;
}
// Generated/platform glue, not languages anyone writes by hand
for (const k of ["CMake", "C++", "C", "Objective-C", "Ruby", "Shell", "HTML", "Batchfile", "Starlark", "Swift"]) {
  if (k === "Swift" && (langBytes[k] || 0) > 50_000) continue; // keep Swift only when it's real code
  delete langBytes[k];
}
const total = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1;
const top = Object.entries(langBytes).sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([name, bytes]) => ({ name, pct: bytes / total }));
const topSum = top.reduce((a, l) => a + l.pct, 0);
top.forEach(l => (l.pct = l.pct / topSum));

const stars = own.reduce((a, r) => a + r.stargazers_count, 0);
const active = own.filter(r => new Date(r.pushed_at).getUTCFullYear() === year).length;

const COLORS = ["#19C3A6", "#FFB547", "#9AA8FF", "#F2789F", "#5E74B8"];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const today = new Date().toISOString().slice(0, 10);

const metrics = [
  [own.length, "public projects"],
  [active, `active in ${year}`],
  [commitsThisYear, `public commits in ${year}`],
  [stars, "stars earned"],
];

let x = 64;
const barW = 1072;
const bar = top.map((l, i) => {
  const w = Math.max(4, l.pct * barW);
  const seg = `<rect x="${x.toFixed(1)}" y="196" width="${(w - 3).toFixed(1)}" height="12" rx="6" fill="${COLORS[i]}"/>`;
  x += w;
  return seg;
}).join("");
let lx = 64;
const legend = top.map((l, i) => {
  const label = `${esc(l.name)} ${(l.pct * 100).toFixed(0)}%`;
  const g = `<circle cx="${lx + 5}" cy="236" r="5" fill="${COLORS[i]}"/><text x="${lx + 16}" y="241" class="t" font-size="14" fill="#C9D2E6">${label}</text>`;
  lx += 34 + label.length * 8.2;
  return g;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="290" viewBox="0 0 1200 290" role="img" aria-label="GitHub activity: ${own.length} public projects, ${commitsThisYear} public commits in ${year}">
  <defs>
    <pattern id="d" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#9AA8FF" fill-opacity=".18"/></pattern>
    <style>
      .t { font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; }
      .m { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
      .n { opacity: 0; animation: up .7s cubic-bezier(.2,.8,.2,1) forwards; }
      @keyframes up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .n { animation: none; opacity: 1; } }
    </style>
  </defs>
  <rect width="1200" height="290" rx="22" fill="#0B1630"/>
  <rect width="1200" height="290" rx="22" fill="url(#d)"/>
  <circle cx="74" cy="46" r="5" fill="#19C3A6"/>
  <text x="90" y="51" class="m" font-size="14" fill="#19C3A6">github.activity</text>
  <text x="1136" y="51" class="m" font-size="12" fill="#6E7FA6" text-anchor="end">updated ${today}</text>
  ${metrics.map(([n, label], i) => `
  <g class="n" style="animation-delay:${i * 120}ms">
    <text x="${64 + i * 272}" y="122" class="t" font-size="52" font-weight="800" fill="#FFFFFF" letter-spacing="-1.5">${n}</text>
    <text x="${64 + i * 272}" y="150" class="t" font-size="16" fill="#A9B4CC">${esc(label)}</text>
  </g>`).join("")}
  <text x="64" y="184" class="m" font-size="12" fill="#6E7FA6">languages across public repos</text>
  ${bar}
  ${legend}
</svg>
`;
writeFileSync(OUT, svg);
console.log({ projects: own.length, active, commitsThisYear, stars, top });
