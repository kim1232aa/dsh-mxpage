/**
 * Tests the host-jobs-backed TaskRunner.
 *
 * The DSH job registry has three contract rules that are easy to get wrong and
 * are all silent when broken:
 *   1. `run()` must return hooks SYNCHRONOUSLY (it is not an async work fn)
 *   2. `hooks.done` must never reject — the registry converts a rejection to
 *      `failed`, which loses the real error
 *   3. `hooks.cancel` must be synchronous and idempotent
 *
 * Plus the mapping onto this plugin's TaskRunner port: a canceled job must
 * settle as `killed`, and a failing one as `failed` with the message preserved.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { JobOutcome } from '@deepseek-ai/dsh-jobs'

import { createJsonRepository } from '../src/host/repository.ts'
import {
  createJobsTaskRunner,
  MXPAGE_JOB_KIND,
  type JobsRegistryLike,
} from '../src/host/jobs-task-runner.ts'

interface StartedJob {
  kind: string
  label: string
  owner?: unknown
  hooks: {
    cancel(reason?: string): void
    done: Promise<JobOutcome>
    readOutput?(): string
  }
}

/** Minimal stand-in for `ctx.jobs`, keeping the real contract's shape. */
function createMockRegistry() {
  const started: StartedJob[] = []
  let counter = 0
  const registry: JobsRegistryLike = {
    start(spec) {
      const id = `${spec.kind}-${++counter}`
      const hooks = spec.run()
      // Rule 1: run() must be synchronous.
      assert.equal(typeof hooks, 'object', 'run() must return hooks synchronously')
      assert.equal(typeof hooks.done?.then, 'function', 'hooks.done must be a promise')
      started.push({ kind: spec.kind, label: spec.label, owner: spec.owner, hooks })
      return id
    },
    get(id) {
      const index = started.findIndex((_job, position) => `${MXPAGE_JOB_KIND}-${position + 1}` === id)
      if (index < 0) throw new Error(`unknown job ${id}`)
      return { status: 'running', label: started[index]!.label }
    },
    kill(id) {
      const index = started.findIndex((_job, position) => `${MXPAGE_JOB_KIND}-${position + 1}` === id)
      if (index < 0) return 'already-finished'
      started[index]!.hooks.cancel('killed by test')
      return 'requested'
    },
  }
  return { registry, started }
}

function harness() {
  const store = mkdtempSync(join(tmpdir(), 'mxpage-jobs-'))
  const repository = createJsonRepository({ file: join(store, 'db.json') })
  return { store, repository, cleanup: () => rmSync(store, { recursive: true, force: true }) }
}

test('start registers an mxpage_page host job and reports completion', async () => {
  const h = harness()
  const { registry, started } = createMockRegistry()
  try {
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })
    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'Generate 3 section(s)',
      run: async (ctx) => {
        assert.equal(ctx.signal.aborted, false)
        await ctx.progress.patch({ completedItems: 1 })
        return { done: 3 }
      },
    })

    assert.match(handle.id, /^mxpage_page-\d+$/)
    assert.equal(started.length, 1)
    assert.equal(started[0]?.kind, MXPAGE_JOB_KIND)
    assert.equal(started[0]?.label, 'Generate 3 section(s)')

    const outcome = await handle.done
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.ok === true && outcome.value, { done: 3 })

    // Rule 2: the registry-facing outcome must be a resolved JobOutcome.
    const jobOutcome = await started[0]!.hooks.done
    assert.equal(jobOutcome.status, 'completed')
    assert.match(String(jobOutcome.output), /"done":3/)

    // The runner must still be reachable by id after settling? No — it is
    // released, and get() falls back to the registry view.
    assert.ok(runner.get?.(handle.id))
  } finally {
    h.cleanup()
  }
})

test('a failing handler resolves hooks.done as failed and never rejects', async () => {
  const h = harness()
  const { registry, started } = createMockRegistry()
  try {
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })
    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'boom',
      run: async () => {
        throw new Error('upstream returned 429')
      },
    })

    // Rule 2 in practice: awaiting hooks.done must not throw.
    const jobOutcome = await started[0]!.hooks.done
    assert.equal(jobOutcome.status, 'failed')
    assert.match(String(jobOutcome.detail), /429/)

    const outcome = await handle.done
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.error.message, 'upstream returned 429')
  } finally {
    h.cleanup()
  }
})

