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

The tray's **Plugin Marketplace** opens a shell-owned window over the curated feed (`apps/desktop/plugin-feed.json`, served from the repository's raw URL; `pluginFeedUrl` in shell settings points elsewhere if needed). Every feed entry states its install spec, source repository, official/community trust, and — when known — the engine semver range it was built against, with optional `titleZh`/`descriptionZh` fields the page prefers in Chinese; entries without a compatibility range show as unknown. The page merges the feed with the web-ui family's community plugin index (`communityIndexUrl`; entries without an npm field install from their repository as git specs), offers a search box, and opens a per-plugin detail view that renders the plugin's README — npm packages from the registry packument, git installs from the repository's raw README. Install (family bundles in one click), update, uninstall, and a manifest-snapshot rollback run through the real `dsh plugin --profile web` pnpm forwarder, with pnpm provisioned into the engine store's runtime directory (`runtime/pnpm`, installed by the bundled npm) and prepended to the command's PATH. pnpm blocks unreviewed build scripts; the marketplace resolves pnpm's placeholder `allowBuilds` entries in the profile workspace — the reviewed set (`cloudflared: true`, `ssh2`/`cpu-features: false`) plus `true` for anything else, since the user already approved the install in the trust-displaying UI. Adding a feed entry and pushing is enough for every installed client to see the new plugin; no rebuild. The real-world flow is runnable with:

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

The Electron binary and the NSIS toolset download from GitHub by default; set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` for faster installs. The shell logs engine output to `<userData>/logs/engine.log`, and shell settings live at `<userData>/settings.json`.

## Current scope

Single-instance shell; engine spawn with automatic free-port selection and `EADDRINUSE` retry; readiness via the engine's `dsh web:` announcement line with an HTTP-probe fallback; a sandboxed window over the engine URL; a tray with open/restart-engine/launch-at-login/language/shell-updates/engine-updates/marketplace/quit; close-to-tray residency so scheduled tasks keep running; shell notifications for update events; shell auto-update wiring (electron-updater, packaged installs only); the managed engine version store with health-checked, atomic pointer switches and last-good fallback; the plugin marketplace over the `dsh plugin` forwarder; a bilingual shell chrome and marketplace page (Chinese default, switchable from the tray Language menu or the page selector); and electron-builder packaging (per-user NSIS + portable zip). Every runtime dependency is bundled into `lib/main.js`, so the packaged app ships without node_modules.
