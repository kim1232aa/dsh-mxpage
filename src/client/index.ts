/**
 * Browser-half entry for the dsh-mxpage plugin — runs inside the dsh web GUI.
 *
 * Registers nothing into host slots (external plugins cannot declare slots other
 * than the ones the host already exposes, and the settings card would need a
 * settings scope this plugin does not own). Instead it mounts two DOM surfaces:
 * a sidebar toggle and the workbench in the centre column.
 *
 * Failure policy, copied deliberately from `@dickpy/dsh-imagegen`: DOM mounting
 * problems are logged, never thrown. The web shell fails the whole boot when a
 * plugin `apply` throws, and an external plugin must not take the GUI down.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { mountPanel, mountSidebarToggle } from './mount.tsx'

/**
 * The panel needs no host services beyond the DOM. `connection` is read
 * opportunistically to warn on a non-loopback browser, because the bridge
 * routes are loopback-fenced and would otherwise fail with a bare 403.
 */
export const inject: string[] = []

export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []

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
