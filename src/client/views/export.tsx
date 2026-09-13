/**
 * Export screen — the one-click export panel.
 *
 * Port of upstream `components/export/export-panel.tsx`: zip/json export
 * actions, the model snapshot for context checking, and a preview of what
 * will be exported (hero candidates + generated section images).
 */

import { useState } from 'react'

import type { MxpageApi, ProjectDetailResponse } from '../api.ts'
import { Badge, Button, Notice, SectionHeading, styles, T } from '../ui.tsx'

export function ExportView(props: {
  api: MxpageApi
  detail: ProjectDetailResponse
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
}) {
  const { api, detail, busy, run } = props
  const [notice, setNotice] = useState<string | null>(null)
  const [jsonPreview, setJsonPreview] = useState<string | null>(null)

  const snapshot = (detail.project.modelSnapshot ?? {}) as Record<string, unknown>
  const preview = (snapshot.previewConfig ?? {}) as Record<string, unknown>
  const heroCount = Math.min(5, Math.max(1, Number(preview.heroImageCount ?? 4)))
  const detailCount = Math.min(10, Math.max(1, Number(preview.detailSectionCount ?? 6)))

  const galleryAssets = detail.assets.filter((asset) =>
    ['MAIN', 'ANGLE', 'DETAIL'].includes(asset.type),
  )
  const generatedSections = detail.sections.filter((section) => Boolean(section.imageUrl))

  const doZip = () =>
    run('export', async () => {
      const result = await api.exportProject(detail.project.id, 'zip')
      setNotice(`已导出 ZIP：${result.fileName ?? ''}（${result.zipPath ?? 'ok'}）`)
      setJsonPreview(null)
    })

  const doJson = () =>
    run('export-json', async () => {
      const result = await api.exportProject(detail.project.id, 'json')
      setJsonPreview(JSON.stringify((result as Record<string, unknown>).project ?? result, null, 2))
      setNotice('已导出项目 JSON（见下方预览）')
    })

  return (
    <div style={{ padding: 24, maxWidth: 1080 }}>
      <SectionHeading
        eyebrow="导出"
        title={`导出「${detail.project.name}」`}
        description="导出当前商品页预览中使用的全部图像，包含头图轮播和详情页模块图，同时附带导出清单。"
      />
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(300px,400px) minmax(0,1fr)' }}>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div style={styles.card}>
            <strong>一键导出</strong>
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              <Button variant="dark" full disabled={busy !== null} onClick={doZip}>
                {busy === 'export' ? '导出中…' : '⬇ 导出详情页全部图像 ZIP'}
              </Button>
              <Button full disabled={busy !== null} onClick={doJson}>
                {busy === 'export-json' ? '导出中…' : '导出项目 JSON'}
              </Button>
            </div>
            <div style={{ background: T.cardMuted, borderRadius: 10, padding: 14, marginTop: 14, fontSize: 12, color: T.mutedStrong }}>
              <strong style={{ color: T.text }}>本次导出说明</strong>
              <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                <span>头图目录：按当前预览配置导出前 {heroCount} 张头图。</span>
                <span>详情目录：按当前预览配置导出前 {detailCount} 个详情模块图。</span>
                <span>
                  压缩包内会生成 <code style={styles.mono}>00-头图/</code>、
                  <code style={styles.mono}>01-详情页/</code> 和 <code style={styles.mono}>export-manifest.json</code>。
                </span>
              </div>
            </div>
          </div>

          <div style={styles.card}>
            <strong>模型快照</strong>
            <div style={{ color: T.muted, fontSize: 12, margin: '4px 0 10px' }}>
              当前项目的输出配置与模型选择，仅用于核对导出上下文。
            </div>
            <pre
              style={{
                ...styles.mono,
                maxHeight: 320,
                overflow: 'auto',
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: 10,
                padding: 14,
                fontSize: 11,
              }}
            >
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </div>
        </div>

        <div style={styles.card}>
          <strong>当前可导出内容</strong>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>头图候选素材</span>
              <Badge>{galleryAssets.length} 个素材</Badge>
            </div>
            {galleryAssets.length === 0 ? (
              <div style={{ border: `1px dashed ${T.borderStrong}`, borderRadius: 10, padding: 14, color: T.muted, fontSize: 12 }}>
                暂无头图素材
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                {galleryAssets.map((asset) => (
                  <div key={asset.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 6 }}>
                    <img
                      src={asset.url}
                      alt={asset.fileName}
                      style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, background: T.cardMuted }}
                    />
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
                      {asset.type}
                      {asset.isMain ? ' · 主图' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 18 }}>
            <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>详情页模块图</span>
              <Badge tone={generatedSections.length ? 'ok' : 'warn'}>
                {generatedSections.length} / {detail.sections.length} 已出图
              </Badge>
            </div>
            {generatedSections.length === 0 ? (
              <div style={{ border: `1px dashed ${T.borderStrong}`, borderRadius: 10, padding: 14, color: T.muted, fontSize: 12 }}>
                暂无已生成的模块图，请先在「编辑」页签生成。
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                {generatedSections.map((section) => (
                  <div key={section.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 6 }}>
                    <img
                      src={section.imageUrl ?? ''}
                      alt={section.title}
                      style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', borderRadius: 6, background: T.cardMuted }}
                    />
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{section.title}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {jsonPreview ? (
            <div style={{ marginTop: 18 }}>
              <strong>项目 JSON</strong>
              <pre
                style={{
                  ...styles.mono,
                  maxHeight: 380,
                  overflow: 'auto',
                  background: T.cardMuted,
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  padding: 14,
                  marginTop: 8,
                  fontSize: 11,
                }}
              >
                {jsonPreview}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
