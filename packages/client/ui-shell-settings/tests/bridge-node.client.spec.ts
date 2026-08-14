/**
 * readShellBridge outside any DOM: the SSR guard returns undefined when no
 * window exists. Node environment on purpose — the jsdom suites cannot reach
 * the windowless branch.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/tests/bridge-node
 */

import { describe, expect, it } from 'vitest'
import { readShellBridge } from '../src/client/bridge.ts'

describe('readShellBridge without a DOM', () => {
  it('returns undefined when window is absent', () => {
    expect(readShellBridge()).toBeUndefined()
  })
})
