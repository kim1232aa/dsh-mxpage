/**
 * Browser-half entry for the dsh-mxpage plugin — runs inside the dsh web GUI.
 *
 * Two surfaces:
 *
 * 1. The settings card — registered into the REAL `settings.plugin.item` slot
 *    that `@deepseek-ai/dsh-client-ui-settings-plugins` declares (设置 → 插件
 *    → MxPage), through `ctx.settingsScope.bind()`. This is the mechanism
 *    `@dickpy/dsh-imagegen` uses for its own settings card.
 *
 *    INCIDENT (fixed here): an earlier version registered no card at all — it
 *    only mounted DOM surfaces (a sidebar toggle + a hand-inserted panel
 *    container) and never touched `ctx.slots` / `ctx.settingsScope`. The host
 *    side (`src/index.ts`) DOES register the `mxpage` settings namespace
 *    through `ctx.settings.installSection`, which makes the namespace exist
 *    and readable/writable — but nothing rendered a FORM for it, because the
 *    card that fills `settings.plugin.item` is a browser-side contribution a
 *    plugin must make itself. Result: 设置 → 插件 → MxPage showed no card at
 *    all, and every `mxpage_*` tool call failed with "未配置任何渠道" because
 *    there was no way to fill the namespace through the GUI (only by hand-
 *    editing `cordis.patch.yml` and restarting).
 *
 * 2. The panel + sidebar toggle — kept as DOM-level mounts (see mount.tsx):
 *    the panel takes over the centre column and the toggle sits in the
 *    sidebar, both self-contained and DOM-observed so they degrade instead of
 *    breaking the shell on a version mismatch.
 *
 * Failure policy for BOTH surfaces, copied deliberately from
 * `@dickpy/dsh-imagegen`: mounting problems are logged, never thrown. The web
 * shell fails the whole boot when a plugin `apply` throws, and an external
 * plugin must not take the GUI down.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

import type { Config as MxpageConfig } from '../config.ts'
import { mountPanel, mountSidebarToggle } from './mount.tsx'
import { MxpageSettingsCard } from './settings-card.tsx'

/** The settings namespace this plugin's host half registers (src/index.ts). */
const SETTINGS_NAMESPACE = 'mxpage'

/**
 * `settingsScope` and `slots` come from optional child fibers: a shell
 * version without either simply never mounts the settings card, degrading to
 * "no card" rather than a failed boot. `connection` is read opportunistically
 * (see below), never injected, for the same reason.
 */
export const inject: string[] = []

export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []

  // -- panel + sidebar toggle (DOM-level; see mount.tsx) ----------------------
  try {
    const panel = mountPanel()
    disposers.push(() => panel.dispose())

    disposers.push(
      mountSidebarToggle(
        () => panel.toggle(),
        'MxPage',
        '打开 MxPage 电商图文工作台',
      ),
    )

    try {
      const connection = ctx.get('connection') as { isLoopback?: boolean } | undefined
      if (connection && connection.isLoopback === false) {
        console.warn(
          '[dsh-mxpage] opened from a non-loopback origin: the panel bridge is loopback-only, so requests will be refused.',
        )
      }
    } catch {
      // connection is optional; its absence is not an error
    }
  } catch (error) {
    console.warn('[dsh-mxpage] panel mount failed:', error)
  }

  // -- settings card: 设置 → 插件 → MxPage -------------------------------------
  ctx.inject(['settingsScope', 'slots'], (sctx) => {
    sctx.effect(() => {
      const scope = sctx.settingsScope.bind<MxpageConfig>({ namespace: SETTINGS_NAMESPACE })
      const dispose = sctx.slots.inject('settings.plugin.item', () =>
        sctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: SETTINGS_NAMESPACE,
            inject: () => ({ scope }),
          },
          MxpageSettingsCard,
        ),
      )
      return dispose
    })
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // never let teardown break the GUI
      }
    }
  })
}
