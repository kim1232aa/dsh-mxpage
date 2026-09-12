/**
 * Task service — task state transitions, cooperative cancellation, stale recovery.
 *
 * Ported from upstream `lib/services/task-service.ts` (ziguishian/MxPage, MIT).
 *
 * Changes made during the DSH port:
 *  - `prisma` → injected Repository.
 *  - The abort-controller registry was a module-level Map shared through
 *    `globalThis`, guarded by `if (process.env.NODE_ENV !== "production")`.
 *    That guard meant production builds could NOT cancel across module
 *    instances. The registry is now per-service-instance and unguarded.
 *  - `runTaskInBackground` (`void handler().catch(console.error)`) is gone;
 *    execution belongs to the host's TaskRunner port.
 *  - `Prisma.JsonNull` / `InputJsonValue` coercion removed — JSON columns are
 *    plain values now.
 */

import type { CoreHost } from '../ports/index.ts'
import { TaskCanceledError } from '../ports/tasks.ts'
import type { GenerationTask, TaskStatus, TaskType } from '../types/domain.ts'

export type MxTaskType = TaskType

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['SUCCESS', 'FAILED', 'CANCELED']

export function isTerminal(status: TaskStatus | undefined | null): boolean {
  return !!status && TERMINAL_STATUSES.includes(status)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export interface TaskService {
  createTask(input: {
    projectId: string
    sectionId?: string | null
    taskType: MxTaskType
    inputPayload?: unknown
    outputPayload?: unknown
    status?: TaskStatus
  }): Promise<GenerationTask>
  findRecentRunningTask(input: {
    projectId: string
    taskType: MxTaskType | MxTaskType[]
    sectionId?: string | null
    maxAgeMinutes?: number
  }): Promise<GenerationTask | null>
  getTask(taskId: string): Promise<GenerationTask | null>
  startTask(taskId: string, patch?: unknown): Promise<GenerationTask>
  updateTaskProgress(taskId: string, patch: Record<string, unknown>): Promise<GenerationTask | null>
  completeTask(taskId: string, outputPayload?: unknown): Promise<GenerationTask | null>
  failTask(taskId: string, errorMessage: string, outputPayload?: unknown): Promise<GenerationTask | null>
  cancelTask(taskId: string): Promise<GenerationTask>
  getTaskWithStaleRecovery(taskId: string): Promise<GenerationTask | null>
  recoverStaleBulkGenerationTask(task: GenerationTask | null): Promise<GenerationTask | null>
  assertTaskNotCanceled(taskId: string): Promise<GenerationTask | null>
  registerTaskAbortController(taskId: string): AbortSignal
  releaseTaskAbortController(taskId: string): void
  abortTask(taskId: string, reason?: string): void
}

export function createTaskService(host: CoreHost): TaskService {
  const { repository } = host

  // Per-instance, deliberately NOT globalThis-shared and NOT NODE_ENV-guarded.
  const abortControllers = new Map<string, AbortController>()

  async function getTask(taskId: string) {
    return repository.task.get(taskId)
  }

  async function setSectionStatusFromImage(sectionId: string | null | undefined) {
    if (typeof sectionId !== 'string') return
    const section = await repository.section.get(sectionId)
    if (!section) return
    await repository.section.update(sectionId, {
      status: section.currentImageAssetId ? 'SUCCESS' : 'IDLE',
    })
  }

  async function copyTerminalStateTo(taskId: string, status: 'FAILED' | 'CANCELED', message: string) {
    const child = await getTask(taskId)
    if (!child || isTerminal(child.status)) return null
    return repository.task.update(taskId, {
      status,
      completedAt: new Date(),
      errorMessage: message,
    })
  }

  const service: TaskService = {
    async createTask(input) {
      const status = input.status ?? 'RUNNING'
      return repository.task.create({
        projectId: input.projectId,
        sectionId: input.sectionId ?? null,
        taskType: input.taskType,
        status,
        inputPayload: input.inputPayload,
        outputPayload: asRecord(input.outputPayload),
      })
    },

    findRecentRunningTask(input) {
      return repository.task.findRecentRunning({
        projectId: input.projectId,
        sectionId: input.sectionId ?? null,
        taskType: input.taskType,
        maxAgeMinutes: input.maxAgeMinutes ?? 10,
      })
    },

    getTask,
    assertTaskNotCanceled: async (taskId) => {
      const task = await getTask(taskId)
      if (task?.status === 'CANCELED') throw new TaskCanceledError()
      if (task?.status === 'FAILED') throw new Error(task.errorMessage || 'Task stopped.')
      return task
    },

    async startTask(taskId, patch) {
      const current = await getTask(taskId)
      return repository.task.update(taskId, {
        status: 'RUNNING',
        startedAt: current?.startedAt ?? new Date(),
        outputPayload: { ...asRecord(current?.outputPayload), ...asRecord(patch) },
      })
    },

    /** Terminal-state sticky: silently no-ops once a task has settled. */
    async updateTaskProgress(taskId, patch) {
      const current = await getTask(taskId)
      if (!current || isTerminal(current.status)) return current
      return repository.task.mergeProgress(taskId, {
        ...patch,
        updatedAt: new Date().toISOString(),
      })
    },

    async completeTask(taskId, outputPayload) {
      const current = await getTask(taskId)
      if (isTerminal(current?.status)) return current
      return repository.task.update(taskId, {
        status: 'SUCCESS',
        completedAt: new Date(),
        outputPayload: {
          ...asRecord(current?.outputPayload),
          ...asRecord(outputPayload),
          completedAt: new Date().toISOString(),
        },
      })
    },

    async failTask(taskId, errorMessage, outputPayload) {
      const current = await getTask(taskId)
      if (isTerminal(current?.status)) return current
      return repository.task.update(taskId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage,
        outputPayload: {
          ...asRecord(current?.outputPayload),
          ...asRecord(outputPayload),
          failedAt: new Date().toISOString(),
        },
      })
    },

    async cancelTask(taskId) {
      const task = await getTask(taskId)
      if (!task) throw new Error('Task not found.')
      if (isTerminal(task.status)) return task

      const output = asRecord(task.outputPayload)
      const currentTaskId =
        typeof output.currentTaskId === 'string' ? output.currentTaskId : null
      const currentTask = currentTaskId ? await getTask(currentTaskId) : null

      const canceled = await repository.task.update(taskId, {
        status: 'CANCELED',
        completedAt: new Date(),
        errorMessage: 'Canceled by user.',
      })

      if (currentTaskId) {
        await copyTerminalStateTo(currentTaskId, 'CANCELED', 'Canceled by user.')
        abortControllers.get(currentTaskId)?.abort(new TaskCanceledError())
      }
      abortControllers.get(taskId)?.abort(new TaskCanceledError())

      const sectionIds = new Set(
        [task.sectionId, currentTask?.sectionId].filter(
          (id): id is string => typeof id === 'string',
        ),
      )
      for (const sectionId of sectionIds) {
        await setSectionStatusFromImage(sectionId)
      }

      return canceled
    },

    getTaskWithStaleRecovery: async (taskId) =>
      service.recoverStaleBulkGenerationTask(await getTask(taskId)),

    /**
     * Upstream only ever *failed* orphaned bulk tasks after a restart — it never
     * re-dispatched them. Preserved as-is.
     */
    async recoverStaleBulkGenerationTask(task) {
      if (
        !task ||
        task.taskType !== 'GENERATE' ||
        task.sectionId !== null ||
        (task.status !== 'PENDING' && task.status !== 'RUNNING')
      ) {
        return task
      }

      const output = asRecord(task.outputPayload)
      const heartbeatAt =
        typeof output.heartbeatAt === 'string' ? Date.parse(output.heartbeatAt) : Number.NaN
      const lastActivityAt = Number.isFinite(heartbeatAt)
        ? heartbeatAt
        : task.updatedAt.getTime()
      const staleAfterMs = Number.isFinite(heartbeatAt) ? 90_000 : 5 * 60_000
      if (Date.now() - lastActivityAt <= staleAfterMs) return task

      const message =
        '批量生成后台执行已中断，系统已结束遗留任务，请重新生成未完成模块。'
      const currentTaskId =
        typeof output.currentTaskId === 'string' ? output.currentTaskId : null
      const currentTask = currentTaskId ? await getTask(currentTaskId) : null

      await repository.task.update(task.id, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: message,
        outputPayload: {
          ...output,
          currentStep: 'stale_task_recovered',
          staleRecoveredAt: new Date().toISOString(),
        },
      })

      if (currentTaskId) {
        await copyTerminalStateTo(currentTaskId, 'FAILED', message)
        abortControllers.get(currentTaskId)?.abort(new TaskCanceledError())
      }

      if (currentTask?.sectionId) {
        await setSectionStatusFromImage(currentTask.sectionId)
      }

      abortControllers.get(task.id)?.abort(new TaskCanceledError())
      return getTask(task.id)
    },

    registerTaskAbortController(taskId) {
      const controller = new AbortController()
      abortControllers.set(taskId, controller)
      return controller.signal
    },

    releaseTaskAbortController(taskId) {
      abortControllers.delete(taskId)
    },

    abortTask(taskId, reason) {
      abortControllers.get(taskId)?.abort(new TaskCanceledError(reason))
    },
  }

  return service
}
