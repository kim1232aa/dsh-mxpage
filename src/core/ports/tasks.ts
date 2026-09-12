/**
 * Port: TaskRunner.
 *
 * Replaces upstream's `runTaskInBackground`:
 *   `void handler().catch(console.error)`
 * — a fire-and-forget promise with no queue, no scheduler, no re-dispatch
 * after restart, and a cancellation registry that is deliberately disabled in
 * production (`if (process.env.NODE_ENV !== "production")` guards the
 * `globalThis` sharing, so production builds cannot cancel across module
 * instances).
 *
 * Task *state* lives in the Repository (`GenerationTask` rows plus progress
 * merged into `outputPayload`). This port owns only *execution*: running the
 * handler, exposing a cancellation signal, and reporting progress.
 */

export interface TaskProgressReporter {
  /** Merges a patch into the task's persisted `outputPayload`. */
  patch(patch: Record<string, unknown>): Promise<void>
}

export interface TaskRunContext {
  signal: AbortSignal
  progress: TaskProgressReporter
}

export interface TaskSpec<T> {
  kind: string
  label: string
  /** Owner surface, e.g. the tool or session that started the task. */
  owner?: string
  run: (ctx: TaskRunContext) => Promise<T>
}

export interface TaskHandle {
  id: string
  /** Requests cooperative cancellation. Idempotent. */
  cancel(reason?: string): void
  /** Resolves when the handler settles. Never rejects. */
  done: Promise<{ ok: true; value: unknown } | { ok: false; error: Error }>
  /** True once cancellation has been requested. */
  readonly cancelled: boolean
}

export interface TaskRunner {
  /**
   * Starts a task. Implementations must not throw synchronously for ordinary
   * handler failures — those surface through `handle.done`.
   */
  start<T>(spec: TaskSpec<T>): TaskHandle
  /** Looks up a live handle by id, when the runner retains them. */
  get?(id: string): TaskHandle | undefined
  /**
   * The job's lifecycle as the HOST sees it.
   *
   * Deliberately separate from `get()`: a returned handle does NOT imply the job
   * is still running. A live end-to-end run caught exactly that mistake —
   * `mxpage_job_status` treated "handle exists" as "running" and reported
   * `running` forever, including after cancellation and after completion.
   */
  status?(id: string): TaskState
}

/**
 * Host-visible lifecycle of a job, mirroring `@deepseek-ai/dsh-jobs`'s
 * `JobStatus`. `unknown` means the host has no record of that id.
 */
export type TaskState = 'running' | 'stopping' | 'completed' | 'failed' | 'killed' | 'unknown'

/** Cooperative-cancellation gate used between pipeline steps. */
export class TaskCanceledError extends Error {
  readonly code = 'MXPAGE_CANCELLED'
  constructor(message = 'Task canceled.') {
    super(message)
    this.name = 'TaskCanceledError'
  }
}

export function isTaskCanceledError(error: unknown): boolean {
  if (error instanceof TaskCanceledError) return true
  return error instanceof Error && /task canceled/i.test(error.message)
}

/** Throws when the signal is already aborted. */
export function assertNotCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TaskCanceledError()
}

/**
 * In-process TaskRunner. Suitable for tests and for hosts that already own
 * their own job system but still want a default.
 */
export function createInProcessTaskRunner(): TaskRunner {
  const handles = new Map<string, TaskHandle>()
  let counter = 0

  return {
    start<T>(spec: TaskSpec<T>): TaskHandle {
      const id = `${spec.kind}_${++counter}_${Date.now().toString(36)}`
      const controller = new AbortController()
      let canceled = false

      const handle: TaskHandle = {
        id,
        get cancelled() {
          return canceled
        },
        cancel(reason?: string) {
          if (canceled) return
          canceled = true
          controller.abort(new TaskCanceledError(reason))
        },
        done: Promise.resolve({ ok: true as const, value: undefined }),
      }

      const done = (async () => {
        try {
          const value = await spec.run({
            signal: controller.signal,
            progress: { async patch() {} },
          })
          return { ok: true as const, value }
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }
        } finally {
          handles.delete(id)
        }
      })()

      handles.set(id, { ...handle, done })
      return handles.get(id)!
    },
    get(id: string) {
      return handles.get(id)
    },
  }
}
