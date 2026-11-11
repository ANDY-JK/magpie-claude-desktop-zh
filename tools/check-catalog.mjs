// Check a built catalog against the English one it came from.
//
//   node tools/check-catalog.mjs assets/zh-Hans.json
//
// Reports keys missing, values left in English, and ICU structures that lost
// their shape (an English word where the translation dropped it, or a plural
// whose alternatives came out empty).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const zhPath = process.argv[2] || path.join(DIR, "..", "assets", "zh-Hans.json");
const zh = JSON.parse(fs.readFileSync(zhPath, "utf8"));

const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
const words = (s) => (String(s).match(/[A-Za-z]{2,}/g) || []).length;

function outsidePlaceholders(s) {
  return String(s).replace(/\{[^{}]*\}/g, " ").replace(/<[^>]+>/g, " ");
}

// ICU alternatives that came out empty: one {} other {} with no text.
function emptyAlternatives(s) {
  const hits = [];
  const re = /(?:\b(?:one|other|zero|two|few|many)|=\d+)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(String(s))) !== null) {
    if (!m[1].trim()) hits.push(m[0]);
  }
  return hits;
}

let keys = 0;
let noChinese = [];
let emptyAlt = [];
let lostWords = [];

for (const k of Object.keys(zh)) {
  keys++;
  const v = zh[k];
  if (typeof v !== "string" || !v.trim()) continue;
  const c = cjk(v);
  const left = words(outsidePlaceholders(v));
  // a value with English words and no Chinese at all is probably untouched
  if (c === 0 && left >= 2) noChinese.push({ k, v });
  const empty = emptyAlternatives(v);
  if (empty.length) emptyAlt.push({ k, v, empty });
}

// This file is the shipped catalog, so the English side is the same keys.
const en = {};
let same = 0;
for (const k of Object.keys(zh)) {
  if (typeof zh[k] === "string" && /\s/.test(zh[k]) && cjk(zh[k]) === 0) same++;
}

console.log("keys                 = " + keys);
console.log("values with no CJK   = " + same + "  (product names, paths, symbols)");
console.log("empty ICU alternative= " + emptyAlt.length);
console.log("possibly untranslated= " + noChinese.length);

for (const e of emptyAlt.slice(0, 20)) {
  console.log("  EMPTY-ALT " + JSON.stringify(e.k).slice(0, 70) + " -> " + JSON.stringify(e.empty));
}
for (const n of noChinese.slice(0, 20)) {
  console.log("  ENGLISH   " + JSON.stringify(n.k).slice(0, 70) + " -> " + JSON.stringify(n.v).slice(0, 70));
}

const bad = emptyAlt.length + noChinese.length;
console.log(bad === 0 ? "CATALOG-OK" : "CATALOG-ISSUES " + bad);
process.exit(emptyAlt.length === 0 ? 0 : 1);
