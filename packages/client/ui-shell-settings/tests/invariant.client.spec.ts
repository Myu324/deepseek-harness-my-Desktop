/**
 * Invariant companion and node-half entry: the companion registers under the
 * package name with an inert installer; the node half is a deliberate no-op.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/tests/invariant
 */
// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import { apply as nodeApply } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers under the package name with an inert installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(Invariant).await()).resolves.toBeDefined()
  })
})

describe('node half', () => {
  it('apply is an inert no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
