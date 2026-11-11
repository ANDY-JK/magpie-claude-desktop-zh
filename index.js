// magpie-claude-desktop-zh —— 宿主进程部分。
//
// The plugin's page runs in a sandboxed frame with connect-src 'none', so it
// cannot call anything. The host therefore does the work itself when magpie
// loads it (on magpie's start, and when the page is opened) and publishes the
// outcome as page/status.js, which the page loads as a plain script.

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as zh from "./lib/zh.js"

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.MAGPIE_CLAUDE_ZH_PORT || 3477)
const LOG = path.join(os.homedir(), ".config", "magpie", "logs", "claude-zh.log")

function log(line) {
  const text = new Date().toISOString() + " " + line + "\n"
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, text)
  } catch {
    // logging must never break the plugin
  }
  console.log("[claude-zh] " + line)
}

function catalogs() {
  const main = fs.readFileSync(path.join(DIR, "assets", "zh-Hans.json"), "utf8")
  const dynamic = fs.readFileSync(path.join(DIR, "assets", "dynamic-zh-Hans.json"), "utf8")
  const parsed = JSON.parse(main)
  return { main, dynamic, meta: { keys: Object.keys(parsed).length } }
}

// publish writes the page's view of the world. A page can load only its own
// files, so the host hands it the state as a script. The file is generated at
// run time and kept out of the package, so a page that loads before the host
// ever ran just draws nothing rather than failing.
function publish(state) {
  const body =
    "window.__claudeZh = " + JSON.stringify(state, null, 1) + ";\n" +
    "if (window.__claudeZhReady) window.__claudeZhReady(window.__claudeZh);\n"
  try {
    fs.mkdirSync(path.join(DIR, "page"), { recursive: true })
    fs.writeFileSync(path.join(DIR, "page", "status.js"), body, "utf8")
  } catch (e) {
    log("写 status.js 失败: " + (e && e.message ? e.message : e))
  }
}

// The switches, as the page shows them. The host's own options are what a user
// sets in plugins.json; these are kept here so the page can flip them and the
// next start acts on them without a restart.
const SWITCHES = path.join(os.homedir(), ".config", "magpie", "claude-zh-options.json")

function switches() {
  const saved = (() => {
    try {
      return JSON.parse(fs.readFileSync(SWITCHES, "utf8"))
    } catch {
      return {}
    }
  })()
  // Each defaults to the harmless side: auto on, force off, and remove must be
  // asked for. remove is one-shot — acting on it clears it in saveSwitches.
  return {
    auto: saved.auto !== false,
    force: saved.force === true,
    remove: saved.remove === true,
  }
}

function saveSwitches(next) {
  const cur = switches()
  const val = {
    auto: next.auto === undefined ? cur.auto : next.auto !== false,
    force: next.force === undefined ? cur.force : next.force === true,
    remove: next.remove === undefined ? cur.remove : next.remove === true,
  }
  try {
    fs.mkdirSync(path.dirname(SWITCHES), { recursive: true })
    fs.writeFileSync(SWITCHES, JSON.stringify(val, null, 1), "utf8")
  } catch (e) {
    log("写选项失败: " + (e && e.message ? e.message : e))
  }
  return val
}

function snapshot(extra = {}) {
  let st = null
  try {
    st = zh.status()
  } catch (e) {
    st = { error: String((e && e.message) || e) }
  }
  const body = Object.assign(
    {
      at: new Date().toISOString(),
      target: zh.targetRoot(),
      app: zh.patchedApp(),
      log: LOG,
      options: switches(),
    },
    extra,
    { status: st }
  )
  publish(body)
  return body
}

function ensureInstalled(opts) {
  let st = zh.status()

  if (opts.remove) {
    log("options 要求移除副本")
    zh.remove()
    return snapshot({ action: "removed" })
  }

  if (!st.install) {
    log("没有找到 Claude Desktop 安装目录")
    return snapshot({ action: "no-install" })
  }

  if (!opts.auto) {
    log("自动安装已关闭")
    return snapshot({ action: "idle" })
  }

  const needed = !st.copy.exists || !st.copy.chinese || !st.copy.consistent || st.stale || opts.force
  if (!needed) {
    log("副本已是最新：" + (st.copy.version || "?"))
    return snapshot({ action: "up-to-date" })
  }

  log("开始安装/更新：" + st.install.package + (st.stale ? "（已过期）" : ""))
  try {
    const res = zh.apply({
      catalogs: catalogs(),
      force: opts.force || !st.copy.exists,
      log: (l) => log("  " + l),
    })
    log("完成：" + res.package + "，bundle " + res.targets + " 个，头部 " + res.headerHash.slice(0, 12))
    return snapshot({ action: "applied", result: { package: res.package, bytes: res.bytes, targets: res.targets } })
  } catch (e) {
    log("失败：" + (e && e.message ? e.message : e))
    return snapshot({ action: "failed", error: String((e && e.message) || e) })
  }
}

