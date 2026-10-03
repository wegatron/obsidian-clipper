# agent-cli.md — obsidian-clipper CLI 用法（AI agent 场景）

## §0 概览

CLI 让 agent 零配置完成「URL → markdown 文件」：

```
node dist/cli.cjs <url> -o <dir> [--browser]
```

- 不给模板 → 内置默认模板（frontmatter：title / source / author / published / created + 正文）
- `-o` 给目录 → 文件按页面标题命名，**完整路径打印到 stdout**（agent 从 stdout 拿路径）
- `--browser` → 用真实浏览器渲染取页，登录 cookie 持久化复用，支持 JS 渲染的 SPA

## §1 快速开始

| 场景 | 命令 |
|---|---|
| 普通网页，直接抓 | `node dist/cli.cjs <url> -o D:/tmp` |
| JS 渲染 / 需要登录态 | `node dist/cli.cjs <url> -o D:/tmp --browser` |
| 某站点**首次**需要登录 | `node dist/cli.cjs <url> -o D:/tmp --browser --interactive` |

安装后（`npm i -g obsidian-clipper` 或 `npm link`）可直接用 `obsidian-clipper` 替代 `node dist/cli.cjs`。

## §2 参数对照

| 参数 | 作用 | 备注 |
|---|---|---|
| `<url>` | 目标页面 | 必填 |
| `-t, --template <path>` | 模板 JSON 文件或目录 | **可选**；目录时按 URL triggers 自动匹配 |
| `-o, --output <path>` | 输出路径 | 文件路径或目录；缺省输出到 stdout |
| `--html <path>` | 从文件读 HTML（`-` 为 stdin） | 优先级高于 `--browser` |
| `--browser` | 浏览器渲染取页 | Chrome 优先，其次 Edge |
| `--interactive` | 首次登录流程 | 隐含 `--browser`；见 §4.2 |
| `--browser-path <path>` | 指定浏览器可执行文件 | 覆盖自动检测 |
| `--vault` / `--open` / `--uri` / `--silent` | 发送到 Obsidian | 代替写文件 |
| `--property-types <path>` | frontmatter 属性类型 JSON | 可选 |
| `-h, --help` | 帮助 | |

## §3 三种取页方式

```
--html 优先级最高
   │
   ▼
[--html 文件/stdin] ──是──► 直接用该 HTML
   │否
   ▼
[--browser] ──是──► 启动浏览器(CDP) ──► 渲染等待稳定 ──► outerHTML
   │否
   ▼
fetch(url) 服务器返回 HTML
   │
   ▼
同一套 clip 管线: defuddle 提取 → 模板渲染 → markdown
```

判定建议：先跑普通模式，产出文件标题为空 / 正文极短（如 <1KB）→ 说明是 JS 壳或登录墙 → 加 `--browser` 重跑。

## §4 浏览器登录态机制

### §4.1 profile 持久化

专用浏览器 profile 固定在 `~/.obsidian-clipper/profile`。**登录一次，cookie 永久落盘**，之后同站点直接 `--browser`，无需再登录。

### §4.2 `--interactive` 首次登录流程

```
CLI 启动浏览器打开目标页
   │
   ▼
用户在浏览器窗口内完成登录
   │
   ▼
用户【手动关闭浏览器窗口】        ← 不是按终端按键
   │
   ▼
CLI 检测到所有 page target 消失
   │
   ▼
进程仍在：复用浏览器；进程已退出：重新启动
   │
   ▼
带登录态重新抓取 → 输出
```

> 为什么等 page target 而不是进程退出：macOS 上关闭窗口不退出 Chrome（常驻 Dock），等进程会永久挂住。轮询 CDP `/json/list` 在 Windows / macOS 行为一致。

复用仍在运行的浏览器时保留原有 CDP 端口；需要重新启动时先等待旧进程退出，避免 profile 尚未写完就被下一次启动使用。

### §4.3 渲染等待

页面 load 后，CLI 每 400ms 轮询 `document.body.innerText.length`，**连续两次不变即认为内容稳定**再抓取（封顶 10s）。这是为登录后重定向 + 客户端渲染的 SPA 设计的——固定 1 秒静默期会抓到空壳。

CDP 断连或命令超时会报错退出；正文稳定检测中的命令超时受剩余 10s 预算约束。页面加载成功后立即清除导航超时计时器，CLI 不再额外等待 30s 才退出。

## §5 输出规则

| `-o` 传入 | 判定 | 行为 |
|---|---|---|
| 已存在的目录 | `statSync().isDirectory()` | 写入 `<目录>/<标题>.md`，不存在则 `mkdir -p` |
| 以分隔符结尾 / 无扩展名 | 视为目录 | 同上 |
| 带扩展名（如 `.md`） | 视为文件 | 直接写入该路径 |

- 文件名 = `sanitizeFileName(渲染后的 noteName)`；标题为空时 fallback 到 URL hostname
- **stdout 只输出最终文件完整路径**；进度/提示走 stderr——agent 解析 stdout 即可
- 不给 `-o` 时 markdown 全文走 stdout

## §6 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 产出文件标题空、正文空 | JS 壳页或未登录 | 加 `--browser`；仍空 → `--interactive` 登录后重跑 |
| 抓到的是登录页内容 | 该站点 profile 无登录态 | `--interactive` 一次 |
| SPA 内容不完整 | 内容持续变化没收敛 | 10s 封顶后照抓；重跑一次通常即可 |
| `No browser found` | 无 Chrome/Edge | `--browser-path` 指定路径 |

诊断原始 HTML：设 `CLIPPER_DEBUG_HTML=<path>`（环境变量），`--browser` 抓到的 HTML 会落盘到该路径，肉眼确认是登录页还是文章页。

## §7 限制与风险（如实）

1. ⚠️ macOS 交互流程已通过模拟「关窗后进程仍存活」的回归测试，但**尚未做真实浏览器登录实测**
2. ⚠️ macOS 的 Edge 检测路径未列入候选表（`/Applications/Microsoft Edge.app/...`）；Mac 上需用 Chrome 或 `--browser-path`
3. 仓库遗留：`src/utils/template-integration.test.ts` 的 `youtube` fixture 在本次改动前即失败，与 CLI 无关
4. `--interactive` 等待关窗有 15 分钟上限，超时直接继续抓取（可能仍是未登录内容）
5. 站点风控/验证码不在处理范围内（这是浏览器渲染能覆盖的上限之外）

## §8 关键代码索引

| 符号 | 文件 |
|---|---|
| `DEFAULT_TEMPLATE` / `resolveOutputPath` / `main` | `src/cli.ts` |
| `fetchViaBrowser` / `waitForBrowserClosed` / `waitForStableContent` / `findBrowser` | `src/utils/browser-fetch.ts` |
| `clip` / `matchTemplate` | `src/api.ts` |
| `sanitizeFileName` | `src/utils/string-utils.ts` |
| 构建入口 | `scripts/build-cli.mjs`（`npm run build:cli`） |
