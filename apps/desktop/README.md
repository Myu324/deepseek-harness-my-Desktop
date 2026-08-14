# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

The DeepSeek Harness Windows desktop shell. It is a thin native host over the existing web product: the Electron main process spawns the `dsh --profile web` engine as a child process on a loopback port and loads the engine's Web GUI in a native window. Everything durable — sessions, settings, installed plugins — stays in the engine's Harness home (`~/.dsh`, i.e. `%USERPROFILE%\.dsh` on Windows); this package owns the window, the engine child lifecycle, and shell-level logging.

## Engine discovery

`locateEngine` resolves the engine in this order:

1. `DSH_ENGINE_SCRIPT` — an explicit engine entry script (`DSH_ENGINE_NODE` selects the node binary).
2. `DSH_ENGINE_DIR` — a managed engine directory containing `node_modules/@deepseek-ai/dsh/lib/bin.js`; a bundled node sidecar at `runtime/node/node.exe` wins, then `DSH_ENGINE_NODE`, then PATH. An explicit directory whose bin is missing fails loudly.
3. The default managed engine store — `%LOCALAPPDATA%\DeepSeekHarness\engine` (or `~/.dsh/engine` on other platforms). Its `current` pointer names a version under `versions/`; a legacy `<root>/current` directory still resolves. The engine store installs and switches versions here.
4. The development repository — running the shell from inside this repo uses the source-launch engine (`apps/cli/src/bin.ts` via `node --import tsx/esm`), the same entry `pnpm dsh` drives.

## Engine store

`updateEngine` performs the whole managed update flow: query the registry dist-tag for the channel, provision the portable node sidecar (`%LOCALAPPDATA%\DeepSeekHarness\engine\runtime\node`, one download, bundled npm drives installs), install the version side-by-side under `versions/<version>/`, boot it against an isolated Harness home as a health check, then move the `current` and `last-good` pointers and prune old versions. A version that fails its health check stays installed but never activates; a boot failure falls back to `last-good`. The real-world flow is runnable with:

```sh
node --import tsx/esm apps/desktop/scripts/engine-store-e2e.mjs <storeRoot>
```

## Plugin marketplace

The tray's **Plugin Marketplace** opens a shell-owned window that embeds the community topic page (`communityPageUrl` in shell settings; default `https://github.com/topics/dsh-plugin`) in a webview — no GitHub API crawling — with back and home buttons in the header, and a terminal at the bottom. Find a plugin on the community page, then install it with a command: `add <package-or-git-url>` (or `remove <name>`, `update <name>`, `install`, `rollback`). The terminal streams the real `dsh plugin --profile web` output line by line, and the **Restart Client** button relaunches the app once the install finishes. A chip strip above the webview carries the curated quick-install specs from the locally shipped `apps/desktop/plugin-feed.json` (clicking a chip fills the command). Installations run through the pnpm forwarder with pnpm provisioned into the engine store's runtime directory (`runtime/pnpm`, installed by the bundled npm); pnpm's placeholder `allowBuilds` entries resolve to the reviewed set (`cloudflared: true`, `ssh2`/`cpu-features: false`) plus `true` for anything else, since the user already approved the install. The real-world flow is runnable with:

```sh
node --import tsx/esm apps/desktop/scripts/plugin-market-e2e.mjs <storeRoot>
```

## Installing

The installer ships the shell only (~100 MB); the engine, the portable node runtime, and plugins download on demand, so the end-user machine needs no Node.js, pnpm, or git.

1. Build the artifacts with `pnpm --filter @deepseek-ai/dsh-desktop run pack` (or take them from a CI release); they land in `apps/desktop/.artifacts/`.
2. `DeepSeek Harness Setup <version>.exe` — a per-user NSIS installer that needs no admin rights; it installs under `%LOCALAPPDATA%` and offers to launch when finished.
3. `DeepSeek Harness <version>.exe` — a portable build; run it from anywhere.
4. First launch: the shell shows a preparing page and provisions the engine store (portable node sidecar + the engine from npm, ~3–5 minutes on a clean machine), then opens the main window automatically. Engine versions update in the background afterwards, and plugins install from the tray's Plugin Marketplace.

## macOS

The same shell builds a dmg and a zip on a Mac or on the `Desktop artifacts` CI workflow (macOS runner):

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run pack:mac   # dmg + zip into .artifacts
```

dmg assembly requires macOS (hdiutil), so it cannot run on Windows hosts. The one-shot `apps/desktop/scripts/build-mac.sh` performs the whole flow above from a clean Mac (prerequisite checks, clone, install, build, assemble), including via `bash <(curl -fsSL https://raw.githubusercontent.com/Myu324/deepseek-harness-my-Desktop/master/apps/desktop/scripts/build-mac.sh)`. The engine store provisions the macOS node sidecar (a per-architecture tar.gz) and the engine installs from npm exactly as on Windows. Two caveats before sharing: the unsigned build trips Gatekeeper — recipients right-click → Open (or run `xattr -d com.apple.quarantine`); real distribution needs an Apple Developer certificate plus notarization, which flips `mac.hardenedRuntime` back on.

## Development

```sh
pnpm run build:web            # the engine serves apps/web/dist — build it once
pnpm --filter @deepseek-ai/dsh-desktop run dev   # tsc + tsdown + electron .
pnpm --filter @deepseek-ai/dsh-desktop run pack  # NSIS installer + portable zip into .artifacts
```

The Electron binary and the NSIS toolset download from GitHub by default; set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` for faster installs. The shell logs engine output to `<userData>/logs/engine.log`, and shell settings live at `<userData>/settings.json`. Replace the branding icon with `pnpm --filter @deepseek-ai/dsh-desktop run icons -- <source.png>` (Electron resizes it to the 1024px window/macOS icon and the 256px ICO; `icons:placeholder` regenerates the pixel-art placeholder).

## Current scope

Single-instance shell; engine spawn with automatic free-port selection and `EADDRINUSE` retry; readiness via the engine's `dsh web:` announcement line with an HTTP-probe fallback; a sandboxed window over the engine URL with an injected bottom-left settings overlay (engine status/restart, launch-at-login, language, shell and engine update checks, marketplace, quit) mirroring the tray; close-to-tray residency so scheduled tasks keep running; shell notifications for update events; shell auto-update wiring (electron-updater, packaged installs only); the managed engine version store with health-checked, atomic pointer switches and last-good fallback; the plugin marketplace with its embedded community webview, terminal installs, and client restart; a bilingual shell chrome (Chinese default, switchable from the tray Language menu, the overlay, or the marketplace selector); and electron-builder packaging (per-user NSIS + portable zip). Every runtime dependency is bundled into `lib/main.js`, so the packaged app ships without node_modules.
