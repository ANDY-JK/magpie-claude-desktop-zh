// Claude Desktop 简体中文 —— core logic.
//
// The installed Store app cannot be patched in place: its asar header hash is
// pinned inside claude.exe (embedded asar integrity) and the MSIX block map
// covers the files. So this copies the app out, repacks the copy's
// ion-dist.asar with a zh-Hans catalog plus the locale whitelist entry, and
// points the copy's exe at the new header hash. The copy runs on its own.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync, spawn } from "node:child_process"

const BLOCK = 4194304
const WHITELIST_NEEDLE = '"pt-BR","id-ID"]'
const WHITELIST_REPLACE = '"pt-BR","id-ID","zh-Hans"]'
const EXE_ANCHOR = '"file":"resources\\\\ion-dist.asar","alg":"SHA256","value":"'
const ASAR_NAME = "ion-dist.asar"

export function targetRoot() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), "magpie", "claude-zh")
}

export function patchedApp() {
  return path.join(targetRoot(), "app")
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// findInstall asks Windows where the MSIX package is. Reading a package's files
// is allowed, but listing its folders is not under the plugin host (Bun's
// readdir answers EPERM for WindowsApps where Node's does not), so every step
// here goes through stat/open and never lists a directory.
export function findInstall() {
  const cached = readJsonSafe(path.join(targetRoot(), "install.json"), null)

  const usable = (root) => {
    if (!root) return null
    const pkgDir = path.basename(root).toLowerCase()
    if (!pkgDir.startsWith("claude_") || !pkgDir.includes("__")) return null
    for (const app of [path.join(root, "app"), root]) {
      const exe = path.join(app, "claude.exe")
      const asar = path.join(app, "resources", ASAR_NAME)
      if (isFile(exe) && isFile(asar)) {
        const pkg = path.basename(app === root ? root : path.dirname(app))
        let version = null
        try {
          const fd = fs.openSync(exe, "r")
          fs.closeSync(fd)
        } catch {
          version = null
        }
        return {
          package: pkg,
          app,
          exe,
          asar,
          version: (/(\d+\.\d+\.\d+\.\d+)/.exec(pkg) || [])[1] || null,
        }
      }
    }
    return null
  }

  const fromCache = cached && cached.root ? usable(cached.root) : null
  if (fromCache) return fromCache

  const roots = []
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage | Where-Object { $_.Name -eq 'Claude' } | ForEach-Object { $_.InstallLocation + '|' + $_.PackageFullName }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 90000 }
    )
    for (const line of String(raw).split(/\r?\n/)) {
      const t = line.trim()
      if (!t || !t.includes("|")) continue
      const [loc, full] = t.split("|")
      if (loc && (loc.startsWith("C:") || loc.startsWith("D:") || loc.startsWith("E:"))) roots.push(loc.trim())
      if (full) roots.push(path.join("C:\\Program Files\\WindowsApps", full.trim()))
    }
  } catch {
    // no AppX answer: the cache and the guesses below still stand
  }

  for (const root of roots) {
    const found = usable(root)
    if (found) {
      try {
        fs.mkdirSync(targetRoot(), { recursive: true })
        fs.writeFileSync(
          path.join(targetRoot(), "install.json"),
          JSON.stringify({ root, package: found.package, version: found.version, at: new Date().toISOString() }, null, 1),
          "utf8"
        )
      } catch {
        // caching is a nicety
      }
      return found
    }
  }
  return null
}

// logSkip is kept quiet: a probe that cannot be listed is normal (WindowsApps
// itself is not listable without elevation).
function logSkip() {}

export function readJsonSafe(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return dflt
  }
}

// ---------- asar ----------

export function parseAsar(file) {
  const buf = fs.readFileSync(file)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"))
  const base = 8 + buf.readUInt32LE(4)
  return { buf, header, base, jsonSize }
}

function walk(node, prefix, acc) {
  for (const name of Object.keys(node.files || {})) {
    const child = node.files[name]
    const p = prefix + "/" + name
    if (child.files) walk(child, p, acc)
    else acc.push({ path: p, entry: child })
  }
  return acc
}

