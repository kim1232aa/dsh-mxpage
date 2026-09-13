/**
 * Editor screen — per-section detailed editing and version control.
 *
 * Rebuilt in the same light theme as the planner: a section list, a preview
 * card, generate/edit actions, an editable-fields card, and a version strip.
 * Every generation creates a NEW version and never overwrites, so the version
 * list is the undo history.
 */

import { useEffect, useMemo, useState } from 'react'

import type { MxpageApi, ProjectDetailResponse, SectionView, VersionView } from '../api.ts'
import { Badge, Button, Field, Notice, SectionHeading, styles, statusLabel, statusTone, T } from '../ui.tsx'

const LANGUAGES = [
  ['en-US', 'English'],
  ['zh-CN', '简体中文'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
  ['es-ES', 'Español'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
] as const

export function EditorView(props: {
  api: MxpageApi
  detail: ProjectDetailResponse
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  reload: () => Promise<void>
  selectedSectionId: string | null
  onSelectSection: (sectionId: string) => void
}) {
  const { api, detail, busy, run, reload, selectedSectionId, onSelectSection } = props

  const selected = useMemo(
    () => detail.sections.find((section) => section.id === selectedSectionId) ?? detail.sections[0] ?? null,
    [detail.sections, selectedSectionId],
  )

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <SectionHeading eyebrow="详细编辑" title="分区编辑器" description="修改文案与视觉提示词、发起生成或重绘，并管理版本历史。" />
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 16 }}>
        <div style={{ width: 240, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ color: T.muted, fontSize: 11.5, fontWeight: 700, padding: '0 4px 8px' }}>
            分区（{detail.sections.length}）
          </div>
          <div style={{ overflowY: 'auto', display: 'grid', gap: 6, flex: '1 1 auto' }}>
            {detail.sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => onSelectSection(section.id)}
                style={{
                  textAlign: 'left',
                  background: section.id === selected?.id ? T.accentSoft : T.card,
                  border: `1.5px solid ${section.id === selected?.id ? T.dark : T.border}`,
                  borderRadius: 10,
                  boxShadow: T.shadowSm,
                  color: T.text,
                  padding: '8px 10px',
                  font: 'inherit',
                  cursor: 'pointer',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                  {section.title}
                </span>
                <Badge tone={statusTone(section.status)}>{section.imageUrl ? '有图' : statusLabel(section.status)}</Badge>
              </button>
            ))}
            {detail.sections.length === 0 ? (
              <div style={{ color: T.muted, fontSize: 12, padding: 8 }}>先在「规划」页生成分区。</div>
            ) : null}
          </div>
        </div>

        {selected ? (
          <SectionEditor key={selected.id} api={api} detail={detail} section={selected} busy={busy} run={run} reload={reload} />
        ) : (
          <div style={{ ...styles.card, flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted }}>
            选择左侧分区开始编辑
          </div>
        )}
      </div>
    </div>
  )
}

