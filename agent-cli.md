# agent-cli.md — obsidian-clipper CLI 用法（AI agent 场景）

## §0 概览

CLI 让 agent 零配置完成「URL → markdown 文件」：

```
node dist/cli.cjs <url> -o <dir> [--browser]
```

- 不给模板 → 内置默认模板（frontmatter：title / source / author / published / created + 正文）
- `-o` 给目录 → 文件按页面标题命名，**完整路径打印到 stdout**（agent 从 stdout 拿路径）
- `--images-dir` → 下载最终正文图片，以相对路径引用本地附件
- `--browser` → 用真实浏览器渲染取页，登录 cookie 持久化复用，支持 JS 渲染的 SPA

## §1 快速开始

| 场景 | 命令 |
|---|---|
| 下载正文图片 | `node dist/cli.cjs <url> -o ./notes --images-dir ./notes/images` |
| 完整归档，图片失败即退出 | `node dist/cli.cjs <url> -o ./notes --images-dir ./notes/images --images-strict` |
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
| `--images-dir <dir>` | 下载正文图片到指定目录 | 要求 `-o`；与 `--open` 互斥；目录相对 cwd |
| `--images-strict` | 任一图片失败则不写笔记 | 要求 `--images-dir`；已保存附件可以保留 |
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

专用浏览器 profile 固定在 `~/.obsidian-clipper/profile`。持久 cookie 保存到 profile，之后同站点可直接 `--browser` 复用。登录是否仍有效取决于站点的 cookie 到期和撤销规则；会话 cookie 不保证重启后保留。

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
带登录态重新抓取 → 裁剪 → 下载图片（如启用）→ 输出
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

### §5.1 图片下载

```sh
node dist/cli.cjs https://example.com/article -o ./notes --images-dir ./notes/images
node dist/cli.cjs https://example.com/private -o ./notes --browser --images-dir ./notes/images --images-strict
```

| 项目 | 行为 |
|---|---|
| 下载范围 | 最终模板正文中的内联图片、引用式图片、HTML `<img src>`；包括模板插入的图片 |
| 保持原样 | frontmatter、普通链接、行内代码、代码块和已有本地图片 |
| 路径 | 相对于最终笔记位置，使用 `/` 并编码空格、中文、括号；可整体移动共同父目录 |
| 资源地址 | 按最终页面 URL 与 `<base>` 解析，签名查询参数保留；HTML 输入也支持 |
| 命名与复用 | 完整 SHA-256 + 检测出的格式扩展名；同 URL 每次运行只请求一次，同内容共用文件 |
| 内嵌图片 | `data:image/...` 解码保存；`blob:` 保留引用并报告失败 |
| 上限 | 并发 4；单图请求、重定向与读取合计 30 秒；实际读取／解码后最多 20 MiB |
| 默认失败策略 | 保留可解析的远程引用，stderr 输出失败原因和汇总，继续写笔记 |
| 严格失败策略 | 返回非零，不创建或覆盖笔记；已经完成的附件保留，失败的临时文件清理 |
| 全局输出错误 | 图片目录不能创建或写入时返回非零，stdout 不输出成功路径 |
| 浏览器模式 | 在原会话中下载，复用凭据；快照固定 `currentSrc`，会话在裁剪和下载结束后关闭 |

支持 PNG、JPEG、GIF、WebP、SVG、AVIF 等常见格式；按内容检测，不用 URL 后缀或响应 Content-Type 判断。登录 HTML 不会被保存成图片。成功时 stdout 仍仅输出 Markdown 绝对路径；`Images: … saved, … reused, … failed, … skipped` 写入 stderr。

## §6 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 产出文件标题空、正文空 | JS 壳页或未登录 | 加 `--browser`；仍空 → `--interactive` 登录后重跑 |
| 抓到的是登录页内容 | 该站点 profile 无登录态 | `--interactive` 一次 |
| SPA 内容不完整 | 内容持续变化没收敛 | 10s 封顶后照抓；重跑一次通常即可 |
| 图片报 `HTTP 401/403` | 图片需要登录或被站点拒绝 | 使用 `--browser` 复用登录态；首次用 `--interactive` |
| 图片失败但生成了笔记 | 默认尽力下载 | 需要完整归档时加 `--images-strict` |
| `No browser found` | 无 Chrome/Edge | `--browser-path` 指定路径 |

诊断原始 HTML：设 `CLIPPER_DEBUG_HTML=<path>`（环境变量），`--browser` 抓到的 HTML 会落盘到该路径，肉眼确认是登录页还是文章页。

## §7 限制与风险（如实）

1. 交互关窗的进程复用／重启由生命周期测试覆盖；真实 Chrome／Edge 测试覆盖受保护图片、响应式图片及持久 profile 复用。
2. 不下载 CSS 背景图、视频、音频、frontmatter 图片或 `blob:`；不自动滚动触发全部懒加载图片。
3. 严格失败不回滚已保存的附件；不提供跨运行 URL 缓存或附件垃圾回收。
4. `--interactive` 等待关窗有 15 分钟上限，超时直接继续抓取（可能仍是未登录内容）
5. 站点风控/验证码不在处理范围内（这是浏览器渲染能覆盖的上限之外）

## §8 关键代码索引

| 符号 | 文件 |
|---|---|
| `DEFAULT_TEMPLATE` / `resolveOutputPath` / `main` | `src/cli.ts` |
| `withBrowserPage` / `browserImageFetcher` / `fetchViaBrowser` / `waitForBrowserClosed` / `waitForStableContent` / `findBrowser` | `src/utils/browser-fetch.ts` |
| `localizeImages` / `fetchHttpImage` | `src/utils/image-localizer.ts` |
| `clip` / `matchTemplate` | `src/api.ts` |
| `sanitizeFileName` | `src/utils/string-utils.ts` |
| 构建入口 | `scripts/build-cli.mjs`（`npm run build:cli`） |
