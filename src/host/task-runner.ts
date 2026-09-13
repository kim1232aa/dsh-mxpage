/**
 * Host implementation of the TaskRunner port.
 *
 * Upstream's `runTaskInBackground` was `void handler().catch(console.error)`:
 * no queue, no scheduler, no re-dispatch after restart, and a cancellation
 * registry disabled in production. This runner is an in-process queue with a
 * concurrency limit — the same shape `@dickpy/dsh-imagegen` uses for its
 * `GenerationTaskQueue`, which is the established pattern for DSH plugins
 * (there is no host job service to delegate to).
 *
 * Durability note: a plugin restart still orphans in-flight work, exactly as
 * upstream. `repository.task.recoverStale` marks such rows FAILED; nothing
 * re-dispatches them, matching upstream semantics.
 */

import { randomUUID } from 'node:crypto'

import type { Repository } from '../core/ports/repository.ts'
import type { TaskHandle, TaskRunner, TaskSpec, TaskState } from '../core/ports/tasks.ts'
import { TaskCanceledError, isTaskCanceledError } from '../core/ports/tasks.ts'

export type TaskOutcome = { ok: true; value: unknown } | { ok: false; error: Error }

interface Entry {
  controller: AbortController
  resolve: (value: TaskOutcome) => void
}

export interface QueuedTaskRunnerOptions {
  repository: Repository
  concurrency?: number
}

export function createQueuedTaskRunner(options: QueuedTaskRunnerOptions): TaskRunner {
  const { repository } = options
  const concurrency = Math.max(1, options.concurrency ?? 2)

  const handles = new Map<string, TaskHandle>()
  const entries = new Map<string, Entry>()
  const queue: Array<{ id: string; spec: TaskSpec<unknown> }> = []
  let running = 0

  /**
   * Terminal states of finished tasks, so `status(id)` keeps answering after
   * the live handle is released. A live end-to-end run caught the gap: the
   * `/job` route fell through to the repository (which has no row under the
   * runner id) and reported `unknown` for every completed job. Bounded — only
   * the most recent states are retained.
   */
  const settled = new Map<string, TaskState>()
  const SETTLED_LIMIT = 200

  function recordSettled(id: string, state: TaskState): void {
    settled.delete(id)
    settled.set(id, state)
    while (settled.size > SETTLED_LIMIT) {
      const oldest = settled.keys().next().value
      if (oldest === undefined) break
      settled.delete(oldest)
    }
  }

  async function execute(id: string, spec: TaskSpec<unknown>): Promise<void> {
    const entry = entries.get(id)
    if (!entry) return
    try {
      const value = await spec.run({
        signal: entry.controller.signal,
        progress: {
          async patch(patch) {
            await repository.task.mergeProgress(id, patch).catch(() => null)
          },
        },
      })
      recordSettled(id, entry.controller.signal.aborted ? 'killed' : 'completed')
      entry.resolve({ ok: true, value })
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      recordSettled(id, isTaskCanceledError(normalized) ? 'killed' : 'failed')
      entry.resolve({ ok: false, error: normalized })
    } finally {
      entries.delete(id)
      handles.delete(id)
    }
  }

  function drain(): void {
    while (running < concurrency) {
      const next = queue.shift()
      if (!next) return
      const handle = handles.get(next.id)
      if (!handle || handle.cancelled) continue
      running += 1
      void execute(next.id, next.spec).finally(() => {
        running -= 1
        drain()
      })
    }
  }

  return {
    start<T>(spec: TaskSpec<T>): TaskHandle {
      const id = `${spec.kind}_${randomUUID().slice(0, 8)}`
      const controller = new AbortController()
      let canceled = false
      let resolveDone!: (value: TaskOutcome) => void
      const done = new Promise<TaskOutcome>((resolve) => {
        resolveDone = resolve
      })

      entries.set(id, { controller, resolve: resolveDone })

      const handle: TaskHandle = {
        id,
        get cancelled() {
          return canceled
        },
        cancel(reason?: string) {
          if (canceled) return
          canceled = true
          controller.abort(new TaskCanceledError(reason))
          resolveDone({ ok: false, error: new TaskCanceledError(reason) })
          entries.delete(id)
          handles.delete(id)
          recordSettled(id, 'killed')
        },
        done,
      }

      handles.set(id, handle)
      queue.push({ id, spec: spec as TaskSpec<unknown> })
      drain()
      return handle
    },

    get(id: string) {
      return handles.get(id)
    },

    status(id: string): TaskState {
      const live = handles.get(id)
      if (live) return live.cancelled ? 'stopping' : 'running'
      return settled.get(id) ?? 'unknown'
    },
  }
}
