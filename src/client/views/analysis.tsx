/**
 * Analysis screen — the structured analysis workbench.
 *
 * Port of upstream `components/analysis/analysis-workspace.tsx` (477 lines):
 * project meta editing, product-photo asset management (reorder / set-main /
 * delete / upload), and the editable structured analysis with array fields
 * edited one-per-line. Saving writes the normalized analysis back through
 * `POST /analysis/save`, mirroring the upstream analysis page save.
 */

import { useMemo, useRef, useState } from 'react'

import type { AssetView, MxpageApi, ProjectDetailResponse } from '../api.ts'
import { Badge, Button, Field, Notice, SectionHeading, styles, T } from '../ui.tsx'

/** Single-line string fields of the upstream ProductAnalysisOutput. */
const TEXT_FIELDS: Array<[string, string]> = [
  ['productName', '商品名称'],
  ['category', '品类'],
  ['subcategory', '子品类'],
  ['material', '材质'],
  ['color', '颜色'],
]

/** Array fields, edited one item per line. */
const ARRAY_FIELDS: Array<[string, string]> = [
  ['styleTags', '风格标签'],
  ['targetAudience', '目标受众'],
  ['usageScenarios', '使用场景'],
  ['coreSellingPoints', '核心卖点'],
  ['differentiationPoints', '差异化卖点'],
  ['userConcerns', '用户顾虑'],
  ['recommendedFocusPoints', '建议重点'],
]

function arrayToText(value: unknown): string {
  return Array.isArray(value) ? (value as string[]).join('\n') : ''
}

