// The page draws what the host published in status.js and flips the switches by
// asking the host's own service. It reaches that service the way magpie gives a
// plugin page one: `_magpie/service/` beside the page's files (a browser opened
// through magpie web), or 127.0.0.1:3477 in the desktop window.
//
// When the service can't be reached (no service in the window, or a policy that
// forbids it), the switches fall back to the bridge's options, which the host
// reads on the next start.

const PORT = 3477;

function el(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function actionText(state) {
  if (!state) return "";
  const a = state.action;
  if (a === "up-to-date") return "已是最新，无需处理";
  if (a === "applied") return "已安装 / 更新中文副本";
  if (a === "removed") return "已移除副本";
  if (a === "idle") return "自动安装已关闭";
  if (a === "no-install") return "没找到 Claude Desktop";
  if (a === "failed") return "失败：" + (state.error || "");
  return a ? String(a) : "—";
}

function render(state) {
  if (!state) return;
  const st = state.status || {};
  const install = st.install;
  setText("install", install ? install.package : "未检测到");

  const copy = st.copy || {};
  if (!copy.exists) {
    setText("copy", "还没建");
  } else if (st.stale) {
    setText("copy", "副本 " + (copy.version || "?") + " 已过期，将重做");
  } else {
    setText("copy", (copy.version || "已建") + (copy.chinese ? "（含中文）" : "（无中文）"));
  }

  const keys = (st.catalogs && st.catalogs.keys) || 0;
  const dyn = (st.catalogs && st.catalogs.dynamicKeys) || 0;
  setText("keys", keys ? keys + " 条 + 动态 " + dyn + " 条" : "—");
  setText("seal", copy.consistent ? "是" : copy.exists ? "否" : "—");
  setText("action", actionText(state));
  setText("app", state.app || "—");
  setText("appPath", state.app || "副本");
  setText("log", state.log || "—");
  setText("at", state.at ? "状态时间 " + new Date(state.at).toLocaleString() : "");
}

function drawSwitch(on) {
  const b = el("auto");
  if (!b) return;
  b.setAttribute("aria-checked", on ? "true" : "false");
  b.textContent = on ? "开" : "关";
  b.classList.toggle("on", !!on);
}

// serviceBase is where the host's service answers, or "" when it can't be
// reached from this frame.
async function serviceBase() {
  const candidates = [];
  if (window.magpie && typeof window.magpie.service === "string" && window.magpie.service) {
    candidates.push(window.magpie.service.replace(/\/?$/, "/"));
  }
  candidates.push("http://127.0.0.1:" + PORT + "/");

  for (const base of candidates) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(base + "status", { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return base;
    } catch (e) {
      // try the next one
    }
  }
  return "";
}

window.__claudeZhReady = render;

(async function () {
  let opts = { auto: true };
  try {
    if (window.magpie && window.magpie.ready) {
      await window.magpie.ready;
      const fromBridge = await window.magpie.options.get();
      if (fromBridge && typeof fromBridge === "object") opts = fromBridge;
    }
  } catch (e) {
    // the bridge is optional
  }

  const state = window.__claudeZh || null;
  if (state && state.options) opts = state.options;
  render(state);
  drawSwitch(opts.auto !== false);

  const base = await serviceBase();

  async function save(next, message) {
    if (!base) {
      setText("msg", "宿主服务没有响应，改不了开关。重启 magpie 后再试。");
      return false;
    }
    try {
      const r = await fetch(base + "options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const j = await r.json();
      if (!j.ok) {
        setText("msg", "操作失败：" + (j.error || "未知错误"));
        return false;
      }
      if (j.options) {
        opts = j.options;
        drawSwitch(opts.auto !== false);
      }
      setText("msg", message);
      if (j.status) render({ status: j.status, app: state ? state.app : "", log: state ? state.log : "" });
      return true;
    } catch (e) {
      setText("msg", "操作失败：" + (e && e.message ? e.message : e));
      return false;
    }
  }

  const autoBtn = el("auto");
  if (autoBtn) {
    autoBtn.addEventListener("click", function () {
      const next = Object.assign({}, opts, { auto: !(opts.auto !== false) });
      save(next, next.auto ? "已开启自动安装。" : "已关闭自动安装，副本保持现状。");
    });
  }

  const rebuild = el("rebuild");
  if (rebuild) {
    rebuild.addEventListener("click", function () {
      setText("msg", "正在重建，大约一分钟…");
      rebuild.disabled = true;
      save({ force: true }, "已重建中文副本。").then(function () {
        rebuild.disabled = false;
      });
    });
  }

  const removeBtn = el("remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", function () {
      if (!window.confirm("删除复制出来的中文客户端？官方安装不受影响，随时可以再建。")) return;
      setText("msg", "正在移除…");
      removeBtn.disabled = true;
      save({ remove: true }, "已移除中文副本。").then(function () {
        removeBtn.disabled = false;
      });
    });
  }

  const refresh = el("refresh");
  if (refresh) {
    refresh.addEventListener("click", function () {
      location.reload();
    });
  }
})();