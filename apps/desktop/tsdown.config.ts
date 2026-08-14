import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one entry: the Electron main process. The root
 * tsdown workspace build emits `lib/types/main.js` first via tsc, so this
 * override points at it; declarations come from `tsc -b` (dts: false),
 * matching every package.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Electron injects its API module into the main-process runtime; bundling
  // the npm package would inline its CJS launcher shim instead. Every other
  // dependency is bundled deliberately: the packaged app ships a single
  // bundle with no node_modules, which sidesteps packager/workspace-protocol
  // resolution entirely.
  deps: {
    neverBundle: ['electron'],
  },
})
