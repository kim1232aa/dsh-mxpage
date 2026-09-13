/**
 * MxPage panel — the workbench shell.
 *
 * Rebuilt to match the actual upstream MxPage product layout: a left rail
 * with brand header + nav items + attribution footer, and a main canvas that
 * shows either the "upload to start" welcome state or the phone-preview
 * workbench once a project exists.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { MxpageApi, type ProjectDetailResponse, type ProjectSummary } from './api.ts'
import { AnalysisView } from './views/analysis.tsx'
import { BatchView } from './views/batch.tsx'
import { ChannelsView } from './views/channels.tsx'
import { EditorView } from './views/editor.tsx'
import { ExportView } from './views/export.tsx'
import { MonitorView } from './views/monitor.tsx'
import { PlannerView } from './views/planner.tsx'
import { XiaohongshuView } from './views/xiaohongshu.tsx'
import { Badge, Button, Notice, styles, T } from './ui.tsx'

type Tab =
  | 'analysis'
  | 'planner'
  | 'editor'
  | 'export'
  | 'xiaohongshu'
  | 'batch'
  | 'monitor'
  | 'channels'

const NAV: Array<[Tab, string, string]> = [
  ['analysis', '分析', '🔍'],
  ['planner', '规划', '📐'],
  ['editor', '编辑', '✏️'],
  ['export', '导出', '📦'],
  ['xiaohongshu', '小红书图文', '📕'],
  ['batch', '批量 SKU', '🗂️'],
  ['monitor', '监控', '📊'],
  ['channels', 'AI 配置', '🔌'],
]

/** Tabs that need a selected project; the rest are project-independent. */
const PROJECT_TABS: ReadonlySet<Tab> = new Set(['analysis', 'planner', 'editor', 'export'])

function LogoMark() {
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 9,
        background: T.dark,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 800,
        flex: '0 0 auto',
      }}
    >
      M
    </span>
  )
}

