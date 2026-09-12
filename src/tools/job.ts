import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProjectStore } from '../service/project-store.ts'
import { assertInside } from '../util/paths.ts'
import { redactSecrets } from '../util/redact.ts'

export interface MxpageJobsApi {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run: () => {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
    }
  }): string
  kill?(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
  get?(id: string, caller?: unknown): { id: string; status: string; detail?: string }
}

export type JobProgressState = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

export interface JobProgress {
  state: JobProgressState
  progress: number
  currentSection: string
  error?: string
}

export interface LiveJob {
  projectId: string
  projectDir: string
  abort: AbortController
}

const liveJobs = new Map<string, LiveJob>()

function progressPath(projectDir: string, jobId: string): string {
  const safeId = basename(jobId)
  if (safeId !== jobId || jobId.includes('..')) {
    throw new Error(`path escapes project root: ${jobId}`)
  }
  const dir = assertInside(projectDir, join(projectDir, 'tasks'))
  return assertInside(projectDir, join(dir, `${safeId}.json`))
}

export function registerLiveJob(jobId: string, rec: LiveJob): void {
  liveJobs.set(jobId, rec)
}

export function getLiveJob(jobId: string): LiveJob | undefined {
  return liveJobs.get(jobId)
}

export function writeJobProgress(projectDir: string, jobId: string, data: JobProgress): void {
  const dir = assertInside(projectDir, join(projectDir, 'tasks'))
  mkdirSync(dir, { recursive: true })
  const file = progressPath(projectDir, jobId)
  const progress = Math.min(1, Math.max(0, data.progress))
  const payload: JobProgress = {
    state: data.state,
    progress,
    currentSection: data.currentSection,
  }
  if (data.error) payload.error = redactSecrets(data.error)
  writeFileSync(file, JSON.stringify(payload))
}

export function readJobProgress(projectDir: string, jobId: string): JobProgress | undefined {
  const file = progressPath(projectDir, jobId)
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<JobProgress>
    if (!raw || typeof raw !== 'object') return undefined
    const state = raw.state
    if (
      state !== 'running'
      && state !== 'stopping'
      && state !== 'completed'
      && state !== 'killed'
      && state !== 'failed'
    ) return undefined
    return {
      state,
      progress: typeof raw.progress === 'number' ? raw.progress : 0,
      currentSection: typeof raw.currentSection === 'string' ? raw.currentSection : '',
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    }
  } catch {
    return undefined
  }
}

import { renderJsonAndImages, textRender } from './render.ts'

export function jobStatusTool(opts: {
  store: ProjectStore
  jobs?: MxpageJobsApi
}) {
  return defineTool({
    name: 'mxpage_job_status',
    description: 'Read mxpage background job progress (state, progress 0–1, currentSection). Pass job_id from mxpage_generate_page.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by mxpage_generate_page' },
      project_id: { type: 'string', description: 'Optional project id to locate tasks/<jobId>.json' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJsonAndImages,
    },
    execute: async (args, exec) => {
      const jobId = args.job_id
      const live = getLiveJob(jobId)
      let file: JobProgress | undefined
      let projectId = args.project_id
      if (live) {
        file = readJobProgress(live.projectDir, jobId)
        projectId = projectId || live.projectId
      } else if (args.project_id) {
        try {
          const record = opts.store.read(args.project_id)
          file = readJobProgress(record.workspaceDir, jobId)
        } catch {
          file = undefined
        }
      }
      let snapshot: { id: string; status: string; detail?: string } | undefined
      try {
        snapshot = opts.jobs?.get?.(jobId, exec.agent)
      } catch {
        snapshot = undefined
      }
      if (!file && !snapshot) return { ok: false, error: 'MXPAGE_NOT_FOUND' }
      const error = file?.error ?? snapshot?.detail
      let outputs: unknown[] = []
      if (projectId) {
        try {
          outputs = opts.store.read(projectId).outputs ?? []
        } catch {
          outputs = []
        }
      }
      return {
        ok: true,
        state: snapshot?.status ?? file?.state ?? 'running',
        progress: file?.progress ?? 0,
        currentSection: file?.currentSection ?? '',
        ...(error ? { error } : {}),
        ...(outputs.length > 0 ? { outputs } : {}),
      }
    },
  })
}

export function jobCancelTool(opts: {
  jobs?: MxpageJobsApi
}) {
  return defineTool({
    name: 'mxpage_job_cancel',
    description: 'Cancel an mxpage page job. Completed section files are kept. Pass job_id from mxpage_generate_page.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by mxpage_generate_page' },
      reason: { type: 'string', description: 'Optional cancel reason' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: textRender,
    },
    execute: async (args, exec) => {
      const jobId = args.job_id
      const live = getLiveJob(jobId)
      live?.abort.abort(args.reason)
      if (live) {
        const prev = readJobProgress(live.projectDir, jobId)
        writeJobProgress(live.projectDir, jobId, {
          state: 'stopping',
          progress: prev?.progress ?? 0,
          currentSection: prev?.currentSection ?? '',
          ...(prev?.error ? { error: prev.error } : {}),
        })
      }
      let result: 'requested' | 'already-finished' = live ? 'requested' : 'already-finished'
      if (opts.jobs?.kill) {
        try {
          result = opts.jobs.kill(jobId, exec.agent, args.reason)
        } catch {
          // keep local abort result
        }
      }
      return { ok: true, jobId, result }
    },
  })
}
