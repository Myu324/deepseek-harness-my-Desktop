// Deterministic placeholder icon generator for the desktop shell: a
// blue rounded square with a white pixel-art "H", emitted as PNG and
// Vista-style PNG-in-ICO (the NSIS installer icon). Zero dependencies, so the
// bytes are reproducible anywhere; tests pin the committed files to the
// generator output. Swap this file for real branding assets later.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

/** CRC-32 over one byte buffer (PNG chunk checksums). */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Whether a pixel lies inside the rounded-square background. */
function inRoundedRect(x, y, size, radius) {
  const min = 0
  const max = size - 1
  if (x < min || x > max || y < min || y > max) return false
  const cornerX = x < radius ? radius - x : x > max - radius ? x - (max - radius) : 0
  const cornerY = y < radius ? radius - y : y > max - radius ? y - (max - radius) : 0
  return cornerX === 0 || cornerY === 0 || cornerX * cornerX + cornerY * cornerY <= radius * radius
}

/** RGBA pixels of the placeholder icon: blue rounded square + white "H". */
function iconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = Math.round(size * 0.22)
  const bar = Math.round(size * 0.125)
  const left = Math.round(size * 0.28)
  const right = Math.round(size * 0.72)
  const top = Math.round(size * 0.24)
  const bottom = Math.round(size * 0.76)
  const midTop = Math.round(size * 0.44)
  const midBottom = Math.round(size * 0.56)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      const inBar = (x >= left && x < left + bar || x >= right - bar && x < right) && y >= top && y < bottom
        || x >= left && x < right && y >= midTop && y < midBottom
      if (!inRoundedRect(x, y, size, radius)) continue
      if (inBar) {
        pixels[offset] = 255
        pixels[offset + 1] = 255
        pixels[offset + 2] = 255
      } else {
        pixels[offset] = 29
        pixels[offset + 1] = 78
        pixels[offset + 2] = 216
      }
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

/**
 * Encode one RGBA buffer as a PNG.
 * @param size - square side length in pixels.
 * @param pixels - `size * size * 4` RGBA bytes.
 * @returns the PNG file bytes.
 */
export function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const scanlines = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y += 1) {
    scanlines[y * (1 + size * 4)] = 0 // filter: none
    pixels.copy(scanlines, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Generate the placeholder icon PNG at one size.
 * @param size - square side length in pixels.
 * @returns the PNG file bytes.
 */
export function generateIconPng(size = 1024) {
  return encodePng(size, iconPixels(size))
}

/**
 * Wrap PNG bytes in a Vista-style ICO container (one 256x256 entry).
 * @param png - the embedded PNG bytes.
 * @returns the ICO file bytes.
 */
export function generateIconIco(png) {
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

/** Write the committed icon assets. Run from anywhere: `node apps/desktop/scripts/gen-icons.mjs`. */
function main() {
  const png = generateIconPng()
  const ico = generateIconIco(png)
  const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(join(buildDir, 'icon.png'), png)
  writeFileSync(join(buildDir, 'icon.ico'), ico)
  console.log(`wrote ${join(buildDir, 'icon.png')} (${png.length} bytes) and ${join(buildDir, 'icon.ico')} (${ico.length} bytes)`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