function payloadOf(ar, entry) {
  const off = ar.base + Number(entry.offset)
  return ar.buf.subarray(off, off + entry.size)
}

function integrityOf(data) {
  const blocks = []
  for (let off = 0; off < data.length; off += BLOCK) {
    blocks.push(sha256(data.subarray(off, Math.min(off + BLOCK, data.length))))
  }
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)))
  return { algorithm: "SHA256", hash: sha256(data), blockSize: BLOCK, blocks }
}

function ensureDir(header, parts) {
  let node = header
  for (const p of parts) {
    if (!node.files) node.files = {}
    if (!node.files[p]) node.files[p] = { files: {} }
    node = node.files[p]
  }
  return node
}

function lookup(header, p) {
  const parts = p.split("/").filter(Boolean)
  let node = header
  for (const x of parts) {
    if (!node.files || !node.files[x]) return null
    node = node.files[x]
  }
  return node
}

// whitelistTargets are the bundles that carry the hardcoded locale list.
export function whitelistTargets(ar) {
  const out = []
  for (const f of walk(ar.header, "", [])) {
    if (!/^\/assets\/.*\.js$/.test(f.path)) continue
    const text = payloadOf(ar, f.entry).toString("utf8")
    if (text.includes(WHITELIST_NEEDLE)) out.push({ path: f.path, hits: text.split(WHITELIST_NEEDLE).length - 1 })
  }
  return out
}

// packAsar writes a new archive: existing entries keep their bytes, the
// patched and added payloads go at the end, and every kept offset shifts by
// the header's growth.
export function packAsar(srcFile, outFile, { add = [], patchJs = [] } = {}) {
  const ar = parseAsar(srcFile)
  const staged = []

  for (const p of patchJs) {
    const entry = lookup(ar.header, p)
    if (!entry || entry.files) throw new Error("patch target missing: " + p)
    const text = payloadOf(ar, entry).toString("utf8")
    const hits = text.split(WHITELIST_NEEDLE).length - 1
    if (hits !== 1) throw new Error(p + ": want 1 whitelist hit, got " + hits)
    staged.push({ path: p, data: Buffer.from(text.split(WHITELIST_NEEDLE).join(WHITELIST_REPLACE), "utf8") })
  }

  for (const a of add) {
    if (lookup(ar.header, a.path)) continue
    staged.push({ path: a.path, data: a.data })
  }

  let cursor = ar.buf.length - ar.base
  const records = []
  for (const s of staged) {
    records.push({ path: s.path, data: s.data, offset: cursor, size: s.data.length })
    cursor += s.data.length
  }

  for (const r of records) {
    const parts = r.path.split("/").filter(Boolean)
    const leaf = parts.pop()
    const dir = ensureDir(ar.header, parts)
    dir.files[leaf] = { size: r.size, offset: String(r.offset), integrity: integrityOf(r.data) }
  }

  // Offsets in an asar are relative to the payload base, so moving the base
  // (the header grew) leaves every kept offset valid as it is. Staged records
  // already carry offsets relative to the new base.
  let jsonText = JSON.stringify(ar.header)
  while (Buffer.byteLength(jsonText) % 4 !== 2) jsonText += " "
  const jsonSize = Buffer.byteLength(jsonText)
  const newBase = jsonSize + 18

  const total = newBase + cursor
  const out = Buffer.alloc(total)
  out.writeUInt32LE(4, 0)
  out.writeUInt32LE(jsonSize + 10, 4)
  out.writeUInt32LE(jsonSize + 6, 8)
  out.writeUInt32LE(jsonSize, 12)
  out.write(jsonText, 16, "utf8")
  out.fill(0, 16 + jsonSize, newBase)
  ar.buf.copy(out, newBase, ar.base)
  let at = newBase + (ar.buf.length - ar.base)
  for (const r of records) {
    r.data.copy(out, at)
    at += r.data.length
  }
  fs.writeFileSync(outFile, out)

  return { bytes: total, jsonSize, patched: patchJs.length, added: records.length }
}

