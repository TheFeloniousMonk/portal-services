// Builds the static site served at https://agentdata.network (GitHub Pages).
//
// For every service folder with a card.json, it writes the three URLs the card
// names, so the card never has to change:
//   /<id>/                          docs: the card summary plus the service README
//   /<id>/openapi/v1/openapi.json   the backend's own openapi.json, byte for byte
//   /<id>/operators                 supplier docs, from the card's serving block
// plus an index at / and the CNAME that binds the domain.
//
// Usage: node build.mjs [outDir]   (default: dist)

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const SITE = "https://agentdata.network";
const DOMAIN = "agentdata.network";
const REPO = "https://github.com/TheFeloniousMonk/portal-services";
const IMAGE = "ghcr.io/thefeloniousmonk";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, process.argv[2] || "dist");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const read = (p) => readFileSync(p, "utf8");

function write(rel, body) {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

// Services are the folders holding a card.json, except clones of other repos.
const services = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "card.json")))
  .map((d) => d.name)
  .filter((id) => !existsSync(join(root, id, ".git")))
  .sort()
  .map(load);

function load(id) {
  const dir = join(root, id);
  const card = JSON.parse(read(join(dir, "card.json")));
  const readme = read(join(dir, "README.md"));
  const h1 = readme.match(/^#\s+(.+)$/m);
  const name = h1 ? h1[1].replace(/\s*\(`[^`]+`\)\s*$/, "").replace(/`/g, "").trim() : id;
  const specFile = join(dir, "backend", "openapi.json");
  const config = existsSync(join(dir, "backend", "config.js")) ? read(join(dir, "backend", "config.js")) : "";
  const version = (config.match(/version:\s*"(\d+\.\d+\.\d+)"/) || [])[1];
  return { id, dir, card, readme, name, spec: existsSync(specFile) ? read(specFile) : null, version };
}

// Check that each card points where this site will serve, so a renamed folder
// or an edited card cannot publish to a URL the card does not name.
for (const s of services) {
  const want = {
    docs: `${SITE}/${s.id}/`,
    "serving.docs": `${SITE}/${s.id}/operators`,
    "specs[0].url": `${SITE}/${s.id}/openapi/v1/openapi.json`,
  };
  const have = { docs: s.card.docs, "serving.docs": s.card.serving?.docs, "specs[0].url": s.card.specs?.[0]?.url };
  for (const k of Object.keys(want)) {
    if (have[k] !== want[k]) console.warn(`warn: ${s.id} card ${k} is ${have[k]}, site serves ${want[k]}`);
  }
  if (!s.spec) console.warn(`warn: ${s.id} has no backend/openapi.json`);
}

// README links are relative to the service folder on GitHub. Point them at the
// repository, and drop links that leave the repository (they would 404).
function renderReadme(s) {
  const md = s.readme.replace(/^#\s+.+\n/, ""); // the page supplies its own title
  const renderer = new marked.Renderer();
  const link = renderer.link.bind(renderer);
  renderer.link = function (tok) {
    const href = tok.href || "";
    if (/^(https?:|mailto:|#)/.test(href)) return link(tok);
    const resolved = posix.normalize(posix.join(s.id, href));
    if (resolved.startsWith("..")) return this.parser.parseInline(tok.tokens);
    const kind = href.endsWith("/") ? "tree" : "blob";
    return link({ ...tok, href: `${REPO}/${kind}/main/${resolved.replace(/\/$/, "")}` });
  };
  return marked.parse(md, { renderer, gfm: true });
}

const firstSentence = (t) => (t.match(/^.*?[.!?](\s|$)/) || [t])[0].trim();

function page({ title, description, path, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<style>
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#62625d;--line:#e3e3df;--code:#f1f1ee;--link:#1d5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e4;--muted:#a0a09a;--line:#2c2c2a;--code:#1f1f1e;--link:#7fb0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header.top{border-bottom:1px solid var(--line);padding:12px 16px}
header.top div{max-width:860px;margin:0 auto;display:flex;gap:16px;flex-wrap:wrap;font-size:14px}
a{color:var(--link)}
header.top a{text-decoration:none}
h1{font-size:30px;line-height:1.25;margin:0 0 8px}
h2{font-size:21px;margin:36px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:24px 0 6px}
.lede{color:var(--muted);margin:0 0 20px}
.links{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 24px}
.links a{border:1px solid var(--line);border-radius:6px;padding:4px 10px;text-decoration:none;font-size:14px}
code,pre{font:13.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);border-radius:4px}
code{padding:1px 4px}
pre{padding:12px 14px;overflow-x:auto}
pre code{padding:0;background:none}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:14.5px;margin:12px 0}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--code)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
dt{color:var(--muted)}dd{margin:0}
.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 16px}
.card h2{border:0;margin:0 0 4px;padding:0}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
footer{color:var(--muted);font-size:13px;margin-top:48px;border-top:1px solid var(--line);padding-top:16px}
@media (max-width:560px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
</style>
</head>
<body>
<header class="top"><div><a href="/"><strong>agentdata.network</strong></a><a href="${REPO}">Source</a></div></header>
<main>
${body}
<footer>Services on <a href="https://pocket.network">Pocket Network</a>, maintained by TheFeloniousMonk. Not a Pocket Network Foundation project. Report problems in the <a href="${REPO}/issues">repository's issues</a>.</footer>
</main>
</body>
</html>
`;
}

function links(s, current) {
  const items = [
    ["docs", `/${s.id}/`, "Docs"],
    ["spec", `/${s.id}/openapi/v1/openapi.json`, "OpenAPI"],
    ["ops", `/${s.id}/operators`, "Operators"],
    ["src", `${REPO}/tree/main/${s.id}`, "Source"],
  ].filter(([k]) => k !== current && (k !== "spec" || s.spec));
  return `<p class="links">${items.map(([, h, t]) => `<a href="${h}">${t}</a>`).join("")}</p>`;
}

function docsPage(s) {
  const c = s.card;
  const body = `<h1>${esc(s.name)}</h1>
<p class="lede">Service ID <code>${esc(s.id)}</code> · ${esc(c.rpc_types.map((r) => r.type).join(", "))} · results ${esc(c.results)} · ${esc(c.access)}</p>
${links(s, "docs")}
${renderReadme(s)}`;
  return page({ title: `${s.name} (${s.id})`, description: firstSentence(c.description), path: `/${s.id}/`, body });
}

function operatorsPage(s) {
  const sv = s.card.serving || {};
  const facts = [
    ["Service ID", `<code>${esc(s.id)}</code>`],
    ["Required version", (sv.implementations || []).map((v) => `<code>${esc(v)}</code>`).join(", ")],
    ["Image", s.version ? `<code>${IMAGE}/${esc(s.id)}:${esc(s.version)}</code>` : ""],
    ["Minimum RAM", sv.min_ram_gb ? `${sv.min_ram_gb} GB` : ""],
    ["Minimum disk", sv.min_disk_gb ? `${sv.min_disk_gb} GB` : ""],
    ["RPC types", s.card.rpc_types.map((r) => `${esc(r.type)} (${esc(r.intent)})`).join(", ")],
  ].filter(([, v]) => v);
  const rpc = s.card.rpc_types
    .map((r) => `<h3>${esc(r.type)}</h3>${r.backend_hint ? `<p><strong>Backend:</strong> ${esc(r.backend_hint)}</p>` : ""}${r.notes ? `<p>${esc(r.notes)}</p>` : ""}`)
    .join("");
  const checks = (sv.healthcheck || [])
    .map((h) => `<tr><td>${esc(h.rpc_type)}</td><td><code>${esc(h.request.method)} ${esc(h.request.path)}</code>${h.request.body ? `<br><code>${esc(JSON.stringify(h.request.body))}</code>` : ""}</td><td><code>${esc(h.expect.json_path)}</code> matches <code>${esc(h.expect.matches)}</code></td><td>${esc(h.notes || "")}</td></tr>`)
    .join("");
  const deploy = existsSync(join(s.dir, "deploy")) ? readdirSync(join(s.dir, "deploy")).filter((f) => !f.startsWith(".")) : [];
  const body = `<h1>${esc(s.name)}: operators</h1>
<p class="lede">What a supplier needs to serve <code>${esc(s.id)}</code>.</p>
${links(s, "ops")}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Backend</h2>
<p>${esc(sv.backend || "")}</p>
${rpc}
${sv.notes ? `<h2>Notes</h2><p>${esc(sv.notes)}</p>` : ""}
${checks ? `<h2>Health checks</h2><table><thead><tr><th>Type</th><th>Request</th><th>Expect</th><th>Why</th></tr></thead><tbody>${checks}</tbody></table>` : ""}
<h2>Running it</h2>
<p>Build the backend from <a href="${REPO}/tree/main/${s.id}/backend">backend/</a>${s.version ? `, or pull the published image:</p><pre><code>docker pull ${IMAGE}/${esc(s.id)}:${esc(s.version)}</code></pre><p>` : ". "}Images are tagged with the version the backend reports at <code>GET /v1/version</code>. Keep up with the required version above; an older backend can reject requests that newer callers send.</p>
${deploy.length ? `<p>The service's <a href="${REPO}/tree/main/${s.id}/deploy">deploy/</a> folder has:</p><ul>${deploy.map((f) => `<li><a href="${REPO}/${f.includes(".") ? "blob" : "tree"}/main/${s.id}/deploy/${encodeURIComponent(f)}">${esc(f)}</a></li>`).join("")}</ul>` : ""}
<p>The service's <a href="/${s.id}/">docs</a> cover its settings and anything a supplier must provide.</p>`;
  return page({ title: `${s.name} (${s.id}): operators`, description: `Supplier requirements for the ${s.id} service on Pocket Network.`, path: `/${s.id}/operators`, body });
}

function indexPage() {
  const body = `<h1>agentdata.network</h1>
<p class="lede">REST data services for agents on <a href="https://pocket.network">Pocket Network</a>. Each is a pass-through backend that suppliers run behind the RelayMiner; agents pay per request.</p>
${services
  .map((s) => `<div class="card"><h2><a href="/${s.id}/">${esc(s.name)}</a></h2><p class="lede">Service ID <code>${esc(s.id)}</code></p><p>${esc(firstSentence(s.card.description))}</p>${links(s, "")}</div>`)
  .join("\n")}`;
  return page({ title: "agentdata.network", description: "REST data services for agents on Pocket Network.", path: "/", body });
}

function notFound() {
  return page({ title: "Not found", description: "Page not found.", path: "/404.html", body: `<h1>Not found</h1><p>No page here. See the <a href="/">service list</a>.</p>` });
}

rmSync(out, { recursive: true, force: true });
write("CNAME", `${DOMAIN}\n`);
write(".nojekyll", "");
write("index.html", indexPage());
write("404.html", notFound());
for (const s of services) {
  write(`${s.id}/index.html`, docsPage(s));
  // GitHub Pages serves /<id>/operators from operators.html.
  write(`${s.id}/operators.html`, operatorsPage(s));
  if (s.spec) write(`${s.id}/openapi/v1/openapi.json`, s.spec);
}
console.log(`built ${services.length} services into ${out}: ${services.map((s) => s.id).join(", ")}`);
