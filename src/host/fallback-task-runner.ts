/**
 * TaskRunner composition: host job registry first, local queue as fallback.
 *
 * Why this exists: in some profiles the `jobs` registry service is present but
 * unusable for this plugin — `start()` throws synchronously with "no job
 * controller serves this agent" when no attached controller owns the calling
 * agent. Presence of the service is therefore not proof of usability, and the
 * refusal only surfaces at call time. When that specific refusal happens the
 * work transparently moves to the in-process queue so panel/page generation
 * still runs instead of dying with "background jobs unavailable".
 */

import type { TaskHandle, TaskRunner, TaskSpec, TaskState } from '../core/ports/tasks.ts'

const NO_CONTROLLER = /no job controller|background jobs unavailable/i

export function createFallbackTaskRunner(primary: TaskRunner, fallback: TaskRunner): TaskRunner {
  /** Which runner actually accepted each id, for get/status routing. */
  const used = new Map<string, TaskRunner>()

  return {
    start<T>(spec: TaskSpec<T>): TaskHandle {
      try {
        const handle = primary.start(spec)
        used.set(handle.id, primary)
        return handle
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!NO_CONTROLLER.test(message)) throw err
        const handle = fallback.start(spec)
        used.set(handle.id, fallback)
        return handle
      }
    },

    get(id: string): TaskHandle | undefined {
      const owner = used.get(id)
      return owner?.get?.(id) ?? primary.get?.(id) ?? fallback.get?.(id)
    },

    status(id: string): TaskState {
      const owner = used.get(id)
      const known = owner?.status?.(id)
      if (known && known !== 'unknown') return known
      const fallbackState = fallback.status?.(id)
      if (fallbackState && fallbackState !== 'unknown') return fallbackState
      return primary.status?.(id) ?? 'unknown'
    },
  }
}
