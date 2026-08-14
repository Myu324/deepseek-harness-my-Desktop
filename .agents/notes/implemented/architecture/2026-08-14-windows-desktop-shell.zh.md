# Agent Note: Windows 桌面客户端作为 Web 引擎之上的薄壳

Status: implemented

[English](2026-08-14-windows-desktop-shell.md) | 中文

交叉链接：[GUI 分层与 RPC 协议](2026-07-19-gui-layering-and-rpc-protocol.md)（部分取代其中假想的 Electron 载体）、[profile 插件组合包](2026-08-05-profile-plugin-bundles.md)（复用的 pnpm 前向器）。

## Problem

产品只能通过 `pnpm dsh web` 加浏览器使用。用户想要一个真正的 Windows 应用，包含现有全部功能、快捷安装插件，并且自动更新永远不需要拉仓库、构建、重新打包客户端。

## Decision

**桌面客户端是现有 Web 产品之上的薄原生壳，而不是第二个应用。** `apps/desktop`（`@deepseek-ai/dsh-desktop`，Electron 主进程）把打包好的 `dsh --profile web` 引擎作为子进程启动在回环端口上，并在原生沙箱窗口中加载引擎的 Web GUI。GUI、其客户端插件与 `__DSH_BOOT__` 插件图就是引擎原封不动的 Web 表层；壳只负责窗口、引擎子进程生命周期与壳日志。一切持久状态（会话、设置、已装插件）都留在引擎的 Harness home，因此壳可以整体替换而不触碰状态。

`locateEngine` 按序解析引擎：`DSH_ENGINE_SCRIPT`（显式入口，`DSH_ENGINE_NODE` 选择 node 二进制）→ `DSH_ENGINE_DIR`（受管引擎目录，须含 `node_modules/@deepseek-ai/dsh/lib/bin.js`；捆绑的 `runtime/node/node.exe` 边车优先，其次 `DSH_ENGINE_NODE`，再其次 PATH；显式目录缺 bin 时响亮失败）→ 默认受管目录 `%LOCALAPPDATA%\DeepSeekHarness\engine\current`（其他平台为 `~/.dsh/engine/current`）→ 开发仓库，走与 `pnpm dsh` 相同的 tsx 源启动向量。壳挑选空闲端口（OS 分配后经 `--port` 传入），EADDRINUSE 退出时换新端口重试，把引擎的 `dsh web:` 公告行当作权威就绪信号，HTTP 探测兜底，就绪预算有界。

**更新拆成三条独立版本化的通道，用户永远不需要构建任何东西。**

- 壳经 electron-updater 对 GitHub Releases 低频更新；引擎与插件靠下载更新。
- 引擎是发布到 npm 的 `@deepseek-ai/dsh` 包。壳的更新管理器把新版本并列安装进带版本号的引擎目录，原子切换 `current` 指针，切换前用 `--port 0` 对候选做健康检查，失败自动回滚到 last-good 版本。引擎更新需要便携 node 边车（引擎要求 Node `^22.19 || >=24`，Electron 内置 node 低于该要求，因此拒绝 `ELECTRON_RUN_AS_NODE`）。
- 插件沿用现有 profile/pnpm 前向器；市场 UI 在注册表 feed 之上包装 `dsh plugin`（安装/卸载/更新/回滚），web-ui-all 全家桶一键可达。

