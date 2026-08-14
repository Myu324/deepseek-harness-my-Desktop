# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Harness 的 Windows 桌面壳。它是现有 Web 产品之上的薄原生宿主：Electron 主进程把 `dsh --profile web` 引擎作为子进程启动在回环端口上，并在原生窗口中加载引擎的 Web GUI。一切持久状态——会话、设置、已装插件——都留在引擎的 Harness home（`~/.dsh`，Windows 即 `%USERPROFILE%\.dsh`）；本包只负责窗口、引擎子进程生命周期与壳层日志。

## 引擎发现

`locateEngine` 按以下顺序解析引擎：

1. `DSH_ENGINE_SCRIPT` —— 显式指定引擎入口脚本（`DSH_ENGINE_NODE` 选择 node 二进制）。
2. `DSH_ENGINE_DIR` —— 受管引擎目录，须含 `node_modules/@deepseek-ai/dsh/lib/bin.js`；捆绑的 node 边车（`runtime/node/node.exe`）优先，其次 `DSH_ENGINE_NODE`，再其次 PATH。显式目录缺 bin 时响亮失败。
3. 默认受管引擎仓库 —— `%LOCALAPPDATA%\DeepSeekHarness\engine`（其他平台为 `~/.dsh/engine`）。其 `current` 指针指名 `versions/` 下的一个版本；旧版 `<root>/current` 目录布局仍可解析。引擎仓库在这里安装与切换版本。
4. 开发仓库 —— 在仓库内运行壳时使用源启动引擎（经 `node --import tsx/esm` 运行 `apps/cli/src/bin.ts`，与 `pnpm dsh` 同一入口）。

## 引擎仓库

`updateEngine` 执行完整受管更新流：按频道查询 registry dist-tag；预置便携 node 边车（`%LOCALAPPDATA%\DeepSeekHarness\engine\runtime\node`，只下载一次，其自带 npm 驱动安装）；把版本并列装进 `versions/<version>/`；在隔离的 Harness home 上真正启动该版本作为健康检查；然后移动 `current` 与 `last-good` 指针并裁剪旧版本。健康检查失败的版本保留安装但永不激活；启动失败回退到 `last-good`。真实环境的完整流程可运行：

```sh
node --import tsx/esm apps/desktop/scripts/engine-store-e2e.mjs <storeRoot>
```

## 插件市场

托盘的 **Plugin Marketplace** 打开一个壳自有窗口，展示精选 feed（`apps/desktop/plugin-feed.json`，经仓库 raw URL 服务；壳设置的 `pluginFeedUrl` 可指向别处）。每个 feed 条目声明其 npm spec、来源仓库、官方/社区信任级别与构建所针对的引擎 semver 范围，并可带 `titleZh`/`descriptionZh` 中文字段（中文界面优先显示）；页面将其与实时 profile 合并，提供安装（家族聚合包一键装齐）、更新、卸载，以及基于清单快照的回滚。安装走真实的 `dsh plugin --profile web` pnpm 前向器：pnpm 由引擎仓库运行时目录预置（`runtime/pnpm`，用自带 npm 安装）并前置进命令 PATH。pnpm 会拦截未经评审的构建脚本；市场把 profile workspace 里 pnpm 写入的 `allowBuilds` 占位条目解析为评审策略——`cloudflared: true`（SSH 隧道需要的预编译二进制）、`ssh2`/`cpu-features: false`（用户机无法编译的可选原生绑定）——评审集之外的包保持拦截并响亮失败。新插件只需在 feed 加条目并推送，所有已装客户端即可看到，无需重新打包。真实环境的完整流程可运行：

```sh
node --import tsx/esm apps/desktop/scripts/plugin-market-e2e.mjs <storeRoot>
```

## 安装

安装器只携带壳本体（约 100 MB）；引擎、便携 node 运行时与插件按需下载，因此最终用户机器不需要 Node.js、pnpm 或 git。

1. 用 `pnpm --filter @deepseek-ai/dsh-desktop run pack` 构建产物（或从 CI 发布页获取）；产物位于 `apps/desktop/.artifacts/`。
2. `DeepSeek Harness Setup <version>.exe` —— 按用户安装的 NSIS 安装器，无需管理员权限；安装到 `%LOCALAPPDATA%`，完成后可立即启动。
3. `DeepSeek Harness <version>.exe` —— 便携版，放在任意位置直接运行。
4. 首次启动：壳显示准备页并预置引擎仓库（便携 node 边车 + 从 npm 安装引擎，全新机器约 3–5 分钟），随后自动打开主界面。之后引擎版本在后台自动更新，插件从托盘的 Plugin Marketplace 安装。

## macOS

同一套壳在 Mac 上或「Desktop artifacts」CI 工作流（macOS runner）产出 dmg 与 zip：

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run pack:mac   # dmg + zip into .artifacts
```

dmg 组装必须在 macOS 上进行（hdiutil），Windows 主机无法构建。一键脚本 `apps/desktop/scripts/build-mac.sh` 在干净的 Mac 上执行上面全部流程（环境检查、克隆、安装、构建、组装），也支持 `bash <(curl -fsSL https://raw.githubusercontent.com/Myu324/deepseek-harness-my-Desktop/master/apps/desktop/scripts/build-mac.sh)` 直接运行。引擎仓库会预置 macOS 的 node 边车（按架构区分 tar.gz），引擎同样从 npm 安装。分发前注意两点：未签名构建会被 Gatekeeper 拦截——接收方右键 → 打开（或执行 `xattr -d com.apple.quarantine`）；正式分发需要 Apple Developer 证书并做 notarization，届时把 `mac.hardenedRuntime` 改回 true。

## 开发

```sh
pnpm run build:web            # the engine serves apps/web/dist — build it once
pnpm --filter @deepseek-ai/dsh-desktop run dev   # tsc + tsdown + electron .
pnpm --filter @deepseek-ai/dsh-desktop run pack  # NSIS installer + portable zip into .artifacts
```

Electron 二进制与 NSIS 工具链默认从 GitHub 下载；设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 可加速。壳把引擎输出记到 `<userData>/logs/engine.log`，壳设置位于 `<userData>/settings.json`。

## 当前范围

单实例壳；引擎 spawn 带自动空闲端口选择与 EADDRINUSE 重试；就绪判定走引擎的 `dsh web:` 公告行，HTTP 探测兜底；沙箱窗口加载引擎 URL；托盘菜单（打开/重启引擎/开机自启/语言/壳更新/引擎更新/插件市场/退出）；关窗驻留托盘使定时任务继续运行；更新事件的系统通知；壳自更新接线（electron-updater，仅打包安装启用）；受管引擎版本仓库（健康检查、原子指针切换、last-good 回退）；基于 `dsh plugin` 前向器的插件市场；壳界面与市场页双语（默认中文，托盘「语言」菜单或页面选择器切换）；electron-builder 打包（按用户 NSIS + 便携 zip）。所有运行时依赖都打进 `lib/main.js`，打包产物不带 node_modules。