export function MxpagePanel(props: { api: MxpageApi; onClose: () => void }) {
  const { api, onClose } = props

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null)
  const [tab, setTab] = useState<Tab>('planner')
  const [sectionId, setSectionId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const reloadProjects = useCallback(async () => {
    try {
      const result = await api.listProjects()
      setProjects(result.projects)
      return result.projects
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return []
    }
  }, [api])

  const reloadDetail = useCallback(
    async (id: string | null = projectId) => {
      if (!id) return
      try {
        const result = await api.getProject(id)
        setDetail(result)
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, projectId],
  )

  useEffect(() => {
    void reloadProjects()
  }, [reloadProjects])

  useEffect(() => {
    if (projectId) void reloadDetail(projectId)
    else setDetail(null)
  }, [projectId, reloadDetail])

  /** Serializes one async action behind the shared `busy` label. */
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [])

  const createProject = (files: File[]) =>
    run('create', async () => {
      if (files.length === 0) throw new Error('至少选择一张商品图')
      const first = files[0]!
      const created = await api.createProjectWithUpload(first.name.replace(/\.[^.]+$/, ''), files)
      await reloadProjects()
      setProjectId(created.projectId)
    })

  return (
    <div style={styles.root}>
      <div style={styles.body}>
        {/* -------------------------------------------------- left rail -- */}
        <div style={styles.rail}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 14px' }}>
            <LogoMark />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, lineHeight: 1.2 }}>MxPage</div>
              <div style={{ fontSize: 10.5, color: T.muted }}>AI 商品图文工作台</div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 2, marginBottom: 10 }}>
            {NAV.map(([value, label, icon]) => (
              <Button key={value} variant="nav" active={tab === value} onClick={() => setTab(value)}>
                <span style={{ fontSize: 14 }}>{icon}</span>
                {label}
              </Button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, padding: '10px 10px 6px' }}>
            项目（{projects.length}）
          </div>
          {/* alignContent:'start' — a plain grid inside a taller flex column
              stretches its rows to fill the height (default align-content:
              stretch), which rendered each project as a giant pink block. */}
          <div style={{ display: 'grid', gap: 2, overflowY: 'auto', flex: '1 1 auto', minHeight: 60, alignContent: 'start' }}>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  setProjectId(project.id)
                  setSectionId(null)
                }}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  textAlign: 'left',
                  background: project.id === projectId ? T.accentSoft : 'transparent',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 8px',
                  color: T.text,
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    flex: '0 0 auto',
                    borderRadius: 6,
                    border: `1px solid ${T.border}`,
                    background: T.cardMuted,
                    overflow: 'hidden',
                  }}
                >
                  {project.coverImageUrl ? (
                    <img
                      src={project.coverImageUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : null}
                </span>
                <span
                  style={{
                    minWidth: 0,
                    flex: '1 1 auto',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12.5,
                  }}
                >
                  {project.name}
                </span>
              </button>
            ))}
          </div>

          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 12 }}>
            <div style={{ fontSize: 10.5, color: T.muted }}>出品方</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, margin: '2px 0 6px' }}>灵矩绘境 · MxPage</div>
            <Button variant="ghost" onClick={onClose} style={{ padding: '6px 0', color: T.muted }}>
              关闭面板
            </Button>
          </div>
        </div>

        {/* --------------------------------------------------- main area -- */}
        <div style={styles.main}>
          {error ? <Notice kind="error">{error}</Notice> : null}

          {tab === 'channels' ? (
            <ChannelsView api={api} />
          ) : tab === 'xiaohongshu' ? (
            <XiaohongshuView api={api} busy={busy} run={run} />
          ) : tab === 'batch' ? (
            <BatchView
              api={api}
              busy={busy}
              run={run}
              onOpenProject={(id) => {
                void reloadProjects()
                setProjectId(id)
                setTab('analysis')
              }}
            />
          ) : tab === 'monitor' ? (
            <MonitorView api={api} />
          ) : !detail || !PROJECT_TABS.has(tab) ? (
            <WelcomeUpload busy={busy} dragOver={dragOver} setDragOver={setDragOver} fileInput={fileInput} onFiles={createProject} />
          ) : tab === 'analysis' ? (
            <AnalysisView
              api={api}
              detail={detail}
              busy={busy}
              run={run}
              reload={() => reloadDetail()}
              onDeleted={() => {
                setProjectId(null)
                setDetail(null)
                void reloadProjects()
              }}
            />
          ) : tab === 'planner' ? (
            <PlannerView
              api={api}
              detail={detail}
              busy={busy}
              run={run}
              reload={() => reloadDetail()}
              onOpenEditor={(id) => {
                setSectionId(id)
                setTab('editor')
              }}
            />
          ) : tab === 'export' ? (
            <ExportView api={api} detail={detail} busy={busy} run={run} />
          ) : (
            <EditorView
              api={api}
              detail={detail}
              busy={busy}
              run={run}
              reload={() => reloadDetail()}
              selectedSectionId={sectionId}
              onSelectSection={setSectionId}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** The upstream "上传产品图片" welcome / drop-zone state. */
function WelcomeUpload(props: {
  busy: string | null
  dragOver: boolean
  setDragOver: (value: boolean) => void
  fileInput: RefObject<HTMLInputElement | null>
  onFiles: (files: File[]) => void
}) {
  const { busy, dragOver, setDragOver, fileInput, onFiles } = props
  const [staged, setStaged] = useState<File[]>([])

  return (
    <div
      style={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 40,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.01em' }}>上传产品图片</div>
      <div style={{ color: T.muted, fontSize: 13.5, marginTop: 8, marginBottom: 28 }}>
        上传一张产品白底图，AI 将自动分析产品信息
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'))
          if (files.length) setStaged(files)
        }}
        onClick={() => fileInput.current?.click()}
        style={{
          width: 'min(560px, 90%)',
          minHeight: 260,
          background: T.card,
          border: `1.5px dashed ${dragOver ? T.accent : T.borderStrong}`,
          borderRadius: 18,
          boxShadow: T.shadow,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          cursor: 'pointer',
          padding: 24,
        }}
      >
        <input
          ref={fileInput as React.RefObject<HTMLInputElement>}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => setStaged(Array.from(event.target.files ?? []))}
        />
        {staged.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {staged.slice(0, 5).map((file, index) => (
              <img
                key={index}
                src={URL.createObjectURL(file)}
                alt=""
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 10, border: `1px solid ${T.border}` }}
              />
            ))}
          </div>
        ) : (
          <>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: 999,
                background: T.cardMuted,
                border: `1px solid ${T.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
              }}
            >
              ⬆
            </span>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>点击上传产品图片</div>
          </>
        )}
        <div style={{ color: T.muted, fontSize: 11.5 }}>支持 JPG、PNG、WEBP，建议使用清晰的白底主图</div>
      </div>

      <Button
        variant="dark"
        disabled={staged.length === 0 || busy !== null}
        onClick={() => onFiles(staged)}
        style={{ marginTop: 22, padding: '11px 32px', fontSize: 13.5 }}
      >
        {busy === 'create' ? '创建中…' : '⬆ 开始分析'}
      </Button>
    </div>
  )
}