壳按里程碑顺序交付：M1——引擎发现、spawn 握手、窗口、仓库集成；M2——托盘常驻（关窗隐藏到托盘，定时任务继续运行）、更新事件的系统通知、开机自启、引擎重启、基于 electron-updater 的壳自更新接线（仅打包安装时检查）、electron-builder 打包（按用户 NSIS + 便携 zip）；M3——受管引擎版本仓库：便携 node 边车（一次下载，其自带 npm 驱动安装）、并列 `versions/<version>/` 安装、`current`/`last-good` 指针文件、在隔离 Harness home 上的真实启动健康检查、启动失败回退 last-good、旧版本裁剪；M4——插件市场：精选 feed（`apps/desktop/plugin-feed.json`，经仓库 raw URL 服务）与实时 profile 在壳自有窗口合并展示，安装/更新/卸载走真实 `dsh plugin --profile web` pnpm 前向器（pnpm 预置进仓库 `runtime/pnpm` 并前置 PATH），逐条目信任/兼容性展示、基于清单快照的回滚，以及把 pnpm 的 `allowBuilds` 占位条目解析为评审决策的构建脚本策略（`cloudflared: true`；`ssh2`/`cpu-features: false`），而非运行未评审脚本。

## Alternatives considered

**Tauri 壳加 Node 边车。** 拒绝：引擎无论如何都是 Node，Tauri 多引入一套工具链与捆绑运行时方案，却不能省掉 Electron 自带的那一个。

**在 Electron 主进程内跑引擎。** 拒绝：窗口 chrome 与 agent 运行时崩溃耦合，插件安装无法独立重启引擎，也没有回滚边界。

**`file://` 渲染层加 IPC fetch 载体**（GUI 分层 note 中勾勒的方案）。推迟：加载引擎的回环 URL 原样复用整个 Web 表层（信任栅栏、客户端插件、HMR 链）；若壳未来需要 HTTP 载体给不了的能力，IPC 桥仍是那条路。这取代了先前 note 中「Electron 不复用 webserver 载体」的说法。

## Consequences

- 壳在退出时终止引擎；Windows `child.kill()` 语义意味着壳不经过引擎的优雅关闭路径就停止引擎——后续里程碑补上协调式关闭握手。
- 主进程自我遏制自身故障：未捕获异常与未处理的 Promise 拒绝写入壳日志（`[main]` 行），不再弹出 Electron 的通用错误对话框；每个 fire-and-forget 的 Promise 启动点（窗口加载、外部链接、设置写入、boot）都带显式 catch——壳必须比自己的错误活得久，因为引擎是独立进程。
- 同一套壳延伸到 macOS：引擎仓库预置 darwin node 边车（按架构区分 tar.gz，经 node-tar 解包），`electron-builder.yml` 带 `mac` 的 dmg/zip 目标（`pack:mac`）；但 dmg 组装、签名与 notarization 只能在 macOS 上进行——`Desktop artifacts` 工作流负责 macOS 构建，Windows 主机无法产出或验证 dmg。
- 壳诊断位于 `<userData>/logs/engine.log`；开发运行用 `DSH_HOME` 隔离引擎，演示绝不触碰真实 profile。
- 打包产物是单一 bundle：tsdown 把所有运行时依赖内联进 `lib/main.js`（仅 `electron` 保持外部化），因此 asar 不带 node_modules，electron-builder 无需解析 pnpm workspace 协议；`electronDist` 复用工作区已装的 Electron dist，不再重复下载。
- `app-builder-lib@26.15.7` 打了补丁（`patches/app-builder-lib@26.15.7.patch`）：它声明的 `@electron/get ^3` 范围缺少其自身 `resolveCacheMode` 所读取的 `ElectronDownloadCacheMode` 导出，导致 NSIS 工具链下载崩溃；补丁改用枚举的数字值。
- 引擎仓库位于 `%LOCALAPPDATA%\DeepSeekHarness\engine`；`current`/`last-good` 是普通指针文件，壳无需 junction 或提权，engine-process 的默认解析读取它们（旧版 `<root>/current` 布局仍可解析）。`apps/desktop/scripts/engine-store-e2e.mjs` 在临时仓库上驱动真实流程——registry 查询、node 下载、npm 安装、健康检查。
- `apps/desktop` 是 dsh 发布家族成员（`apps/*` 约束使每个 app 目录都可发布）；其 npm 包只携带构建后的主 bundle，作为 CI 构建安装器的来源，用户拿到的则是 NSIS/便携产物。
