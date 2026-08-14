// Convert a source PNG into the client's build assets using Electron's
// nativeImage: build/icon.png at 1024x1024 (window, tray, macOS icon) and
// build/icon.ico as a 256x256 PNG-in-ICO (Windows installer). Run with
// Electron — nativeImage needs the Electron runtime:
//   pnpm --filter @deepseek-ai/dsh-desktop exec electron scripts/convert-icon.cjs -- <source.png>
const { app, nativeImage } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

/** Wrap PNG bytes in a Vista-style ICO container (one 256x256 entry). */
function wrapIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256
  entry[1] = 0 // height 256
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // data offset
  return Buffer.concat([header, entry, png])
}

// argv = [electron.exe, this script, ...args]; the source is the first
// non-flag argument after the script.
const source = process.argv.slice(2).find(argument => !argument.startsWith('--'))
if (source === undefined || source === '') {
  console.error('usage: electron scripts/convert-icon.cjs -- <source.png>')
  app.exit(1)
} else {
  void app.whenReady().then(() => {
    const image = nativeImage.createFromPath(resolve(source))
    if (image.isEmpty()) {
      console.error(`cannot read the source icon at ${source}`)
      app.exit(1)
      return
    }
    const png1024 = image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
    const png256 = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG()
    const ico = wrapIco(png256)
    const buildDir = join(__dirname, '..', 'build')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, 'icon.png'), png1024)
    writeFileSync(join(buildDir, 'icon.ico'), ico)
    console.log(`wrote ${join(buildDir, 'icon.png')} (${png1024.length} bytes) and ${join(buildDir, 'icon.ico')} (${ico.length} bytes)`)
    app.exit(0)
  })
}
