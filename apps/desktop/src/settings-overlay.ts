/**
 * The shell settings overlay the main window injects into the engine's Web
 * GUI: a fixed bottom-left gear button that opens a panel mirroring the tray
 * functions — engine status and restart, launch-at-login, language, shell
 * and engine update checks, the plugin marketplace, and quit. The overlay is
 * a document-level sibling of the GUI root, so it survives the app's own
 * re-renders; the injected script is idempotent per page load and only ever
 * injects on the engine's loopback origin.
 * @module @deepseek-ai/dsh-desktop/settings-overlay
 */

/** The window flag the injected script sets, so repeated loads never double-inject. */
export const OVERLAY_FLAG = '__dshShellOverlay'

/**
 * Wrap the overlay source in the double-injection guard.
 * @param source - the raw overlay script (market/settings-overlay.js).
 * @returns the guarded script to execute in the engine page.
 */
export function overlayScriptFromSource(source: string): string {
  return `if (window.${OVERLAY_FLAG} !== undefined) { void 0 } else {\n${source}\n}`
}
