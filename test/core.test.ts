import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inferCategory } from '../src/core/ports/logger.ts'
import { normalizeRelPath } from '../src/core/ports/storage.ts'
import { createInProcessTaskRunner } from '../src/core/ports/tasks.ts'
import { toDbSectionType, toSectionTypeKey, SYSTEM_TASK_PLATFORM } from '../src/core/types/domain.ts'
import { detectModelCapabilities, detectModelRoles } from '../src/core/ai/capability-detector.ts'
import { createZip, crc32 } from '../src/core/utils/zip.ts'
import { createJsonRepository } from '../src/host/repository.ts'
import { createFileStorageDriver } from '../src/host/storage-driver.ts'
import { createQueuedTaskRunner } from '../src/host/task-runner.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mxpage-test-'))
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

test('crc32 matches the canonical check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('createZip emits local headers, a central directory and an EOCD', () => {
  const zip = createZip([
    { name: '00-头图/mx_1_01.png', data: Buffer.from('hero-bytes') },
    { name: '01-详情页/mx_1_01.png', data: Buffer.from('detail-bytes') },
  ])
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature')
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])), 'central directory')
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'end of central directory')
  // General-purpose bit 11 (UTF-8 filename) must be set.
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800)
})

// ---------------------------------------------------------------------------
// ports: pure helpers
// ---------------------------------------------------------------------------

test('normalizeRelPath collapses dot segments and rejects escapes', () => {
  assert.equal(normalizeRelPath('a\\b/./c.png'), 'a/b/c.png')
  assert.equal(normalizeRelPath('a/b/../c.png'), 'a/c.png')
  assert.throws(() => normalizeRelPath('../../etc/passwd'))
  assert.throws(() => normalizeRelPath('/../x'))
})

test('inferCategory classifies endpoints the way upstream did', () => {
  assert.equal(inferCategory('https://x/v1/images/generations'), 'image_generation')
  assert.equal(inferCategory('https://x/v1/images/edits'), 'image_edit')
  assert.equal(inferCategory('https://x/v1/chat/completions'), 'text')
  assert.equal(
    inferCategory('https://x/v1/chat/completions', { response_format: { type: 'json_object' } }),
    'structured',
  )
  assert.equal(inferCategory('https://x/v1/models'), 'models')
  assert.equal(inferCategory('https://x/v1/unknown'), 'unknown')
})

test('section type keys round-trip across the TS/DB case asymmetry', () => {
  assert.equal(toDbSectionType('hero'), 'HERO')
  assert.equal(toDbSectionType('detail_closeup'), 'DETAIL_CLOSEUP')
  assert.equal(toDbSectionType('nonsense'), 'CUSTOM')
  assert.equal(toSectionTypeKey('HERO'), 'hero')
  assert.equal(toSectionTypeKey('NOT_A_TYPE'), 'custom')
})

test('capability detection is name-based and never sets real_* flags', () => {
  const image = detectModelCapabilities('grok-imagine-image-2.0')
  assert.equal(image.image_gen, true)
  assert.equal(image.real_image_gen, undefined, 'upstream never populates this')
  const vision = detectModelCapabilities('gpt-4o-mini')
  assert.equal(vision.vision, true)
  assert.deepEqual(detectModelRoles(vision).planning, true)
})

// ---------------------------------------------------------------------------
// storage driver
// ---------------------------------------------------------------------------

