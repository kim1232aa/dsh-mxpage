/**
 * Batch create screen — one project per SKU image.
 *
 * Port of upstream `components/projects/batch-create-workspace.tsx`: stage up
 * to 20 SKU photos, give each a name, and create one independent project per
 * image. Optionally kick off analyze→plan for the whole batch as a single
 * background job whose per-SKU failures stay isolated (验收 §8).
 */

import { useRef, useState } from 'react'

import type { MxpageApi } from '../api.ts'
import { Badge, Button, Notice, SectionHeading, styles, T } from '../ui.tsx'

interface StagedItem {
  file: File
  name: string
  previewUrl: string
}

interface CreatedItem {
  projectId: string
  name: string
}

export function BatchView(props: {
  api: MxpageApi
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  onOpenProject: (projectId: string) => void
}) {
  const { api, busy, run, onOpenProject } = props

  const [staged, setStaged] = useState<StagedItem[]>([])
  const [autoAnalyze, setAutoAnalyze] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedItem[]>([])
  const fileInput = useRef<HTMLInputElement | null>(null)

  const stageFiles = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    setStaged((current) => [
      ...current,
      ...images.slice(0, Math.max(0, 20 - current.length)).map((file) => ({
        file,
        name: file.name.replace(/\.[^.]+$/, ''),
        previewUrl: URL.createObjectURL(file),
      })),
    ])
  }

  const doCreate = () =>
    run('batch', async () => {
      if (staged.length === 0) throw new Error('请先选择 SKU 图片')
      const result = await api.batchCreate(
        staged.map((item) => ({ name: item.name, file: item.file })),
        { autoAnalyze },
      )
      setCreated(result.projects)
      setStaged([])

      if (result.jobId) {
        setNotice(`已创建 ${result.projects.length} 个项目，批量分析+规划进行中…`)
        for (let i = 0; i < 900; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const status = await api.jobStatus(result.jobId!).catch(() => null)
          if (!status || (status.state !== 'running' && status.state !== 'stopping')) {
            const progress = (status?.progress ?? {}) as Record<string, unknown>
            const results = Array.isArray(progress.results) ? progress.results : []
            const failed = results.filter((item) => (item as Record<string, unknown>).ok === false)
            setNotice(
              failed.length
                ? `批量完成：${results.length - failed.length} 成功，${failed.length} 失败（失败项目可单独重试）`
                : `批量完成：${result.projects.length} 个项目已分析并规划`,
            )
            break
          }
        }
      } else {
        setNotice(`已创建 ${result.projects.length} 个项目`)
      }
    })

  return (
    <div style={{ padding: 24, maxWidth: 920, display: 'grid', gap: 16 }}>
      <SectionHeading
        eyebrow="批量"
        title="批量 SKU 建项"
        description="一次上传多张 SKU 主图，每张图独立成一个项目；可选创建后自动完成分析与规划。单个 SKU 失败不影响其余。"
      />
      {notice ? <Notice kind="info">{notice}</Notice> : null}

      <div style={styles.card}>
        <div
          onClick={() => fileInput.current?.click()}
          style={{
            border: `1.5px dashed ${T.borderStrong}`,
            borderRadius: 14,
            padding: 26,
            textAlign: 'center',
            cursor: 'pointer',
            background: T.cardMuted,
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              stageFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <div style={{ fontWeight: 700 }}>点击选择 SKU 图片（最多 20 张）</div>
          <div style={{ color: T.muted, fontSize: 12, marginTop: 4 }}>每张图创建一个独立项目，作为该 SKU 的主图</div>
        </div>

        {staged.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginTop: 14 }}>
            {staged.map((item, index) => (
              <div key={index} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
                <img
                  src={item.previewUrl}
                  alt={item.name}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, background: T.cardMuted }}
                />
                <input
                  value={item.name}
                  onChange={(event) =>
                    setStaged((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)),
                    )
                  }
                  style={{ ...styles.input, marginTop: 6, fontSize: 12 }}
                  placeholder="SKU 名称"
                />
                <Button
                  variant="ghost"
                  onClick={() => setStaged((current) => current.filter((_, i) => i !== index))}
                  style={{ fontSize: 11, color: T.muted, padding: '2px 0', marginTop: 2 }}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ ...styles.row, marginTop: 14, justifyContent: 'space-between' }}>
          <label style={{ ...styles.row, fontSize: 12.5, color: T.mutedStrong, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoAnalyze}
              onChange={(event) => setAutoAnalyze(event.target.checked)}
            />
            创建后自动分析 + 规划（消耗文本/视觉额度）
          </label>
          <Button variant="dark" disabled={staged.length === 0 || busy !== null} onClick={doCreate}>
            {busy === 'batch' ? '批量处理中…' : `创建 ${staged.length} 个项目`}
          </Button>
        </div>
      </div>

      {created.length > 0 ? (
        <div style={styles.card}>
          <strong>本次创建（{created.length}）</strong>
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {created.map((item) => (
              <div
                key={item.projectId}
                style={{
                  ...styles.row,
                  justifyContent: 'space-between',
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: '8px 12px',
                }}
              >
                <span style={{ fontSize: 12.5 }}>{item.name}</span>
                <div style={styles.row}>
                  <Badge tone="ok">已创建</Badge>
                  <Button onClick={() => onOpenProject(item.projectId)} style={{ padding: '4px 12px', fontSize: 12 }}>
                    打开
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