export function headerHash(asarFile) {
  const buf = fs.readFileSync(asarFile)
  const jsonSize = buf.readUInt32LE(12)
  return sha256(buf.subarray(16, 16 + jsonSize))
}

export function exeHash(exeFile) {
  const text = fs.readFileSync(exeFile).toString("latin1")
  const at = text.indexOf(EXE_ANCHOR)
  if (at === -1) return null
  const hex = text.slice(at + EXE_ANCHOR.length, at + EXE_ANCHOR.length + 64)
  return /^[0-9a-f]{64}$/.test(hex) ? { hash: hex, at: at + EXE_ANCHOR.length } : null
}

export function patchExe(exeFile, newHash) {
  const buf = fs.readFileSync(exeFile)
  const text = buf.toString("latin1")
  const at = text.indexOf(EXE_ANCHOR)
  if (at === -1) throw new Error("the exe's integrity table has no entry for " + ASAR_NAME)
  const hexAt = at + EXE_ANCHOR.length
  const cur = text.slice(hexAt, hexAt + 64)
  if (!/^[0-9a-f]{64}$/.test(cur)) throw new Error("unexpected value in the exe's integrity table")
  if (cur === newHash) return { changed: false, from: cur, to: newHash }
  const out = Buffer.from(buf)
  out.write(newHash, hexAt, "latin1")
  fs.writeFileSync(exeFile, out)
  return { changed: true, from: cur, to: newHash }
}

// ---------- the copy ----------

export function status(ctx) {
  const install = findInstall()
  const app = patchedApp()
  const copyAsar = path.join(app, "resources", ASAR_NAME)
  const copyExe = path.join(app, "claude.exe")
  const out = {
    install: install ? { package: install.package, app: install.app } : null,
    copy: { path: app, exists: isDir(app), version: null, chinese: false, consistent: false },
    running: runningProcess(),
    catalogs: { keys: 0, dynamicKeys: 0 },
    canApply: !!install,
  }

  if (install) {
    out.install.asarBytes = fs.statSync(install.asar).size
    out.install.headerHash = headerHash(install.asar)
  }

  if (isDir(app)) {
    const stampPath = path.join(targetRoot(), "applied.json")
    const stamp = readJsonSafe(stampPath, null)
    out.copy.version = stamp ? stamp.package || null : null
    out.copy.appliedAt = stamp ? stamp.at || null : null
    if (isFile(copyAsar)) {
      try {
        const ar = parseAsar(copyAsar)
        const zh = lookup(ar.header, "/i18n/zh-Hans.json")
        out.copy.chinese = !!zh
        if (zh) {
          const data = payloadOf(ar, zh)
          out.catalogs.keys = Object.keys(JSON.parse(data.toString("utf8"))).length
        }
        const dyn = lookup(ar.header, "/i18n/dynamic/zh-Hans.json")
        if (dyn) {
          out.catalogs.dynamicKeys = Object.keys(JSON.parse(payloadOf(ar, dyn).toString("utf8"))).length
        }
        const want = headerHash(copyAsar)
        const inExe = isFile(copyExe) ? exeHash(copyExe) : null
        out.copy.consistent = !!inExe && inExe.hash === want
        out.copy.headerHash = want
        out.copy.exeHash = inExe ? inExe.hash : null
        out.copy.asarBytes = fs.statSync(copyAsar).size
      } catch (e) {
        out.copy.error = String(e.message || e)
      }
    }
  }

  out.stale = !!(install && out.copy.version && out.copy.version !== install.package)
  return out
}

function runningProcess() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq claude.exe"], { encoding: "utf8" })
    if (!/claude\.exe/i.test(out)) return null
    return "claude.exe"
  } catch {
    return null
  }
}

export function stopApp() {
  try {
    execFileSync("taskkill", ["/IM", "claude.exe", "/F", "/T"], { stdio: "ignore" })
  } catch {
    // not running
  }
  const until = Date.now() + 20000
  while (Date.now() < until) {
    if (!runningProcess()) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
  }
  return false
}