test('file storage driver round-trips and contains traversal', async () => {
  const root = tempRoot()
  try {
    const storage = createFileStorageDriver(root)
    await storage.write('uploads/p1/a.png', Buffer.from('hello'))
    assert.equal((await storage.read('uploads/p1/a.png')).toString(), 'hello')
    assert.equal((await storage.exists('uploads/p1/a.png')), true)
    assert.equal((await storage.stat('uploads/p1/a.png'))?.size, 5)
    assert.deepEqual(await storage.list('uploads'), ['uploads/p1/a.png'])
    assert.equal(storage.publicUrl('uploads/p1/a.png'), null, 'headless host has no file route')
    await assert.rejects(() => storage.read('../../etc/passwd'))
    await storage.remove('uploads/p1/a.png')
    assert.equal(await storage.exists('uploads/p1/a.png'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------

test('repository: project lifecycle, sections, versions and snapshot merge', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })

    const project = await repo.project.create({
      name: 'demo',
      platform: 'taobao_tmall',
      style: 'premium',
    })
    assert.equal(project.status, 'DRAFT')
    assert.equal(project.modelSnapshot, null)

    await repo.project.update(project.id, { status: 'ANALYZED' })
    const merged = await repo.project.mergeModelSnapshot(project.id, {
      previewConfig: { heroImageCount: 4, detailSectionCount: 7 },
    })
    assert.equal(
      (merged.modelSnapshot?.previewConfig as { heroImageCount: number }).heroImageCount,
      4,
    )

    const section = await repo.section.create({
      projectId: project.id,
      sectionKey: 'hero-1',
      type: 'HERO',
      title: 't',
      goal: 'g',
      copy: 'c',
      visualPrompt: 'p',
      order: 0,
    })

    assert.equal(await repo.version.nextVersionNumber(section.id), 1)
    const v1 = await repo.version.create({ sectionId: section.id })
    const v2 = await repo.version.create({ sectionId: section.id })
    assert.equal(v1.versionNumber, 1)
    assert.equal(v2.versionNumber, 2)

    await repo.version.setActive(section.id, v2.id)
    const versions = await repo.version.list(section.id)
    assert.deepEqual(
      versions.map((item) => item.isActive),
      [false, true],
    )

    const detail = await repo.project.getDetail(project.id)
    assert.equal(detail?.sections.length, 1)
    assert.equal(detail?.sections[0]?.versions.length, 2)

    // A referenced asset must not be reported as collectable.
    const asset = await repo.asset.create({
      projectId: project.id,
      type: 'GENERATED',
      filePath: 'generated/p/s/a.png',
      fileName: 'a.png',
      sortOrder: 0,
      isMain: false,
    })
    assert.equal(await repo.asset.isReferenced(asset.id), false)
    await repo.section.update(section.id, { currentImageAssetId: asset.id })
    assert.equal(await repo.asset.isReferenced(asset.id), true)

    // Thread-safe close should flush the pending write.
    await repo.close?.()
    const reopened = createJsonRepository({ file: join(root, 'db.json') })
    assert.equal((await reopened.project.get(project.id))?.name, 'demo')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository: task progress is terminal-state sticky', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })
    const project = await repo.project.create({ name: 'p', platform: 'x', style: 'y' })
    const task = await repo.task.create({ projectId: project.id, taskType: 'GENERATE' })
    assert.equal(task.status, 'RUNNING', 'upstream createTask defaults to RUNNING')

    await repo.task.mergeProgress(task.id, { completedItems: 1 })
    await repo.task.update(task.id, { status: 'SUCCESS', completedAt: new Date() })
    const afterTerminal = await repo.task.mergeProgress(task.id, { completedItems: 99 })
    assert.equal(
      (afterTerminal?.outputPayload as { completedItems: number }).completedItems,
      1,
      'progress after a terminal state must be dropped',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository: system project is hidden from list() and reused', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })
    await repo.project.create({ name: 'real', platform: 'taobao_tmall', style: 'premium' })
    const system = await repo.project.findOrCreateSystemProject()
    assert.equal(system.platform, SYSTEM_TASK_PLATFORM)
    assert.equal((await repo.project.list()).length, 1, 'system project hidden by default')
    assert.equal((await repo.project.list({ includeSystem: true })).length, 2)
    const again = await repo.project.findOrCreateSystemProject()
    assert.equal(again.id, system.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository: recoverStale only fails orphaned bulk GENERATE tasks', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })
    const project = await repo.project.create({ name: 'p', platform: 'x', style: 'y' })
    const bulk = await repo.task.create({
      projectId: project.id,
      taskType: 'GENERATE',
      status: 'PENDING',
    })
    // Section-scoped tasks are never recovered.
    const scoped = await repo.task.create({
      projectId: project.id,
      sectionId: 'sec_1',
      taskType: 'GENERATE',
      status: 'PENDING',
    })
    const recovered = await repo.task.recoverStale(project.id, 0)
    assert.deepEqual(
      recovered.map((item) => item.id),
      [bulk.id],
    )
    assert.equal((await repo.task.get(bulk.id))?.status, 'FAILED')
    assert.equal((await repo.task.get(scoped.id))?.status, 'PENDING')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository: findRecentRunning honours section scope and age', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })
    const project = await repo.project.create({ name: 'p', platform: 'x', style: 'y' })
    await repo.task.create({
      projectId: project.id,
      sectionId: 'sec_1',
      taskType: 'GENERATE',
      status: 'RUNNING',
    })
    assert.ok(
      await repo.task.findRecentRunning({
        projectId: project.id,
        sectionId: 'sec_1',
        taskType: 'GENERATE',
      }),
    )
    assert.equal(
      await repo.task.findRecentRunning({
        projectId: project.id,
        sectionId: 'sec_2',
        taskType: 'GENERATE',
      }),
      null,
      'a different section must not be blocked',
    )
    assert.equal(
      await repo.task.findRecentRunning({
        projectId: project.id,
        sectionId: 'sec_1',
        taskType: 'GENERATE',
        maxAgeMinutes: -1,
      }),
      null,
      'stale tasks fall outside the window',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// task runners
// ---------------------------------------------------------------------------

test('task runner resolves done and aborts on cancel', async () => {
  const root = tempRoot()
  try {
    const repo = createJsonRepository({ file: join(root, 'db.json') })
    const runner = createQueuedTaskRunner({ repository: repo, concurrency: 2 })

    const handle = runner.start({
      kind: 'mxpage_page',
      label: 'test',
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return ctx.signal.aborted ? 'aborted' : 'finished'
      },
    })
    const outcome = await handle.done
    assert.equal(outcome.ok, true)

    const cancelling = runner.start({
      kind: 'mxpage_page',
      label: 'cancel me',
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return ctx.signal.aborted
      },
    })
    cancelling.cancel('test')
    const canceled = await cancelling.done
    assert.equal(canceled.ok, false)
    assert.equal(cancelling.cancelled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in-process task runner from the port handles a throwing handler', async () => {
  const runner = createInProcessTaskRunner()
  const handle = runner.start({
    kind: 'x',
    label: 'boom',
    run: async () => {
      throw new Error('kaboom')
    },
  })
  const outcome = await handle.done
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.error.message, 'kaboom')
})