function textToArray(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function AnalysisView(props: {
  api: MxpageApi
  detail: ProjectDetailResponse
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  reload: () => Promise<void>
  onDeleted: () => void
}) {
  const { api, detail, busy, run, reload, onDeleted } = props

  const [name, setName] = useState(detail.project.name)
  const [platform, setPlatform] = useState(detail.project.platform)
  const [style, setStyle] = useState(detail.project.style)
  const [analysis, setAnalysis] = useState<Record<string, unknown>>(() => ({
    ...(detail.analysis ?? {}),
  }))
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const uploadInput = useRef<HTMLInputElement | null>(null)

  const uploadAssets = useMemo(
    () => detail.assets.filter((asset) => asset.type !== 'GENERATED' && asset.type !== 'EXPORTED'),
    [detail.assets],
  )

  const setField = (key: string, value: unknown) =>
    setAnalysis((current) => ({ ...current, [key]: value }))

  const doSaveMeta = () =>
    run('meta', async () => {
      await api.updateProject(detail.project.id, { name, platform, style })
      setNotice('项目信息已保存')
      await reload()
    })

  const doSaveAnalysis = () =>
    run('save-analysis', async () => {
      await api.saveAnalysis(detail.project.id, analysis)
      setNotice('分析结果已保存')
      await reload()
    })

  const doAnalyze = () =>
    run('analyze', async () => {
      const result = await api.analyze(detail.project.id)
      setAnalysis((result.analysis ?? {}) as Record<string, unknown>)
      setNotice('重新分析完成')
      await reload()
    })

  const doMove = (asset: AssetView, direction: -1 | 1) =>
    run('reorder', async () => {
      const ids = uploadAssets.map((item) => item.id)
      const index = ids.indexOf(asset.id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
      await api.reorderAssets(detail.project.id, ids)
      await reload()
    })

  const doSetMain = (asset: AssetView) =>
    run('set-main', async () => {
      await api.setMainAsset(detail.project.id, asset.id)
      setNotice(`已将 ${asset.fileName} 设为主图`)
      await reload()
    })

  const doDeleteAsset = (asset: AssetView) =>
    run('delete-asset', async () => {
      await api.deleteAsset(asset.id)
      setNotice(`已删除素材 ${asset.fileName}`)
      await reload()
    })

  const doUpload = (files: File[]) =>
    run('upload', async () => {
      for (const file of files) {
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/, ''))
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        await api.upload({
          projectId: detail.project.id,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          base64Data,
        })
      }
      setNotice(`已上传 ${files.length} 张素材`)
      await reload()
    })

  const doDeleteProject = () =>
    run('delete-project', async () => {
      await api.deleteProject(detail.project.id)
      onDeleted()
    })

  return (
    <div style={{ padding: 24, maxWidth: 920, display: 'grid', gap: 16 }}>
      <SectionHeading
        eyebrow="商品分析"
        title={detail.project.name}
        description="查看并修正 AI 分析结果，管理商品素材。所有修改会直接用于后续规划与生成。"
      />
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      {/* ------------------------------------------------ project meta -- */}
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>项目信息</strong>
          <div style={styles.row}>
            <Badge>{detail.project.status}</Badge>
            <Button onClick={doSaveMeta} disabled={busy !== null}>
              {busy === 'meta' ? '保存中…' : '保存信息'}
            </Button>
            {!confirmDelete ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                删除项目
              </Button>
            ) : (
              <>
                <Button variant="danger" disabled={busy !== null} onClick={doDeleteProject}>
                  {busy === 'delete-project' ? '删除中…' : '确认删除（不可恢复）'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  取消
                </Button>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="名称">
            <input value={name} onChange={(event) => setName(event.target.value)} style={styles.input} />
          </Field>
          <Field label="平台">
            <input value={platform} onChange={(event) => setPlatform(event.target.value)} style={styles.input} />
          </Field>
          <Field label="风格">
            <input value={style} onChange={(event) => setStyle(event.target.value)} style={styles.input} />
          </Field>
        </div>
      </div>

      {/* -------------------------------------------------------- assets -- */}
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>商品素材（{uploadAssets.length}）</strong>
          <Button onClick={() => uploadInput.current?.click()} disabled={busy !== null}>
            {busy === 'upload' ? '上传中…' : '上传素材'}
          </Button>
          <input
            ref={uploadInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              if (files.length) void doUpload(files)
              event.target.value = ''
            }}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          {uploadAssets.map((asset, index) => (
            <div key={asset.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ position: 'relative' }}>
                <img
                  src={asset.url}
                  alt={asset.fileName}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, background: T.cardMuted }}
                />
                {asset.isMain ? (
                  <span style={{ position: 'absolute', top: 6, left: 6 }}>
                    <Badge tone="accent">主图</Badge>
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: T.muted,
                  margin: '6px 0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {asset.fileName}
              </div>
              <div style={{ ...styles.row, flexWrap: 'wrap', gap: 4 }}>
                <Button title="上移" disabled={index === 0 || busy !== null} onClick={() => void doMove(asset, -1)} style={{ padding: '3px 9px', fontSize: 11 }}>
                  ↑
                </Button>
                <Button title="下移" disabled={index === uploadAssets.length - 1 || busy !== null} onClick={() => void doMove(asset, 1)} style={{ padding: '3px 9px', fontSize: 11 }}>
                  ↓
                </Button>
                {!asset.isMain ? (
                  <Button disabled={busy !== null} onClick={() => void doSetMain(asset)} style={{ padding: '3px 9px', fontSize: 11 }}>
                    设主图
                  </Button>
                ) : null}
                <Button variant="danger" disabled={busy !== null} onClick={() => void doDeleteAsset(asset)} style={{ padding: '3px 9px', fontSize: 11 }}>
                  删
                </Button>
              </div>
            </div>
          ))}
          {uploadAssets.length === 0 ? (
            <div style={{ color: T.muted, fontSize: 12 }}>还没有素材，先上传商品图。</div>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------ analysis -- */}
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>分析结果</strong>
          <div style={styles.row}>
            <Button onClick={doAnalyze} disabled={busy !== null}>
              {busy === 'analyze' ? '分析中…' : detail.analysis ? '重新分析' : '开始分析'}
            </Button>
            <Button variant="dark" onClick={doSaveAnalysis} disabled={busy !== null || !detail.analysis}>
              {busy === 'save-analysis' ? '保存中…' : '保存分析'}
            </Button>
          </div>
        </div>

        {!detail.analysis ? (
          <Notice kind="info">还没有分析结果。点「开始分析」，AI 会看图输出结构化卖点。</Notice>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {TEXT_FIELDS.map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    value={String(analysis[key] ?? '')}
                    onChange={(event) => setField(key, event.target.value)}
                    style={styles.input}
                  />
                </Field>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              {ARRAY_FIELDS.map(([key, label]) => (
                <Field key={key} label={`${label}（每行一条）`}>
                  <textarea
                    rows={4}
                    value={arrayToText(analysis[key])}
                    onChange={(event) => setField(key, textToArray(event.target.value))}
                    style={{ ...styles.input, resize: 'vertical' }}
                  />
                </Field>
              ))}
            </div>
            <Field label="补充信息">
              <textarea
                rows={5}
                value={String(analysis.additionalInformation ?? '')}
                onChange={(event) => setField('additionalInformation', event.target.value)}
                style={{ ...styles.input, resize: 'vertical' }}
              />
            </Field>
            <Field label="生成要求">
              <textarea
                rows={5}
                value={String(analysis.generationRequirements ?? '')}
                onChange={(event) => setField('generationRequirements', event.target.value)}
                style={{ ...styles.input, resize: 'vertical' }}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  )
}
