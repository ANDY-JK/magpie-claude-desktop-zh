// Compare the ICU alternatives of the Chinese catalog against the English one
// it was built from: an alternative that had text in English and none in
// Chinese lost its words.
//
//   node tools/check-icu.mjs [english.json] [chinese.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(DIR, "..");

const enPath = process.argv[2] || path.join(PKG, "..", "catalogs", "ion-en-US.json");
const zhPath = process.argv[3] || path.join(PKG, "assets", "zh-Hans.json");

const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
const zh = JSON.parse(fs.readFileSync(zhPath, "utf8"));

function alts(s) {
  const out = new Map();
  const re = /(\b(?:one|other|zero|two|few|many)|=\d+)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(String(s))) !== null) out.set(m[1], m[2].trim());
  return out;
}

const lost = [];
for (const k of Object.keys(en)) {
  const a = en[k];
  const b = zh[k];
  if (typeof a !== "string" || typeof b !== "string") continue;
  const ea = alts(a);
  if (ea.size === 0) continue;
  const eb = alts(b);
  for (const [sel, text] of ea) {
    if (!text) continue;
    if (eb.has(sel) && eb.get(sel) === "" && text !== "") lost.push({ k, sel, en: text, zh: b });
  }
}

console.log("alternatives that lost their text = " + lost.length);
for (const l of lost.slice(0, 20)) {
  console.log("  " + l.sel + "  en: " + JSON.stringify(l.en).slice(0, 70));
  console.log("     zh: " + JSON.stringify(l.zh).slice(0, 90));
}
console.log(lost.length === 0 ? "ICU-OK" : "ICU-ISSUES " + lost.length);
process.exit(lost.length === 0 ? 0 : 1);