function SectionEditor(props: {
  api: MxpageApi
  detail: ProjectDetailResponse
  section: SectionView
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
  reload: () => Promise<void>
}) {
  const { api, detail, section, busy, run, reload } = props
  const projectId = detail.project.id

  const [title, setTitle] = useState(section.title)
  const [goal, setGoal] = useState(section.goal)
  const [copy, setCopy] = useState(section.copy)
  const [visualPrompt, setVisualPrompt] = useState(section.visualPrompt)
  const [translateTo, setTranslateTo] = useState('en-US')
  const [note, setNote] = useState<string | null>(null)
  const [versions, setVersions] = useState<VersionView[]>(section.versions)
  const [preview, setPreview] = useState(section.imageUrl)

  useEffect(() => {
    setTitle(section.title)
    setGoal(section.goal)
    setCopy(section.copy)
    setVisualPrompt(section.visualPrompt)
    setVersions(section.versions)
    setPreview(section.imageUrl)
  }, [section])

  const dirty =
    title !== section.title || goal !== section.goal || copy !== section.copy || visualPrompt !== section.visualPrompt

  const save = () =>
    run(`save-${section.id}`, async () => {
      await api.updateSection(section.id, { title, goal, copy, visualPrompt })
      setNote('已保存')
      await reload()
    })

  const generate = (regenerate: boolean) =>
    run(`gen-${section.id}`, async () => {
      const result = await api.generateSection(projectId, section.id, { regenerate })
      setPreview(result.imageUrl)
      setNote(`${regenerate ? '重绘' : '生成'}完成 · ${result.modelUsed}`)
      await reload()
      const fresh = await api.listVersions(section.id)
      setVersions(fresh.versions)
    })

  const edit = (editMode: 'repaint' | 'enhance' | 'translate') =>
    run(`edit-${section.id}-${editMode}`, async () => {
      const result = await api.editSection(projectId, section.id, editMode, {
        targetLanguage: editMode === 'translate' ? translateTo : undefined,
      })
      setPreview(result.imageUrl)
      setNote(`${editMode} 完成`)
      await reload()
      const fresh = await api.listVersions(section.id)
      setVersions(fresh.versions)
    })

  const activate = (versionId: string) =>
    run(`activate-${versionId}`, async () => {
      const result = await api.activateVersion(section.id, versionId)
      setPreview(result.imageUrl)
      setNote('已切换版本')
      await reload()
    })

  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, overflowY: 'auto', display: 'grid', gap: 16 }}>
      {note ? <Notice kind="success">{note}</Notice> : null}

      <div style={{ ...styles.card, display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 220,
            flex: '0 0 auto',
            borderRadius: 12,
            border: `1px solid ${T.border}`,
            background: T.cardMuted,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.muted,
            minHeight: 160,
          }}
        >
          {preview ? (
            <img src={preview} alt={section.title} style={{ width: '100%', display: 'block' }} />
          ) : (
            <span style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>还没有成品图</span>
          )}
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ ...styles.row, marginBottom: 12, flexWrap: 'wrap' }}>
            <Badge>{section.type}</Badge>
            <Badge tone={statusTone(section.status)}>{statusLabel(section.status)}</Badge>
            <span style={{ color: T.muted, fontSize: 11 }}>{section.sectionKey}</span>
          </div>

          <div style={{ ...styles.row, flexWrap: 'wrap' }}>
            <Button variant="dark" disabled={busy !== null} onClick={() => generate(false)}>
              {busy === `gen-${section.id}` ? '生成中…' : preview ? '重新生成' : '生成'}
            </Button>
            <Button disabled={!preview || busy !== null} onClick={() => generate(true)}>重绘（保留身份）</Button>
            <Button disabled={!preview || busy !== null} onClick={() => edit('repaint')}>Repaint</Button>
            <Button disabled={!preview || busy !== null} onClick={() => edit('enhance')}>Enhance</Button>
          </div>

          <div style={{ ...styles.row, marginTop: 10, flexWrap: 'wrap' }}>
            <select value={translateTo} onChange={(e) => setTranslateTo(e.target.value)} style={{ ...styles.input, width: 140 }}>
              {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <Button disabled={!preview || busy !== null} onClick={() => edit('translate')}>
              {busy === `edit-${section.id}-translate` ? '翻译中…' : '图内文字翻译'}
            </Button>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 12 }}>
          <strong style={{ fontSize: 13.5 }}>分区内容</strong>
          <Button disabled={!dirty || busy !== null} onClick={save}>
            {busy === `save-${section.id}` ? '保存中…' : dirty ? '保存修改' : '已保存'}
          </Button>
        </div>

        <Field label="标题"><input value={title} onChange={(e) => setTitle(e.target.value)} style={styles.input} /></Field>
        <Field label="目标"><input value={goal} onChange={(e) => setGoal(e.target.value)} style={styles.input} /></Field>
        <Field label="图内文案">
          <textarea rows={3} value={copy} onChange={(e) => setCopy(e.target.value)} style={{ ...styles.input, resize: 'vertical' }} />
        </Field>
        <Field label="视觉提示词" hint="两段式：Primary Prompt / English Prompt。留空则由 Visual Prompt Agent 生成。">
          <textarea rows={6} value={visualPrompt} onChange={(e) => setVisualPrompt(e.target.value)} style={{ ...styles.input, resize: 'vertical', ...styles.mono }} />
        </Field>
      </div>

      <div style={styles.card}>
        <strong style={{ fontSize: 13.5 }}>版本历史（{versions.length}）</strong>
        <div style={{ color: T.muted, fontSize: 12, margin: '4px 0 12px' }}>每次生成或改图都是新版本，从不覆盖旧文件。</div>
        {versions.length === 0 ? (
          <div style={{ color: T.muted, fontSize: 12 }}>还没有版本</div>
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {versions.slice().sort((a, b) => b.versionNumber - a.versionNumber).map((version) => (
              <button
                key={version.id}
                type="button"
                onClick={() => activate(version.id)}
                disabled={busy !== null || version.isActive}
                style={{
                  width: 96,
                  padding: 5,
                  background: version.isActive ? T.accentSoft : T.cardMuted,
                  border: `1.5px solid ${version.isActive ? T.accent : T.border}`,
                  borderRadius: 10,
                  color: T.text,
                  font: 'inherit',
                  cursor: version.isActive ? 'default' : 'pointer',
                }}
              >
                {version.imageUrl ? (
                  <img src={version.imageUrl} alt={`v${version.versionNumber}`} style={{ width: '100%', height: 72, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
                ) : (
                  <div style={{ height: 72 }} />
                )}
                <div style={{ fontSize: 11, marginTop: 5 }}>
                  v{version.versionNumber}{version.isActive ? ' · 当前' : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
