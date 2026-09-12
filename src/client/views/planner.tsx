/**
 * Planner screen — the section planning cockpit.
 *
 * Ported surface from upstream `components/planner/planner-workspace.tsx`
 * (70 KB / 1624 lines). Covers: analyze → plan, output-config (hero/detail
 * counts, aspect, language), the visual style guide, and the section list with
 * per-section generation.
 */

import { useState } from 'react'

import type { MxpageApi, ProjectDetailResponse, SectionView } from '../api.ts'
import { Badge, Button, Field, Notice, styles, statusTone, T } from '../ui.tsx'

const SECTION_TYPE_LABELS: Record<string, string> = {
  HERO: '头图主视觉',
  SELLING_POINTS: '卖点模块',
  SCENARIO: '场景展示',
  DETAIL_CLOSEUP: '细节特写',
  SPECS: '规格参数',
  MATERIAL: '材质工艺',
  COMPARISON: '对比说明',
  GIFT_SCENE: '送礼场景',
  BRAND_TRUST: '品牌信任',
  SUMMARY: '总结收口',
  CUSTOM: '自定义模块',
}

const LANGUAGES = [
  ['zh-CN', '简体中文'],
  ['en-US', 'English'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
  ['es-ES', 'Español'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['pt-PT', 'Português'],
  ['ar-SA', 'العربية'],
  ['ru-RU', 'Русский'],
] as const

export function PlannerView(props: {
  api: MxpageApi
  detail: ProjectDetailResponse
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  reload: () => Promise<void>
  onOpenEditor: (sectionId: string) => void
}) {
  const { api, detail, busy, run, reload, onOpenEditor } = props
  const snapshot = detail.project.modelSnapshot ?? {}
  const preview = (snapshot.previewConfig ?? {}) as Record<string, unknown>
  const styleGuide = (snapshot.visualStyleGuide ?? null) as Record<string, string> | null

  const [heroCount, setHeroCount] = useState(Number(preview.heroImageCount) || 3)
  const [detailCount, setDetailCount] = useState(Number(preview.detailSectionCount) || 6)
  const [aspect, setAspect] = useState((preview.imageAspectRatio as string) ?? '3:4')
  const [language, setLanguage] = useState(
    (preview.contentLanguage as string) ?? 'zh-CN',
  )
  const [autoDecide, setAutoDecide] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmReplan, setConfirmReplan] = useState(false)

  const analyzed = Boolean(detail.analysis)
  const hasSections = detail.sections.length > 0

  const doAnalyze = () =>
    run('analyze', async () => {
      await api.analyze(detail.project.id)
      setNotice('分析完成')
      await reload()
    })

  const doPlan = () =>
    run('plan', async () => {
      const result = await api.plan(
        detail.project.id,
        {
          heroImageCount: heroCount,
          detailSectionCount: detailCount,
          imageAspectRatio: aspect,
          contentLanguage: language,
        },
        { autoDecideCounts: autoDecide },
      )
      setNotice(
        result.fallbackMode === 'template_plan'
          ? 'AI 返回结构不完整，已自动切换为模板规划。'
          : '规划完成',
      )
      setConfirmReplan(false)
      await reload()
    })

  const doGenerateAll = (mode: 'missing' | 'all') =>
    run(`page-${mode}`, async () => {
      const { jobId, total } = await api.generatePage(detail.project.id, mode)
      setNotice(`后台 job ${jobId} 已启动，共 ${total} 张。完成后会刷新。`)
      // Poll until the job leaves running/stopping, then reload.
      for (let i = 0; i < 600; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const status = await api.jobStatus(jobId).catch(() => null)
        if (!status || (status.state !== 'running' && status.state !== 'stopping')) {
          setNotice(`job ${jobId} 结束：${status?.state ?? 'unknown'}`)
          break
        }
      }
      await reload()
    })

  const doGenerateOne = (section: SectionView) =>
    run(`gen-${section.id}`, async () => {
      await api.generateSection(detail.project.id, section.id)
      await reload()
    })

  return (
    <div>
      {notice ? <Notice kind="info">{notice}</Notice> : null}
      {!analyzed ? (
        <Notice kind="info">
          还没有商品分析。先跑「分析商品」——它只依据图像本身，不会用文件名猜商品。
        </Notice>
      ) : null}

      <div style={{ ...styles.card, marginBottom: 14 }}>
        <div style={{ ...styles.row, marginBottom: 10 }}>
          <strong>输出配置</strong>
          <span style={{ color: T.muted, fontSize: 12 }}>
            {detail.assets.length} 张商品图 · 主图{' '}
            {detail.assets.find((asset) => asset.isMain)?.fileName ?? '未设置'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Field label="头图数量 (1–5)" style={{ width: 120 }}>
            <input
              type="number"
              min={1}
              max={5}
              value={heroCount}
              onChange={(event) => setHeroCount(Number(event.target.value))}
              style={styles.input}
            />
          </Field>
          <Field label="详情分区 (1–10)" style={{ width: 130 }}>
            <input
              type="number"
              min={1}
              max={10}
              value={detailCount}
              onChange={(event) => setDetailCount(Number(event.target.value))}
              style={styles.input}
            />
          </Field>
          <Field label="画幅" style={{ width: 110 }}>
            <select
              value={aspect}
              onChange={(event) => setAspect(event.target.value)}
              style={styles.input}
            >
              <option value="3:4">3:4</option>
              <option value="9:16">9:16</option>
            </select>
          </Field>
          <Field label="图内文案语言" style={{ width: 160 }}>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              style={styles.input}
            >
              {LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="数量决策" style={{ width: 140 }}>
            <label style={{ ...styles.row, fontSize: 12, color: T.muted }}>
              <input
                type="checkbox"
                checked={autoDecide}
                onChange={(event) => setAutoDecide(event.target.checked)}
              />
              让模型决定
            </label>
          </Field>
        </div>

        <div style={{ ...styles.row, flexWrap: 'wrap', marginTop: 4 }}>
          <Button
            variant={analyzed ? 'default' : 'primary'}
            disabled={busy !== null}
            onClick={doAnalyze}
          >
            {busy === 'analyze' ? '分析中…' : analyzed ? '重新分析' : '分析商品'}
          </Button>
          <Button variant="primary" disabled={!analyzed || busy !== null} onClick={() => (hasSections ? setConfirmReplan(true) : doPlan())}>
            {busy === 'plan' ? '规划中…' : hasSections ? '重新规划' : '生成规划'}
          </Button>
          <Button
            disabled={!hasSections || busy !== null}
            onClick={() => doGenerateAll('missing')}
            title="只补没有图的分区"
          >
            {busy === 'page-missing' ? '生成中…' : '生成缺图'}
          </Button>
          <Button
            disabled={!hasSections || busy !== null}
            onClick={() => doGenerateAll('all')}
            title="全部重做，消耗更多额度"
          >
            {busy === 'page-all' ? '生成中…' : '全部重做'}
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() =>
              run('export', async () => {
                const result = await api.exportProject(detail.project.id, 'zip')
                setNotice(`已导出：${result.zipPath ?? result.fileName ?? 'ok'}`)
              })
            }
          >
            {busy === 'export' ? '导出中…' : '导出 ZIP'}
          </Button>
        </div>

        {confirmReplan ? (
          <div style={{ marginTop: 10 }}>
            <Notice kind="error">
              重新规划会**删除该项目全部 section、版本与已生成的图**。确认继续？
            </Notice>
            <div style={styles.row}>
              <Button variant="danger" onClick={doPlan} disabled={busy !== null}>
                确认重新规划
              </Button>
              <Button variant="ghost" onClick={() => setConfirmReplan(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {styleGuide ? (
        <details style={{ ...styles.card, marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer' }}>
            <strong>视觉风格契约</strong>{' '}
            <span style={{ color: T.muted, fontSize: 12 }}>
              {styleGuide.styleName ?? '未命名'} · 全套图共用，保证一致性
            </span>
          </summary>
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            {Object.entries(styleGuide)
              .filter(([, value]) => value)
              .map(([key, value]) => (
                <div key={key} style={{ fontSize: 12 }}>
                  <span style={{ color: T.muted }}>{key}</span>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{value}</div>
                </div>
              ))}
          </div>
        </details>
      ) : null}

      <div style={{ ...styles.card }}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>分区（{detail.sections.length}）</strong>
          <span style={{ color: T.muted, fontSize: 12 }}>
            有图 {detail.sections.filter((section) => section.imageUrl).length} / {detail.sections.length}
          </span>
        </div>

        {detail.sections.length === 0 ? (
          <div style={{ color: T.muted }}>还没有分区。先跑「生成规划」。</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {detail.sections.map((section, index) => (
              <div
                key={section.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  padding: 8,
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  background: T.panel,
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    flex: '0 0 auto',
                    borderRadius: 6,
                    background: T.bg,
                    border: `1px solid ${T.border}`,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: T.muted,
                    fontSize: 11,
                  }}
                >
                  {section.imageUrl ? (
                    <img
                      src={section.imageUrl}
                      alt={section.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    '无图'
                  )}
                </div>

                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ ...styles.row, gap: 6 }}>
                    <span style={{ color: T.muted, fontSize: 11 }}>{index + 1}</span>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {section.title}
                    </strong>
                    <Badge>{SECTION_TYPE_LABELS[section.type] ?? section.type}</Badge>
                    <Badge tone={statusTone(section.status)}>{section.status}</Badge>
                    {section.versions.length > 0 ? (
                      <Badge>v{section.versions.length}</Badge>
                    ) : null}
                  </div>
                  <div
                    style={{
                      color: T.muted,
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {section.goal || section.copy || '—'}
                  </div>
                </div>

                <div style={{ ...styles.row, flex: '0 0 auto' }}>
                  <Button disabled={busy !== null} onClick={() => doGenerateOne(section)}>
                    {busy === `gen-${section.id}` ? '生成中…' : section.imageUrl ? '重绘' : '生成'}
                  </Button>
                  <Button variant="ghost" onClick={() => onOpenEditor(section.id)}>
                    编辑
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