function json(rw, code, body) {
  rw.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  rw.end(JSON.stringify(body))
}

function route(rw, method, pathname, body) {
  if (method === "GET" && (pathname === "/status" || pathname === "/")) {
    json(rw, 200, snapshot())
    return
  }
  // The page's switches. magpie.options.set writes plugins.json, which the host
  // does not hand to a plugin's function, so the page's own service keeps them
  // instead; the next start acts on them.
  if (method === "POST" && pathname === "/options") {
    const saved = saveSwitches(body || {})
    log("选项已更新：" + JSON.stringify(saved))
    if (saved.remove) {
      log("按开关要求移除副本")
      zh.remove()
      json(rw, 200, { ok: true, options: saved, status: snapshot({ action: "removed" }).status })
      return
    }
    if (saved.force) {
      try {
        const res = zh.apply({ catalogs: catalogs(), force: true, log: (l) => log("  " + l) })
        saveSwitches({ force: false })
        json(rw, 200, { ok: true, options: switches(), result: res, status: snapshot({ action: "applied" }).status })
        return
      } catch (e) {
        log("重建失败：" + (e && e.message ? e.message : e))
        json(rw, 500, { ok: false, error: String((e && e.message) || e) })
        return
      }
    }
    json(rw, 200, { ok: true, options: saved })
    return
  }
  if (method === "POST" && pathname === "/rebuild") {
    try {
      const res = zh.apply({ catalogs: catalogs(), force: true, log: (l) => log("  " + l) })
      json(rw, 200, { ok: true, result: res, status: zh.status() })
    } catch (e) {
      log("重建失败：" + (e && e.message ? e.message : e))
      json(rw, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return
  }
  if (method === "POST" && pathname === "/apply") {
    try {
      const res = zh.apply({ catalogs: catalogs(), force: !!body.force, log: (l) => log("  " + l) })
      json(rw, 200, { ok: true, result: res, status: zh.status() })
    } catch (e) {
      json(rw, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return
  }
  if (method === "POST" && pathname === "/remove") {
    json(rw, 200, { ok: true, removed: zh.remove(), status: zh.status() })
    return
  }
  if (method === "POST" && pathname === "/launch") {
    try {
      json(rw, 200, { ok: true, exe: zh.launch() })
    } catch (e) {
      json(rw, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return
  }
  json(rw, 404, { error: "no such path" })
}

function startService() {
  if (globalThis.__claudeZhStarted) return
  globalThis.__claudeZhStarted = true
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
      if (raw.length > 1e6) req.destroy()
    })
    req.on("end", () => {
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      const p = (req.url || "/").split("?")[0]
      try {
        route(res, req.method || "GET", p, body)
      } catch (e) {
        json(res, 500, { error: String((e && e.message) || e) })
      }
    })
  })
  server.on("error", (e) => log("service: " + (e && e.message ? e.message : e)))
  server.listen(PORT, "127.0.0.1", () => log("service on 127.0.0.1:" + PORT))
}

// The host hands each exported function the plugin's own options
// (plugins.json's "options"). The page can flip the same switches, so the two
// are merged: what the page saved wins, and a value in plugins.json is used
// when the page never wrote one.
function optionsOf(input) {
  const saved = switches()
  let o = input
  if (o && typeof o === "object" && o.magpie && typeof o.magpie === "object") o = o.magpie
  if (o && typeof o === "object" && o.options && typeof o.options === "object") o = o.options
  if (!o || typeof o !== "object") return saved
  return {
    auto: o.auto === undefined ? saved.auto : o.auto !== false,
    force: o.force === undefined ? saved.force : o.force === true,
    remove: o.remove === undefined ? saved.remove : o.remove === true,
  }
}

// The host calls every exported function, so there is exactly one export.
export const ClaudeDesktopZh = async (input) => {
  const opts = optionsOf(input)
  if (!globalThis.__claudeZhBooted) {
    globalThis.__claudeZhBooted = true
    try {
      ensureInstalled(opts)
    } catch (e) {
      log("启动检查失败: " + (e && e.message ? e.message : e))
    }
    startService()
  }
  return {}
}