# Agent Note: 桌面客户端设置收编进原生设置槽位体系

Status: implemented

[English](2026-08-15-desktop-settings-native-section.md) | 中文

Cross-links: [Windows 桌面壳](2026-08-14-windows-desktop-shell.md)（本次修改的壳）、[槽位类型链实现](2026-07-22-slot-type-chain-implementation.md)（采用的组合路线）、[GUI 分层与 RPC 协议](2026-07-19-gui-layering-and-rpc-protocol.md)（壳桥接边界）。

## Problem

桌面壳向引擎的 Web GUI 注入自有的左下角 ⚙ 浮层（`did-finish-load` 脚本注入，`apps/desktop/src/settings-overlay.ts` 与 `market/settings-overlay.js`），用于展示壳所拥有的动作：引擎状态/重启、开机自启、壳语言、壳/引擎更新检查、插件市场窗口与退出。注入的悬浮按钮盖住了 GUI 自己的设置入口，把壳层 chrome 重复实现在客户端槽位体系之外，并把壳 UI 绑在主进程的页面注入路径上。

## Decision

壳设置改为普通客户端插件 `packages/client/ui-shell-settings`（`@deepseek-ai/dsh-client-ui-shell-settings`）交付，向原生设置页贡献一个 `settings.section` 列表条目（id `shell`，order 20）——与内置的通用/模型/插件分区同槽。该分区仅在 `window.shell` 存在时注册（桌面主窗口 preload 桥，`apps/desktop/market/main-preload.cjs`），因此普通浏览器会话不会渲染任何桌面 chrome。其行内容是走该桥的普通回调（`state`、`setLocale`、`setLoginItem`、`restartEngine`、`checkShellUpdates`、`checkEngineUpdates`、`openMarket`、`quit`）；引擎侧行为全部由壳主进程拥有。分区对桥的原始状态逐字段校验（`normalizeShellState`），因为 preload 是线路边界。浮层已删除：`settings-overlay.ts`、`market/settings-overlay.js`、其 spec 以及 `main.ts` 中的 `did-finish-load` 注入。

该包接入全部标准客户端注册面：`tsconfig.client.json` 聚合引用、`packages/bundle/web-app/cordis.patch.yml` 中的 `dsh.client` 行、`web-app` 依赖、`tsconfig.base.json` paths 映射，以及重新生成的 `slot-catalog.ts`。

## Alternatives considered

**保留浮层并挪位置。** 否决：任何由壳注入的悬浮 chrome 都会与 Web 界面自身的 UI 竞争，且绕开客户端栈唯一的组合路线——槽位体系，同时仍依赖页面注入路径。

**仅托盘设置。** 否决：需求是在客户端 UI 内触达设置；托盘保留其功能，但不是界面内入口。

**独立的壳自有设置窗口。** 否决：与 Web 设置页及其分区列表重复；原生分区免费复用该页面、文案 locale 服务与分区导航。

## Consequences

- 主窗口 preload 桥保留为线路边界；GUI 只经分区注入面触达壳 IPC，无桥时分区不存在，因此普通浏览器会话与快照不受影响。
- 打包引擎必须先发布本包，打包客户端才会出现该分区：npm 发布的 `dsh` web-app 包早于本包，而开发仓库引擎在重建 Web 后即可见。托盘保留全部功能，打包客户端期间无功能损失。
- locale `<select>` 在 await 之前先取 `event.target.value`：React 受控 select 的重渲染（busy 状态）会在写入进行中重置 DOM 值，await 之后再读会丢失用户选择。
