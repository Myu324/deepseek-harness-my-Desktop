/**
 * Icon assets stay byte-identical to the deterministic generator, so a
 * rebuild can never silently swap branding bytes, and the committed ICO
 * container is structurally valid.
 * @module @deepseek-ai/dsh-desktop/tests/gen-icons
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateIconIco, generateIconPng } from '../scripts/gen-icons.mjs'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))

describe('committed icon assets', () => {
  it('icon.png matches the deterministic generator output', () => {
    const generated = generateIconPng(1024)
    const committed = readFileSync(join(buildDir, 'icon.png'))
    expect(committed.equals(generated)).toBe(true)
  })

  it('icon.ico wraps the same PNG in a valid one-entry container', () => {
    const png = generateIconPng(1024)
    const committed = readFileSync(join(buildDir, 'icon.ico'))
    expect(committed.equals(generateIconIco(png))).toBe(true)
    // ICO header: reserved 0, type 1 (icon), count 1; entry points at offset 22.
    expect(committed.readUInt16LE(0)).toBe(0)
    expect(committed.readUInt16LE(2)).toBe(1)
    expect(committed.readUInt16LE(4)).toBe(1)
    expect(committed.readUInt32LE(18)).toBe(22)
    expect(committed.readUInt32LE(14)).toBe(png.length)
  })
})