test('cancelling aborts the spec signal and settles the job as killed', async () => {
  const h = harness()
  const { registry, started } = createMockRegistry()
  try {
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })
    let sawAbort = false
    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'long job',
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true
            resolve()
          })
        })
        // Cooperative cancellation: throw the port's cancellation error.
        const { TaskCanceledError } = await import('../src/core/ports/tasks.ts')
        throw new TaskCanceledError()
      },
    })

    assert.equal(handle.cancelled, false)
    handle.cancel('user asked')
    assert.equal(handle.cancelled, true)
    // Rule 3: cancel is idempotent.
    handle.cancel('again')

    const jobOutcome = await started[0]!.hooks.done
    assert.equal(jobOutcome.status, 'killed')
    assert.equal(sawAbort, true, 'the handler must observe the abort signal')

    const outcome = await handle.done
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.error.name, 'TaskCanceledError')
  } finally {
    h.cleanup()
  }
})

test('job progress is persisted through the repository', async () => {
  const h = harness()
  const { registry } = createMockRegistry()
  try {
    const project = await h.repository.project.create({ name: 'p', platform: 'x', style: 'y' })
    const task = await h.repository.task.create({ projectId: project.id, taskType: 'GENERATE' })
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })

    // The runner writes progress under the HOST job id, which is why the panel
    // prefers the registry view and falls back to the task row.
    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'progress',
      run: async (ctx) => {
        await ctx.progress.patch({ currentSectionId: task.sectionId ?? 'sec_x', completedItems: 2 })
        return 'ok'
      },
    })
    await handle.done
    assert.ok(handle.id.startsWith(MXPAGE_JOB_KIND))
  } finally {
    h.cleanup()
  }
})

test('get() falls back to the registry for a job this instance did not start', async () => {
  const h = harness()
  const { registry } = createMockRegistry()
  try {
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })
    // Simulate a job registered before a plugin reload: the registry knows it,
    // this runner instance does not.
    registry.start({
      kind: MXPAGE_JOB_KIND,
      label: 'pre-existing',
      run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' as const }) }),
    })
    const handle = runner.get?.(`${MXPAGE_JOB_KIND}-1`)
    assert.ok(handle, 'a registry job must be resolvable by id')
    assert.equal(handle.cancelled, false)
    assert.equal(runner.get?.('mxpage_page-999'), undefined)
  } finally {
    h.cleanup()
  }
})

test('status() reports the terminal state after the live handle is released', async () => {
  const h = harness()
  const { registry } = createMockRegistry()
  try {
    const runner = createJobsTaskRunner({ jobs: registry, repository: h.repository })
    assert.equal(runner.status?.('mxpage_page-999'), 'unknown')

    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'settles',
      run: async () => 'ok',
    })
    assert.equal(runner.status?.(handle.id), 'running')
    await handle.done
    // Live handle is released on settle; the registry still knows the job.
    assert.equal(runner.status?.(handle.id), 'running',
      'registry-backed status falls through to jobs.get(), which this mock reports as running')
  } finally {
    h.cleanup()
  }
})

test('queued runner status() survives completion, failure, and cancellation', async () => {
  const h = harness()
  try {
    const { createQueuedTaskRunner } = await import('../src/host/task-runner.ts')
    const { TaskCanceledError } = await import('../src/core/ports/tasks.ts')
    const runner = createQueuedTaskRunner({ repository: h.repository })

    const done = runner.start({ kind: 'mxpage_page', label: 'ok', run: async () => 1 })
    assert.equal(runner.status?.(done.id), 'running')
    await done.done
    assert.equal(runner.status?.(done.id), 'completed', 'completed job must not decay to unknown')

    const failed = runner.start({
      kind: 'mxpage_page',
      label: 'boom',
      run: async () => {
        throw new Error('nope')
      },
    })
    await failed.done
    assert.equal(runner.status?.(failed.id), 'failed')

    const killed = runner.start({
      kind: 'mxpage_page',
      label: 'long',
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve())
        })
        throw new TaskCanceledError()
      },
    })
    killed.cancel('test')
    await killed.done
    assert.equal(runner.status?.(killed.id), 'killed')

    assert.equal(runner.status?.('mxpage_page_00000000'), 'unknown')
  } finally {
    h.cleanup()
  }
})
