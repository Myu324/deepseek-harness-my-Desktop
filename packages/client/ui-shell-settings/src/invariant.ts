/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-shell-settings`.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-shell-settings'

/** Cordis companion plugin name. */
export const name = 'client-ui-shell-settings-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings section is a slot-ledger registration,
 * and the actions it renders call the Electron shell bridge owned by the
 * desktop main process — both surfaces have their own authoritative owners.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
