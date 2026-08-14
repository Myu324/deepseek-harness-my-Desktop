# Agent Note: Windows desktop client as a thin shell over the web engine

Status: implemented

English | [中文](2026-08-14-windows-desktop-shell.zh.md)

Cross-links: [GUI layering and RPC protocol](2026-07-19-gui-layering-and-rpc-protocol.md) (partial supersession of its hypothetical Electron carrier), [profile plugin bundles](2026-08-05-profile-plugin-bundles.md) (reused pnpm forwarder).

## Problem

The product runs only through `pnpm dsh web` plus a browser. Users want a real Windows application with every current feature, quick plugin installation, and automatic updates that never require pulling the repository, building, and repackaging the client.

## Decision

**The desktop client is a thin native shell over the existing web product, not a second application.** `apps/desktop` (`@deepseek-ai/dsh-desktop`, an Electron main process) spawns the packaged `dsh --profile web` engine as a child process on a loopback port and loads the engine's Web GUI in a native, sandboxed window. The GUI, its client plugins, and the `__DSH_BOOT__` plugin graph are the engine's unchanged web surface; the shell owns the window, the engine child lifecycle, and shell logging. Everything durable (sessions, settings, installed plugins) stays in the engine's Harness home, so the shell can be replaced without touching state.

`locateEngine` resolves the engine in order: `DSH_ENGINE_SCRIPT` (explicit entry, `DSH_ENGINE_NODE` for the node binary) → `DSH_ENGINE_DIR` (a managed engine directory containing `node_modules/@deepseek-ai/dsh/lib/bin.js`; a bundled `runtime/node/node.exe` sidecar wins, then `DSH_ENGINE_NODE`, then PATH; an explicit directory whose bin is missing fails loudly) → the default managed directory `%LOCALAPPDATA%\DeepSeekHarness\engine\current` (or `~/.dsh/engine/current` elsewhere) → the development repository, which runs the same tsx source-launch vector as `pnpm dsh`. The shell picks a free port (OS-assigned, then passed as `--port`), retries once on an `EADDRINUSE` exit, and treats the engine's `dsh web:` announcement line as authoritative readiness with an HTTP probe fallback and a bounded readiness budget.

**Updates split into three independently versioned channels so a user never builds anything.**

- The shell updates rarely via electron-updater against GitHub Releases; the engine and plugins update by download.
- The engine is the npm-published `@deepseek-ai/dsh` package. The shell's update manager installs new versions side-by-side into versioned engine directories, atomically switches a `current` pointer, health-checks the candidate on `--port 0` before switching, and rolls back to the last-good version on failure. Engine updates need a portable node sidecar (the engine requires Node `^22.19 || >=24`; Electron's bundled node is below that, so `ELECTRON_RUN_AS_NODE` is rejected).
- Plugins keep the existing profile/pnpm forwarder; the marketplace UI wraps `dsh plugin` (install/uninstall/update/rollback) over a registry feed, with the web-ui-all family one click away.

The shell milestones ship in order: M1 — engine discovery, spawn handshake, window, repo integration; M2 — tray residency (closing the window hides to the tray so scheduled tasks keep running), shell notifications for update events, launch-at-login, engine restart, shell-update wiring over electron-updater (checked only in packaged installs), and electron-builder packaging (per-user NSIS + portable zip); M3 — the managed engine version store: a portable node sidecar (one download; its bundled npm drives installs), side-by-side `versions/<version>/` installs, `current`/`last-good` pointer files, a real-boot health check against an isolated Harness home, fallback to last-good on a failed boot, and pruning; M4 — the plugin marketplace: a curated feed (`apps/desktop/plugin-feed.json`, served from the repository raw URL) merged with the live profile in a shell-owned window, install/update/uninstall over the real `dsh plugin --profile web` pnpm forwarder (pnpm provisioned into the store's `runtime/pnpm` and prepended to PATH), trust/compatibility display per entry, a manifest-snapshot rollback, and a reviewed build-script policy that resolves pnpm's placeholder `allowBuilds` entries (`cloudflared: true`; `ssh2`/`cpu-features: false`) instead of running unreviewed scripts.

## Alternatives considered

**Tauri shell with a Node sidecar.** Rejected: the engine is Node regardless, so Tauri adds a second toolchain and a bundled-runtime story without removing the one Electron carries.

**Run the engine inside the Electron main process.** Rejected: crash coupling between chrome and agent runtime, no isolated engine restart for plugin installation, and no rollback boundary.

**`file://` renderer plus the IPC fetch carrier** sketched in the GUI-layering note. Deferred: loading the engine's loopback URL reuses the complete web surface (trust fence, client plugins, HMR chain) unchanged; the IPC bridge remains the path if the shell ever needs capabilities the HTTP carrier cannot offer. This supersedes the earlier note's claim that Electron does not reuse the webserver carrier.

## Consequences

- The shell terminates the engine on quit; Windows `child.kill()` semantics mean the shell stops the engine without its graceful shutdown path — later milestones add a coordinated shutdown handshake.
- The main process contains its own failures: uncaught exceptions and unhandled rejections are written to the shell log (`[main]` lines) instead of surfacing Electron's generic error dialog, and every fire-and-forget promise site (window loads, external URLs, settings writes, boot) carries an explicit catch — the shell must outlive its own mistakes because the engine is a separate process.
- The same shell extends to macOS: the engine store provisions darwin node sidecars (per-architecture tar.gz via node-tar) and `electron-builder.yml` carries `mac` dmg/zip targets (`pack:mac`), but dmg assembly, signing, and notarization can only run on macOS — the `Desktop artifacts` workflow owns the macOS build, and the Windows host cannot produce or verify a dmg.
- Shell diagnostics live in `<userData>/logs/engine.log`; development runs isolate the engine with `DSH_HOME` so a demo never touches a live profile.
- The packaged app is one bundle: tsdown inlines every runtime dependency into `lib/main.js` (only `electron` stays external), so the asar ships no node_modules and electron-builder never resolves pnpm workspace protocols; `electronDist` reuses the workspace's Electron dist instead of re-downloading it.
- `app-builder-lib@26.15.7` is patched (`patches/app-builder-lib@26.15.7.patch`): its declared `@electron/get ^3` range lacks the `ElectronDownloadCacheMode` export its own `resolveCacheMode` reads, which crashed the NSIS toolset download; the patch spells the enum's numeric values instead.
- The engine store lives at `%LOCALAPPDATA%\DeepSeekHarness\engine`; `current`/`last-good` are plain pointer files so the shell needs no junctions or elevated privileges, and the engine-process default resolution reads them (a legacy `<root>/current` layout still resolves). `apps/desktop/scripts/engine-store-e2e.mjs` drives the real flow — registry query, node download, npm install, health check — against a scratch store.
- `apps/desktop` is a dsh release-family member (the `apps/*` constraint makes every app directory publishable); its npm package carries the built main bundle and is the CI-facing source for installer builds, while users receive NSIS/portable artifacts.
