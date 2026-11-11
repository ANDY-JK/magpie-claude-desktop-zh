// The package's own checks: what magpie reads, and what must not ship.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let bad = 0;
function ok(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) bad++;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));

ok("name", pkg.name === "magpie-claude-desktop-zh", pkg.name);
ok("type module", pkg.type === "module");
ok("main exists", !!pkg.main && fs.existsSync(path.join(DIR, pkg.main)));
ok("keyword magpie-plugin", (pkg.keywords || []).includes("magpie-plugin"));
ok("license", pkg.license === "MIT");
ok("os win32", JSON.stringify(pkg.os) === '["win32"]');

const page = pkg.magpie && pkg.magpie.page;
ok("magpie.page", !!page);
ok("page.file exists", !!page && fs.existsSync(path.join(DIR, page.file)), page && page.file);
ok("page.icon exists", !!page && fs.existsSync(path.join(DIR, page.icon)));
ok("page.service.port", !!page && page.service && page.service.port === 3477);

// The page must load the bridge, or magpie shows "This page stopped working".
const html = fs.readFileSync(path.join(DIR, "page/index.html"), "utf8");
ok("page loads _magpie/bridge.js", html.includes("_magpie/bridge.js"));
ok("page has a title in zh", !!page.titles && !!page.titles.zh);

// One exported function: the host calls every export.
const host = fs.readFileSync(path.join(DIR, "index.js"), "utf8");
const exports = host.match(/^export\s+(const|function|default)/gm) || [];
ok("exactly one export", exports.length === 1, "found " + exports.length);

// The catalogs the host reads.
for (const f of ["assets/zh-Hans.json", "assets/dynamic-zh-Hans.json"]) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  ok(f + " parses", true, Object.keys(j).length + " keys");
}

// Nothing that only exists at run time.
ok("no page/status.js committed", !fs.existsSync(path.join(DIR, "page/status.js")));
ok("no node_modules", !fs.existsSync(path.join(DIR, "node_modules")));

console.log(bad === 0 ? "ALL-PASS" : "FAILED " + bad);
process.exit(bad === 0 ? 0 : 1);
