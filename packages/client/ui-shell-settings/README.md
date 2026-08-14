# @deepseek-ai/dsh-client-ui-shell-settings

English | [中文](README.zh.md)

Desktop-shell settings section for the Web GUI. The browser half registers one `settings.section` (id `shell`, after the General and Models sections) that renders engine status and restart, launch-at-login, the client UI language, shell and engine update checks, the plugin marketplace, and quit — every action is a plain callback over the `window.shell` preload bridge the desktop client's main window exposes. The section registers only when that bridge exists, so a plain browser session never sees desktop-only chrome; the Electron main process owns every engine-side behavior the callbacks trigger.

## Model Experience

None, as the settings section is browser-side presentation chrome over the desktop shell bridge; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The packaged engine must publish this package first** — the npm-published `dsh` web-app bundle predates this package, so the Desktop Client section appears in a packaged client only after a release that includes it; development-repository engines show it after a web rebuild.