// listTree lists a package folder without fs.readdir, which the plugin host is
// not allowed to use inside WindowsApps. PowerShell's Get-ChildItem reads it
// (with the file size), and the copy then goes file by file.
function listTree(dir) {
  const script =
    "Get-ChildItem -LiteralPath '" +
    dir.replace(/'/g, "''") +
    "' -Recurse -File -Force | ForEach-Object { $_.FullName.Substring(" +
    dir.length +
    ").TrimStart('\\') + '|' + $_.Length }"
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = []
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || !t.includes("|")) continue
    const i = t.lastIndexOf("|")
    const rel = t.slice(0, i)
    const size = Number(t.slice(i + 1))
    if (!rel) continue
    out.push({ rel, size: Number.isFinite(size) ? size : null })
  }
  return out
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  const files = listTree(src)
  let copied = 0
  for (const f of files) {
    const from = path.join(src, f.rel)
    const to = path.join(dst, f.rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied++
  }
  return copied
}

function dirSize(dir) {
  let total = 0
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    if (name.isDirectory()) total += dirSize(p)
    else if (name.isFile()) {
      try {
        total += fs.statSync(p).size
      } catch {
        // skip
      }
    }
  }
  return total
}

export function apply({ catalogs, force = false, log = () => {} } = {}) {
  const install = findInstall()
  if (!install) throw new Error("没有找到 Claude Desktop 的安装目录（WindowsApps 下的 Claude_*）")

  const root = targetRoot()
  const app = patchedApp()
  if (isDir(app) && !force) {
    const stamp = readJsonSafe(path.join(root, "applied.json"), null)
    if (stamp && stamp.package === install.package) {
      log("已是最新，跳过复制")
    }
  }

  log("停止可能在运行的 Claude")
  stopApp()

  if (isDir(app) && !force) {
    const stamp = readJsonSafe(path.join(root, "applied.json"), null)
    if (stamp && stamp.package === install.package && isFile(path.join(app, "resources", ASAR_NAME))) {
      const done = repackAndSeal(app, catalogs, log)
      return { ...done, copied: false, package: install.package }
    }
  }

  log("复制安装目录到 " + app)
  if (isDir(app)) fs.rmSync(app, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  copyTree(install.app, app)
  log("复制完成：" + Math.round(dirSize(app) / 1048576) + " MB")

  const done = repackAndSeal(app, catalogs, log)
  fs.writeFileSync(
    path.join(root, "applied.json"),
    JSON.stringify({ package: install.package, at: new Date().toISOString(), catalogs: catalogs.meta || {} }, null, 1),
    "utf8"
  )
  return { ...done, copied: true, package: install.package }
}

function repackAndSeal(app, catalogs, log) {
  const asar = path.join(app, "resources", ASAR_NAME)
  const exe = path.join(app, "claude.exe")
  const tmp = asar + ".new"

  const ar = parseAsar(asar)
  const targets = whitelistTargets(ar)
  if (targets.length === 0) throw new Error("这个版本的界面里找不到语言白名单，无法打补丁")

  log("重打包：" + targets.length + " 个 bundle 加白名单，2 个语言目录")
  const res = packAsar(asar, tmp, {
    add: [
      { path: "i18n/zh-Hans.json", data: Buffer.from(catalogs.main, "utf8") },
      { path: "i18n/dynamic/zh-Hans.json", data: Buffer.from(catalogs.dynamic, "utf8") },
    ],
    patchJs: targets.map((t) => t.path),
  })
  fs.renameSync(tmp, asar)

  const want = headerHash(asar)
  const seal = patchExe(exe, want)
  log("exe 内嵌哈希已同步：" + (seal.changed ? seal.from.slice(0, 8) + " → " + want.slice(0, 8) : "无需改动"))
  return { bytes: res.bytes, targets: targets.length, headerHash: want, seal }
}

export function launch() {
  const exe = path.join(patchedApp(), "claude.exe")
  if (!isFile(exe)) throw new Error("副本还没做好，先点“安装/更新中文版”")
  const child = spawn(exe, [], { detached: true, stdio: "ignore" })
  child.unref()
  return exe
}

export function remove() {
  stopApp()
  const root = targetRoot()
  if (isDir(root)) fs.rmSync(root, { recursive: true, force: true })
  return root
}