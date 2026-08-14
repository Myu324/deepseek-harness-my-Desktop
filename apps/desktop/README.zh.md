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

托盘的 **Plugin Marketplace** 打开一个壳自有窗口，用 webview 内嵌社区主题页（壳设置的 `communityPageUrl`，默认 `https://github.com/topics/dsh-plugin`）——不爬取任何 GitHub 接口——头部带后退与主页按钮，底部提供终端。在社区页找到合适的插件后，用命令安装：`add <包名或 git 地址>`（另有 `remove <名称>`、`update <名称>`、`install`、`rollback`）。终端逐行流式显示真实 `dsh plugin --profile web` 的输出，安装完成后点 **重启客户端** 按钮重启应用生效。webview 上方是本地随包附带的 `apps/desktop/plugin-feed.json` 精选快捷命令条（点击即填入命令）。安装走 pnpm 前向器：pnpm 由引擎仓库运行时目录预置（`runtime/pnpm`，用自带 npm 安装）；pnpm 的 `allowBuilds` 占位条目解析为评审集（`cloudflared: true`、`ssh2`/`cpu-features: false`）加 true（用户已批准安装）。真实环境的完整流程可运行：

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

Electron 二进制与 NSIS 工具链默认从 GitHub 下载；设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 可加速。壳把引擎输出记到 `<userData>/logs/engine.log`，壳设置位于 `<userData>/settings.json`。更换品牌图标：`pnpm --filter @deepseek-ai/dsh-desktop run icons -- <source.png>`（Electron 缩放为 1024px 窗口/macOS 图标与 256px ICO；`icons:placeholder` 重新生成像素占位图）。

## 当前范围

单实例壳；引擎 spawn 带自动空闲端口选择与 EADDRINUSE 重试；就绪判定走引擎的 `dsh web:` 公告行，HTTP 探测兜底；沙箱窗口加载引擎 URL，其原生设置页多出一个「桌面客户端」分区——`settings.section` 贡献（`packages/client/ui-shell-settings`），仅在桌面 `window.shell` 桥存在时注册，与托盘功能镜像（引擎状态/重启、开机自启、语言、壳/引擎更新检查、插件市场、退出）；关窗驻留托盘使定时任务继续运行；更新事件的系统通知；壳自更新接线（electron-updater，仅打包安装启用）；受管引擎版本仓库（健康检查、原子指针切换、last-good 回退）；插件市场（内嵌社区 webview + 终端安装 + 客户端重启）；壳界面双语（默认中文，托盘「语言」菜单、设置分区或市场选择器切换）；electron-builder 打包（按用户 NSIS + 便携 zip）。所有运行时依赖都打进 `lib/main.js`，打包产物不带 node_modules。
