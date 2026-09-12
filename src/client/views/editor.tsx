/**
 * Editor screen — per-section editing and version control.
 *
 * Ported surface from upstream `components/editor/editor-workspace.tsx`
 * (55 KB / 1163 lines). Covers: the section picker, the current image preview,
 * inline editing of title/goal/copy/visualPrompt, generate / regenerate /
 * repaint / enhance / translate, and version list + activate.
 *
 * Upstream rendered a phone-frame page preview; that is presentation, and the
 * behaviour worth keeping is here: every generation creates a NEW version and
 * never overwrites, so the version list is the undo history.
 */

import { useEffect, useMemo, useState } from 'react'

import type { MxpageApi, ProjectDetailResponse, SectionView, VersionView } from '../api.ts'
import { Badge, Button, Field, Notice, styles, statusTone, T } from '../ui.tsx'

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
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ width: 220, flex: '0 0 auto', display: 'grid', gap: 4 }}>
        <div style={{ color: T.muted, fontSize: 12, padding: '0 4px 4px' }}>
          分区 ({detail.sections.length})
        </div>
        {detail.sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelectSection(section.id)}
            style={{
              textAlign: 'left',
              background: section.id === selected?.id ? T.accentSoft : 'transparent',
              border: `1px solid ${section.id === selected?.id ? T.accent : T.border}`,
              borderRadius: 6,
              color: T.text,
              padding: '6px 8px',
              font: 'inherit',
              cursor: 'pointer',
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {section.title}
            </span>
            <Badge tone={statusTone(section.status)}>{section.imageUrl ? '有图' : section.status}</Badge>
          </button>
        ))}
        {detail.sections.length === 0 ? (
          <div style={{ color: T.muted, fontSize: 12, padding: 4 }}>还没有分区</div>
        ) : null}
      </div>

      {selected ? (
        <SectionEditor
          key={selected.id}
          api={api}
          detail={detail}
          section={selected}
          busy={busy}
          run={run}
          reload={reload}
        />
      ) : (
        <div style={{ color: T.muted }}>先在「规划」页生成分区。</div>
      )}
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
    title !== section.title ||
    goal !== section.goal ||
    copy !== section.copy ||
    visualPrompt !== section.visualPrompt

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
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 14 }}>
      {note ? <Notice kind="success">{note}</Notice> : null}

      <div style={{ ...styles.card, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 220,
            flex: '0 0 auto',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.bg,
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
            <span style={{ fontSize: 12, padding: 20 }}>还没有成品图</span>
          )}
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ ...styles.row, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge>{section.type}</Badge>
            <Badge tone={statusTone(section.status)}>{section.status}</Badge>
            <span style={{ color: T.muted, fontSize: 11 }}>{section.sectionKey}</span>
          </div>

          <div style={{ ...styles.row, flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={busy !== null} onClick={() => generate(false)}>
              {busy === `gen-${section.id}` ? '生成中…' : preview ? '重新生成' : '生成'}
            </Button>
            <Button disabled={!preview || busy !== null} onClick={() => generate(true)}>
              重绘（保留身份）
            </Button>
            <Button disabled={!preview || busy !== null} onClick={() => edit('repaint')}>
              Repaint
            </Button>
            <Button disabled={!preview || busy !== null} onClick={() => edit('enhance')}>
              Enhance
            </Button>
          </div>

          <div style={{ ...styles.row, marginTop: 8, flexWrap: 'wrap' }}>
            <select
              value={translateTo}
              onChange={(event) => setTranslateTo(event.target.value)}
              style={{ ...styles.input, width: 140 }}
            >
              {LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button disabled={!preview || busy !== null} onClick={() => edit('translate')}>
              {busy === `edit-${section.id}-translate` ? '翻译中…' : '图内文字翻译'}
            </Button>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>分区内容</strong>
          <div style={styles.row}>
            <Button disabled={!dirty || busy !== null} onClick={save}>
              {busy === `save-${section.id}` ? '保存中…' : dirty ? '保存修改' : '已保存'}
            </Button>
          </div>
        </div>

        <Field label="标题">
          <input value={title} onChange={(event) => setTitle(event.target.value)} style={styles.input} />
        </Field>
        <Field label="目标">
          <input value={goal} onChange={(event) => setGoal(event.target.value)} style={styles.input} />
        </Field>
        <Field label="图内文案">
          <textarea
            rows={3}
            value={copy}
            onChange={(event) => setCopy(event.target.value)}
            style={{ ...styles.input, resize: 'vertical' }}
          />
        </Field>
        <Field
          label="视觉提示词"
          hint="两段式：Primary Prompt / English Prompt。留空则由 Visual Prompt Agent 生成。"
        >
          <textarea
            rows={6}
            value={visualPrompt}
            onChange={(event) => setVisualPrompt(event.target.value)}
            style={{ ...styles.input, resize: 'vertical' }}
          />
        </Field>
      </div>

      <div style={styles.card}>
        <strong>版本历史（{versions.length}）</strong>
        <div style={{ color: T.muted, fontSize: 12, margin: '4px 0 10px' }}>
          每次生成或改图都是新版本，从不覆盖旧文件。
        </div>
        {versions.length === 0 ? (
          <div style={{ color: T.muted, fontSize: 12 }}>还没有版本</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {versions
              .slice()
              .sort((a, b) => b.versionNumber - a.versionNumber)
              .map((version) => (
                <button
                  key={version.id}
                  type="button"
                  onClick={() => activate(version.id)}
                  disabled={busy !== null || version.isActive}
                  style={{
                    width: 90,
                    padding: 4,
                    background: version.isActive ? T.accentSoft : T.panel,
                    border: `1px solid ${version.isActive ? T.accent : T.border}`,
                    borderRadius: 6,
                    color: T.text,
                    font: 'inherit',
                    cursor: version.isActive ? 'default' : 'pointer',
                  }}
                >
                  {version.imageUrl ? (
                    <img
                      src={version.imageUrl}
                      alt={`v${version.versionNumber}`}
                      style={{ width: '100%', height: 68, objectFit: 'cover', borderRadius: 4, display: 'block' }}
                    />
                  ) : (
                    <div style={{ height: 68 }} />
                  )}
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    v{version.versionNumber}
                    {version.isActive ? ' · 当前' : ''}
                  </div>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
