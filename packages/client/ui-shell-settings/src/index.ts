/**
 * Desktop-shell settings plugin, node half.
 *
 * Deliberately empty. The engine-side functions the settings section calls
 * (engine restart, update checks, the marketplace window, quit) belong to the
 * Electron shell main process, which is a different runtime from the dsh host
 * — the browser half reaches it through the window.shell preload bridge, not
 * through a host row. Nothing on the host plane needs this plugin.
 */

/** Host plugin body — all behavior lives in the browser half over the shell bridge. */
export function apply(): void {}
