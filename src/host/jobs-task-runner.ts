/**
 * TaskRunner backed by the DSH host job registry (`ctx.jobs`).
 *
 * This is the objective's "接 host job 体系": page generation becomes a real
 * host job, so the shell owns job identity, session-scoped access, lifecycle
 * state, completion notices, and owner-disposal cancellation. The plugin keeps
 * only the execution resources.
 *
 * Contract notes that shaped this implementation (from
 * `@deepseek-ai/dsh-jobs`'s own types):
 *  - `run()` must return hooks **synchronously** — it is not an async work
 *    function. The async work lives inside `done`.
 *  - `hooks.done` must never reject; a rejection is converted to `failed` by the
 *    registry, which loses the real error.
 *  - `hooks.cancel` must be synchronous and idempotent.
 *  - `start` refuses work while no attached controller serves the owner, so an
 *    owner is passed through when the caller has one.
 */

import type { JobKindMap, JobOutcome } from '@deepseek-ai/dsh-jobs'

import type { Repository } from '../core/ports/repository.ts'
import type { TaskHandle, TaskRunner, TaskSpec, TaskState } from '../core/ports/tasks.ts'
import { TaskCanceledError, isTaskCanceledError } from '../core/ports/tasks.ts'

// Custom kinds must be declaration-merged; the registry treats each value as an
// opaque id namespace and generates `<kind>-N` ids.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    mxpage_page: 'mxpage_page'
  }
}

export const MXPAGE_JOB_KIND: JobKindMap[keyof JobKindMap] = 'mxpage_page'

/**
 * Structural view of the registry. The service is host-provided, so only the
 * members this plugin uses are named; nothing here imports the implementation.
 */
export interface JobsRegistryLike {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run(): {
      cancel(reason?: string): void
      done: Promise<JobOutcome>
      readOutput?(): string
    }
  }): string
  get(id: string, caller?: unknown): { status: string; detail?: string; label: string }
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

export type TaskOutcome = { ok: true; value: unknown } | { ok: false; error: Error }

export interface JobsTaskRunnerOptions {
  jobs: JobsRegistryLike
  repository: Repository
  /** Live agent that owns the job, when the caller has one. */
  owner?: unknown
  /** Resolves the owner at call time (the agent may change between jobs). */
  resolveOwner?: () => unknown
}

export function createJobsTaskRunner(options: JobsTaskRunnerOptions): TaskRunner {
  const { jobs, repository } = options
  const handles = new Map<string, TaskHandle>()

  return {
    start<T>(spec: TaskSpec<T>): TaskHandle {
      const controller = new AbortController()
      let canceled = false
      let settled = false
      let resolveDone!: (outcome: TaskOutcome) => void
      const done = new Promise<TaskOutcome>((resolve) => {
        resolveDone = resolve
      })

      let jobId = ''
      const settle = (outcome: TaskOutcome): void => {
        if (settled) return
        settled = true
        resolveDone(outcome)
        handles.delete(jobId)
      }

      const owner = options.resolveOwner?.() ?? options.owner

      jobId = jobs.start({
        kind: MXPAGE_JOB_KIND,
        label: spec.label,
        ...(owner === undefined ? {} : { owner }),
        run: () => ({
          cancel(reason?: string) {
            if (canceled) return
            canceled = true
            controller.abort(new TaskCanceledError(reason))
          },
          done: (async (): Promise<JobOutcome> => {
            try {
              const value = await spec.run({
                signal: controller.signal,
                progress: {
                  async patch(patch) {
                    await repository.task.mergeProgress(jobId, patch).catch(() => null)
                  },
                },
              })
              settle({ ok: true, value })
              return {
                status: 'completed',
                output: typeof value === 'string' ? value : JSON.stringify(value ?? {}),
              }
            } catch (error) {
              const normalized = error instanceof Error ? error : new Error(String(error))
              settle({ ok: false, error: normalized })
              return isTaskCanceledError(normalized)
                ? { status: 'killed', detail: 'canceled' }
                : { status: 'failed', detail: normalized.message }
            }
          })(),
        }),
      })

      const handle: TaskHandle = {
        id: jobId,
        get cancelled() {
          return canceled
        },
        cancel(reason?: string) {
          if (canceled) return
          canceled = true
          controller.abort(new TaskCanceledError(reason))
          // Let the registry flip the record to `stopping` and fire its own
          // cancellation path; the hooks above are idempotent.
          try {
            jobs.kill(jobId, owner, reason)
          } catch {
            // an already-finished job is not an error
          }
        },
        done,
      }

      handles.set(jobId, handle)
      return handle
    },

    get(id: string) {
      const live = handles.get(id)
      if (live) return live
      // Not started by this instance: report the registry's view instead, so the
      // panel can still show a job that survived a plugin reload.
      try {
        const snapshot = jobs.get(id, options.resolveOwner?.() ?? options.owner)
        return {
          id,
          cancelled: snapshot.status === 'stopping' || snapshot.status === 'killed',
          cancel: () => {
            try {
              jobs.kill(id, options.resolveOwner?.() ?? options.owner, 'canceled from panel')
            } catch {
              // ignore
            }
          },
          done: Promise.resolve({ ok: true as const, value: snapshot.status }),
        }
      } catch {
        return undefined
      }
    },

    /**
     * Lifecycle as the registry sees it. Unlike `get()`, a settled job still
     * answers: the registry retains the record after the live handle is
     * released, which is what the `/job` route polls after completion.
     */
    status(id: string): TaskState {
      const live = handles.get(id)
      if (live) return live.cancelled ? 'stopping' : 'running'
      try {
        const snapshot = jobs.get(id, options.resolveOwner?.() ?? options.owner)
        switch (snapshot.status) {
          case 'running':
          case 'stopping':
          case 'completed':
          case 'failed':
          case 'killed':
            return snapshot.status
          default:
            return 'unknown'
        }
      } catch {
        return 'unknown'
      }
    },
  }
}
