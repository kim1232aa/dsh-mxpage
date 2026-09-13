/**
 * Planner screen — the section planning workbench.
 *
 * Rebuilt to match the actual upstream MxPage layout: a header with the
 * project title and a one-click export action, a config strip (language /
 * hero+detail counts / aspect ratio), and a three-column body — module tree,
 * phone-frame preview, and a module edit panel — mirroring
 * `components/planner/planner-workspace.tsx` + `components/editor/editor-workspace.tsx`.
 */

import { useMemo, useState } from 'react'

import type { MxpageApi, ProjectDetailResponse, SectionView } from '../api.ts'
import { Badge, Button, ConfigChip, Field, Notice, SectionHeading, styles, statusLabel, statusTone, T } from '../ui.tsx'

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

const LANGUAGES: Array<[string, string]> = [
  ['zh-CN', '简体中文'],
  ['en-US', 'English'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
]

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
  const [language, setLanguage] = useState((preview.contentLanguage as string) ?? 'zh-CN')
  const [autoDecide, setAutoDecide] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmReplan, setConfirmReplan] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showStyleGuide, setShowStyleGuide] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const analyzed = Boolean(detail.analysis)
  const hasSections = detail.sections.length > 0
  const selected = useMemo(
    () => detail.sections.find((section) => section.id === selectedId) ?? detail.sections[0] ?? null,
    [detail.sections, selectedId],
  )

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
        { heroImageCount: heroCount, detailSectionCount: detailCount, imageAspectRatio: aspect, contentLanguage: language },
        { autoDecideCounts: autoDecide },
      )
      setNotice(result.fallbackMode === 'template_plan' ? 'AI 返回结构不完整，已自动切换为模板规划。' : '规划完成')
      setConfirmReplan(false)
      setShowConfig(false)
      await reload()
    })

  const doGenerateAll = (mode: 'missing' | 'all') =>
    run(`page-${mode}`, async () => {
      const { jobId, total } = await api.generatePage(detail.project.id, mode)
      setNotice(`后台任务已启动，共 ${total} 张，完成后自动刷新。`)
      for (let i = 0; i < 600; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const status = await api.jobStatus(jobId).catch(() => null)
        if (!status || (status.state !== 'running' && status.state !== 'stopping')) {
          setNotice(`生成结束：${status?.state === 'completed' ? '已完成' : (status?.state ?? '未知')}`)
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

  const doExport = () =>
    run('export', async () => {
      const result = await api.exportProject(detail.project.id, 'zip')
      setNotice(`已导出：${result.fileName ?? result.zipPath ?? 'ok'}`)
    })

  // ---- pre-analysis / pre-plan empty states, matching upstream's guided flow
  if (!analyzed) {
    return (
      <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ ...styles.card, width: 'min(480px,92%)', textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>开始商品分析</div>
          <div style={{ color: T.muted, fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
            AI 将基于主图识别商品类别、材质与核心卖点，作为后续规划与生成的依据。
          </div>
          <Button variant="dark" onClick={doAnalyze} disabled={busy !== null} style={{ padding: '10px 28px' }}>
            {busy === 'analyze' ? '分析中…' : '开始分析'}
          </Button>
        </div>
      </div>
    )
  }

  if (!hasSections) {
    return (
      <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ ...styles.card, width: 'min(520px,92%)', padding: 32 }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, textAlign: 'center' }}>规划详情页结构</div>
          <div style={{ color: T.muted, fontSize: 13, marginBottom: 20, textAlign: 'center', lineHeight: 1.6 }}>
            设置头图与详情分区数量，AI 将生成统一的视觉风格与每个模块的文案、提示词。
          </div>
          <PlanConfigForm
            heroCount={heroCount} setHeroCount={setHeroCount}
            detailCount={detailCount} setDetailCount={setDetailCount}
            aspect={aspect} setAspect={setAspect}
            language={language} setLanguage={setLanguage}
            autoDecide={autoDecide} setAutoDecide={setAutoDecide}
          />
          <Button variant="dark" full onClick={doPlan} disabled={busy !== null} style={{ marginTop: 18, padding: '10px' }}>
            {busy === 'plan' ? '规划中…' : '生成规划'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ------------------------------------------------------- header -- */}
      <div style={{ padding: '18px 24px 0' }}>
        {notice ? <Notice kind="info">{notice}</Notice> : null}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <SectionHeading
            eyebrow="预览与编辑"
            title={`${detail.project.name} 的商品页工作台`}
            description="左侧查看模块顺序与生成状态，中间查看手机商品页预览，右侧编辑标题、文案和视觉 Prompt。"
          />
          <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
            <Button onClick={() => setShowConfig((v) => !v)}>配置</Button>
            <Button
              variant="dark"
              disabled={busy !== null}
              onClick={() => doGenerateAll('missing')}
            >
              {busy === 'page-missing' ? '生成中…' : '一键生成缺图'}
            </Button>
          </div>
        </div>

        <div
          style={{
            ...styles.card,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            flexWrap: 'wrap',
            padding: '10px 16px',
            marginBottom: 16,
          }}
        >
          <ConfigChip label="内容语言" value={LANGUAGES.find(([v]) => v === language)?.[1] ?? language} tone="ok" />
          <ConfigChip label="头图" value={`${heroCount} 张`} tone="accent" />
          <ConfigChip label="详情页" value={`${detailCount} 张`} tone="warn" />
          <ConfigChip label="详情图比例" value={aspect} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {hasSections ? (
              <Button variant="ghost" onClick={() => setConfirmReplan(true)} disabled={busy !== null}>
                重新规划
              </Button>
            ) : null}
            <Button onClick={doExport} disabled={busy !== null}>
              {busy === 'export' ? '导出中…' : '导出 ZIP'}
            </Button>
            <Button variant="dark" onClick={() => doGenerateAll('all')} disabled={busy !== null}>
              {busy === 'page-all' ? '生成中…' : '一键导出详情页图像'}
            </Button>
          </div>
        </div>

        {showConfig ? (
          <div style={{ ...styles.card, marginBottom: 16 }}>
            <PlanConfigForm
              heroCount={heroCount} setHeroCount={setHeroCount}
              detailCount={detailCount} setDetailCount={setDetailCount}
              aspect={aspect} setAspect={setAspect}
              language={language} setLanguage={setLanguage}
              autoDecide={autoDecide} setAutoDecide={setAutoDecide}
              compact
            />
          </div>
        ) : null}

        {confirmReplan ? (
          <Notice kind="error">
            重新规划会删除该项目全部分区、版本与已生成的图。
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <Button variant="danger" onClick={doPlan} disabled={busy !== null}>确认重新规划</Button>
              <Button variant="ghost" onClick={() => setConfirmReplan(false)}>取消</Button>
            </div>
          </Notice>
        ) : null}

        {styleGuide ? (
          <div style={{ marginBottom: 4 }}>
            <button
              type="button"
              onClick={() => setShowStyleGuide((v) => !v)}
              style={{ background: 'none', border: 'none', color: T.mutedStrong, fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: showStyleGuide ? 8 : 16 }}
            >
              {showStyleGuide ? '▾' : '▸'} 视觉风格契约 · {styleGuide.styleName ?? '未命名'}
            </button>
            {showStyleGuide ? (
              <div style={{ ...styles.card, marginBottom: 16, display: 'grid', gap: 6 }}>
                {Object.entries(styleGuide).filter(([, v]) => v).map(([key, value]) => (
                  <div key={key} style={{ fontSize: 12 }}>
                    <span style={{ color: T.muted }}>{key}</span>
                    <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{value}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* --------------------------------------------------- three-column -- */}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 16, padding: '0 24px 24px' }}>
        <ModuleTree
          sections={detail.sections}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
        <PhonePreview sections={detail.sections} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        <ModuleEditPanel
          api={api}
          projectId={detail.project.id}
          section={selected}
          busy={busy}
          run={run}
          reload={reload}
          onGenerate={doGenerateOne}
          onOpenEditor={onOpenEditor}
        />
      </div>
    </div>
  )
}

function PlanConfigForm(props: {
  heroCount: number; setHeroCount: (v: number) => void
  detailCount: number; setDetailCount: (v: number) => void
  aspect: string; setAspect: (v: string) => void
  language: string; setLanguage: (v: string) => void
  autoDecide: boolean; setAutoDecide: (v: boolean) => void
  compact?: boolean
}) {
  const { heroCount, setHeroCount, detailCount, setDetailCount, aspect, setAspect, language, setLanguage, autoDecide, setAutoDecide } = props
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
      <Field label="头图数量 (1–5)" style={{ width: 130 }}>
        <input type="number" min={1} max={5} value={heroCount} onChange={(e) => setHeroCount(Number(e.target.value))} style={styles.input} />
      </Field>
      <Field label="详情分区 (1–10)" style={{ width: 130 }}>
        <input type="number" min={1} max={10} value={detailCount} onChange={(e) => setDetailCount(Number(e.target.value))} style={styles.input} />
      </Field>
      <Field label="画幅" style={{ width: 110 }}>
        <select value={aspect} onChange={(e) => setAspect(e.target.value)} style={styles.input}>
          <option value="3:4">3:4</option>
          <option value="9:16">9:16</option>
        </select>
      </Field>
      <Field label="图内文案语言" style={{ width: 150 }}>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={styles.input}>
          {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label="数量决策" style={{ width: 130 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.mutedStrong, height: 36 }}>
          <input type="checkbox" checked={autoDecide} onChange={(e) => setAutoDecide(e.target.checked)} />
          让 AI 决定
        </label>
      </Field>
    </div>
  )
}

function ModuleTree(props: { sections: SectionView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { sections, selectedId, onSelect } = props
  return (
    <div style={{ width: 260, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>模块结构树</div>
        <div style={{ color: T.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
          查看模块顺序、生成状态和当前选中的编辑对象。
        </div>
      </div>
      <div style={{ overflowY: 'auto', display: 'grid', gap: 8, flex: '1 1 auto' }}>
        {sections.map((section, index) => (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            style={{
              textAlign: 'left',
              background: T.card,
              border: `1.5px solid ${section.id === selectedId ? T.dark : T.border}`,
              borderRadius: 12,
              boxShadow: T.shadowSm,
              padding: 12,
              cursor: 'pointer',
              font: 'inherit',
              color: T.text,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <span style={{ color: T.muted, fontSize: 11 }}>#{index + 1}</span>
              <Badge tone={section.status === 'SUCCESS' ? 'ok' : section.status === 'FAILED' ? 'danger' : 'muted'}>
                {statusLabel(section.status) === '未开始' ? '未开始' : statusLabel(section.status)}
              </Badge>
            </div>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, lineHeight: 1.4 }}>{section.title}</div>
            <div style={{ color: T.muted, fontSize: 11, marginBottom: 6 }}>
              {SECTION_TYPE_LABELS[section.type] ?? section.type}
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <Badge>{SECTION_TYPE_LABELS[section.type] ?? section.type}</Badge>
              {section.imageUrl ? <Badge tone="accent">AI 真图</Badge> : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function PhonePreview(props: { sections: SectionView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { sections, selectedId, onSelect } = props
  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>手机商品页预览</div>
        <div style={{ color: T.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
          头图支持点击切换，详情图无缝衔接。
        </div>
      </div>
      <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center', overflowY: 'auto', paddingTop: 4 }}>
        <div
          style={{
            width: 300,
            flex: '0 0 auto',
            background: '#0d0e12',
            borderRadius: 34,
            padding: 10,
            boxShadow: '0 20px 45px rgba(23,24,28,0.18)',
            height: 'fit-content',
          }}
        >
          <div style={{ background: T.card, borderRadius: 24, overflow: 'hidden' }}>
            {sections
              .filter((section) => section.imageUrl)
              .map((section) => (
                <img
                  key={section.id}
                  src={section.imageUrl ?? undefined}
                  alt={section.title}
                  onClick={() => onSelect(section.id)}
                  style={{
                    width: '100%',
                    display: 'block',
                    cursor: 'pointer',
                    outline: section.id === selectedId ? `2px solid ${T.accent}` : 'none',
                    outlineOffset: -2,
                  }}
                />
              ))}
            {sections.every((section) => !section.imageUrl) ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: T.muted, fontSize: 12 }}>
                还没有生成任何图片
                <br />
                在右侧或模块卡片上点「生成」
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function ModuleEditPanel(props: {
  api: MxpageApi
  projectId: string
  section: SectionView | null
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  reload: () => Promise<void>
  onGenerate: (section: SectionView) => Promise<void>
  onOpenEditor: (sectionId: string) => void
}) {
  const { api, projectId, section, busy, run, reload, onGenerate, onOpenEditor } = props

  if (!section) {
    return (
      <div style={{ width: 320, flex: '0 0 auto', ...styles.card, height: 'fit-content' }}>
        <div style={{ color: T.muted, fontSize: 12.5 }}>选择左侧模块查看详情</div>
      </div>
    )
  }

  return (
    <div style={{ width: 320, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>模块编辑面板</div>
        <div style={{ color: T.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
          编辑模块内容、发起生成与重绘，并管理版本历史。
        </div>
      </div>
      <div style={{ ...styles.card, overflowY: 'auto', flex: '1 1 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 12.5 }}>当前出图结果</span>
          {section.imageUrl ? <Badge tone="accent">AI 真图</Badge> : <Badge>未生成</Badge>}
        </div>
        <div style={{ color: T.muted, fontSize: 11.5, marginBottom: 16, lineHeight: 1.6 }}>
          生成完成后会自动保存到项目资源、版本历史以及当前生效版本。
        </div>

        <Field label="类型">
          <div style={{ ...styles.input, background: T.cardMuted }}>
            {SECTION_TYPE_LABELS[section.type] ?? section.type}
          </div>
        </Field>
        <Field label="标题">
          <div style={{ ...styles.input, background: T.cardMuted }}>{section.title}</div>
        </Field>
        <Field label="模块目标">
          <div style={{ ...styles.input, background: T.cardMuted, minHeight: 40 }}>{section.goal}</div>
        </Field>
        <Field label="模块文案">
          <div style={{ ...styles.input, background: T.cardMuted, minHeight: 60, whiteSpace: 'pre-wrap' }}>
            {section.copy || '—'}
          </div>
        </Field>
        <Field label="视觉 Prompt">
          <div style={{ ...styles.mono, ...styles.input, background: T.cardMuted, maxHeight: 140, overflowY: 'auto' }}>
            {section.visualPrompt || '—'}
          </div>
        </Field>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <Button
            variant="dark"
            full
            disabled={busy !== null}
            onClick={() => onGenerate(section)}
          >
            {busy === `gen-${section.id}` ? '生成中…' : section.imageUrl ? '重新生成' : '生成'}
          </Button>
          <Button onClick={() => onOpenEditor(section.id)}>详细编辑</Button>
        </div>
      </div>
    </div>
  )
}
