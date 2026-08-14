/**
 * Icon assets: the committed build/icon.png is a real PNG large enough for
 * the macOS target, and build/icon.ico is a structurally valid one-entry
 * PNG-in-ICO container. The bytes come from `scripts/convert-icon.cjs`
 * (Electron nativeImage resize of the branding source), so this suite checks
 * structure, not generator determinism.
 * @module @deepseek-ai/dsh-desktop/tests/icon-assets
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))

describe('committed icon assets', () => {
  it('icon.png is a real PNG of at least 512px (macOS target requirement)', () => {
    const png = readFileSync(join(buildDir, 'icon.png'))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512)
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(512)
  })

  it('icon.ico is a valid one-entry container wrapping a PNG', () => {
    const ico = readFileSync(join(buildDir, 'icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0) // reserved
    expect(ico.readUInt16LE(2)).toBe(1) // type: icon
    expect(ico.readUInt16LE(4)).toBe(1) // count: one entry
    expect(ico.readUInt32LE(18)).toBe(22) // entry points at offset 22
    const pngLength = ico.readUInt32LE(14)
    expect(ico.length).toBe(22 + pngLength)
    const embedded = ico.subarray(22)
    expect(embedded.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(embedded.readUInt32BE(16)).toBe(256) // 256x256 entry
    expect(embedded.readUInt32BE(20)).toBe(256)
  })
})
