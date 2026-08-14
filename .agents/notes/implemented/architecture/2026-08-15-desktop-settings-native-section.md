# Agent Note: Desktop client settings live in the native settings slot system

Status: implemented

English | [中文](2026-08-15-desktop-settings-native-section.zh.md)

Cross-links: [Windows desktop shell](2026-08-14-windows-desktop-shell.md) (the shell this decision changed), [slot type chain implementation](2026-07-22-slot-type-chain-implementation.md) (the composition route used), [GUI layering and RPC protocol](2026-07-19-gui-layering-and-rpc-protocol.md) (the shell-bridge edge).

## Problem

The desktop shell injected its own bottom-left ⚙ overlay into the engine's Web GUI (`did-finish-load` script injection, `apps/desktop/src/settings-overlay.ts` plus `market/settings-overlay.js`) to surface shell-owned actions: engine status/restart, launch-at-login, shell language, shell/engine update checks, the marketplace window, and quit. The injected floating button covered the GUI's own settings entry, duplicated shell chrome outside the client slot system, and coupled shell UI to the main process's page-injection path.

## Decision

Shell settings ship as a normal client plugin, `packages/client/ui-shell-settings` (`@deepseek-ai/dsh-client-ui-shell-settings`), contributing a `settings.section` list entry (id `shell`, order 20) into the native settings page — the same slot the built-in General/Models/Plugins sections use. The section registers only when `window.shell` exists (the desktop main-window preload bridge, `apps/desktop/market/main-preload.cjs`), so a plain browser session never renders desktop chrome. Its rows are plain callbacks over that bridge (`state`, `setLocale`, `setLoginItem`, `restartEngine`, `checkShellUpdates`, `checkEngineUpdates`, `openMarket`, `quit`); the shell main process owns every engine-side behavior they trigger. The section validates the bridge's raw state per field (`normalizeShellState`) because the preload is a wire edge. The overlay is deleted: `settings-overlay.ts`, `market/settings-overlay.js`, its spec, and the `did-finish-load` injection in `main.ts`.

The package joins every standard client registration surface: the `tsconfig.client.json` aggregate reference, a `dsh.client` row in `packages/bundle/web-app/cordis.patch.yml`, a `web-app` dependency, a `tsconfig.base.json` paths mapping, and the regenerated `slot-catalog.ts`.

## Alternatives considered

**Keep the overlay and reposition it.** Rejected: any shell-injected floating chrome competes with the web surface's own UI and bypasses the slot system — the client stack's only composition route — while still depending on the page-injection path.

**Tray-only settings.** Rejected: the request is to reach settings inside the client UI; the tray keeps its functions but is not an in-GUI surface.

**A separate shell-owned settings window.** Rejected: it duplicates the web settings page and its section list; the native section reuses the page, the copy locale service, and the section navigation for free.

## Consequences

- The main-window preload bridge stays as the wire edge; the GUI reaches shell IPC only through the section's injected face, and the section is absent without the bridge, so plain-browser sessions and snapshots are unaffected.
- The packaged engine must publish this package before the section appears in the packaged client: the npm-published `dsh` web-app bundle predates the package, while development-repository engines show it after a web rebuild. The tray retains every function, so packaged clients lose nothing in the meantime.
- The locale `<select>` captures `event.target.value` before awaiting: React's controlled-select re-render (the busy state) resets the DOM value while the write is in flight, so a post-await read loses the user's choice.
