# magpie-claude-desktop-zh

把 **Claude Desktop 的界面换成简体中文**的 magpie 插件。

官方安装目录一字不改：插件复制一份客户端到别处，把自建的中文语言包打进它的界面资源里，
并让客户端的启动校验对得上。复制出来的副本照常启动，配置、会话、登录状态与官方版共用。

## 为什么不能直接改官方安装

`C:\Program Files\WindowsApps\...\app\resources\ion-dist.asar` 有两条锁：

1. 目录 ACL：属主是 `NT AUTHORITY\SYSTEM`，普通用户只读；
2. **Electron 内嵌完整性校验**：`claude.exe` 里嵌着一张表，写着 `ion-dist.asar` 头部的 SHA256。
   启动时比对，不一致就 `FATAL: Integrity check failed for asar archive entry '<header>'` 直接退出。
   实测：只往 asar 里加两个文件、原有 5039 个条目字节全不动，也照样秒崩。

MSIX 另外还有 `AppxBlockMap.xml` 的逐块哈希，被包签名覆盖。

## 它做了什么

```
C:\Program Files\WindowsApps\Claude_...\app\   官方包，不动
                 │ 复制（约 750 MB）
                 ▼
%LOCALAPPDATA%\magpie\claude-zh\app\           副本
   resources\ion-dist.asar                    + i18n/zh-Hans.json、+ 语言白名单项
   claude.exe                                 内嵌哈希表那 64 位 hex 等长替换
```

界面语言由两个 bundle 里一份**硬编码的 11 项白名单**决定（`shared-67`、`shared-99`），
没有中文；且全包没有任何代码写入 `meta[name="i18n-catalogs"]`，所以只改配置永远不生效。
插件两头都补：白名单各加一项 `"zh-Hans"`，再放两份 `zh-Hans.json` 目录。

## 用

插件页里有三个开关：

| 开关 | 作用 |
| --- | --- |
| 自动安装 / 更新 | magpie 启动或打开插件页时，官方版本变了就自动重做副本 |
| 重建一次 | 副本看着没问题也重做一遍 |
| 移除中文副本 | 删掉复制出来的客户端（约 750 MB），官方安装不受影响 |

装好后打开 `%LOCALAPPDATA%\magpie\claude-zh\app\claude.exe` 即是中文版。

选项存在 `~/.config/magpie/claude-zh-options.json`；日志在 `~/.config/magpie/logs/claude-zh.log`。

## 翻译

- 界面 42,695 个词条，中文由机器翻译生成，逐条校验 `{占位符}`、HTML 标签、`|` 数量与 ICU 复数结构，
  不合格保留英文，不产出坏串。
- 术语与长句仍建议人工过一遍。

## 已知边界

- **仅 Windows**：依赖 MSIX 安装位置与 `claude.exe` 的内嵌哈希表。
- 只改界面文字，不动功能与网络请求。
- Claude 大版本更新若改了打包结构（asar 布局或哈希表位置），需要更新 `lib/zh.js` 里的读取方式；
  检测到找不到白名单时会明确报错，不会产出坏包。

## 许可

MIT
