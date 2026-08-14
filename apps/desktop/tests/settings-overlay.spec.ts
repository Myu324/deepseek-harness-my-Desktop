/**
 * Settings overlay injection: the guard wrapper keeps the script idempotent.
 * @module @deepseek-ai/dsh-desktop/tests/settings-overlay
 */

import { describe, expect, it } from 'vitest'
import { OVERLAY_FLAG, overlayScriptFromSource } from '../src/settings-overlay.ts'

describe('overlayScriptFromSource', () => {
  it('wraps the source in the double-injection guard', () => {
    const script = overlayScriptFromSource('window.__marker = true')
    expect(script).toContain(`if (window.${OVERLAY_FLAG} !== undefined)`)
    expect(script).toContain('window.__marker = true')
  })
})
