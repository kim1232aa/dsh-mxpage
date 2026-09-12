/**
 * MxPage panel — the workbench shell.
 *
 * Four screens, matching the objective: 规划 (planner), 编辑 (editor),
 * 小红书 (the four-step flow), 渠道 (channel diagnostics), plus the project
 * rail that all of them share.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { MxpageApi, type ProjectDetailResponse, type ProjectSummary } from './api.ts'
import { ChannelsView } from './views/channels.tsx'
import { EditorView } from './views/editor.tsx'
import { PlannerView } from './views/planner.tsx'
import { XiaohongshuView } from './views/xiaohongshu.tsx'
import { Badge, Button, Field, Notice, styles, T } from './ui.tsx'

type Tab = 'planner' | 'editor' | 'xiaohongshu' | 'channels'

const TABS: Array<[Tab, string]> = [
  ['planner', '规划'],
  ['editor', '编辑'],
  ['xiaohongshu', '小红书'],
  ['channels', '渠道'],
]

export function MxpagePanel(props: { api: MxpageApi; onClose: () => void }) {
  const { api, onClose } = props

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null)
  const [tab, setTab] = useState<Tab>('planner')
  const [sectionId, setSectionId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [railError, setRailError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const reloadProjects = useCallback(async () => {
    try {
      const result = await api.listProjects()
      setProjects(result.projects)
      return result.projects
    } catch (cause) {
      setRailError(cause instanceof Error ? cause.message : String(cause))
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
    void (async () => {
      const list = await reloadProjects()
      if (list.length > 0) setProjectId((current) => current ?? list[0]!.id)
    })()
  }, [reloadProjects])

  useEffect(() => {
    if (projectId) void reloadDetail(projectId)
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

  const createProject = () =>
    run('create', async () => {
      const files = newFiles
      if (files.length === 0) throw new Error('至少选择一张商品图')
      const first = files[0]!
      // Create the project through the tool-facing surface is not available in
      // the browser, so the panel uploads into a project created via /upload's
      // sibling: we create by uploading to a fresh project through the API.
      const created = await api.createProjectWithUpload(
        newName.trim() || first.name.replace(/\.[^.]+$/, ''),
        files,
      )
      setCreating(false)
      setNewName('')
      setNewFiles([])
      await reloadProjects()
      setProjectId(created.projectId)
    })

  const tabsDisabled = !detail && tab !== 'channels'

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <strong style={{ fontSize: 14 }}>MxPage</strong>
        <span style={{ color: T.muted, fontSize: 12 }}>
          电商图文工作台 · analyze → plan → VPA → generate
        </span>
        <div style={{ marginLeft: 'auto', ...styles.row }}>
          <Button variant="ghost" onClick={onClose} title="关闭面板">
            关闭
          </Button>
        </div>
      </div>

      <div style={styles.body}>
        <div style={styles.rail}>
          <div style={{ ...styles.row, justifyContent: 'space-between', padding: '0 4px' }}>
            <span style={{ color: T.muted, fontSize: 12 }}>项目 ({projects.length})</span>
            <Button variant="ghost" onClick={() => setCreating((value) => !value)}>
              {creating ? '取消' : '+ 新建'}
            </Button>
          </div>

          {creating ? (
            <div style={{ ...styles.card, padding: 8 }}>
              <Field label="项目名">
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  style={styles.input}
                  placeholder="例如：保温杯详情页"
                />
              </Field>
              <Field label="商品图" hint={newFiles.length ? `已选 ${newFiles.length} 张` : '第一张自动成为主图'}>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => setNewFiles(Array.from(event.target.files ?? []))}
                  style={{ ...styles.input, padding: 4 }}
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy !== null || newFiles.length === 0}
                onClick={createProject}
                style={{ width: '100%' }}
              >
                {busy === 'create' ? '创建中…' : '创建项目'}
              </Button>
            </div>
          ) : null}

          {railError ? <Notice kind="error">{railError}</Notice> : null}

          <div style={{ display: 'grid', gap: 4 }}>
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
                  border: `1px solid ${project.id === projectId ? T.accent : 'transparent'}`,
                  borderRadius: 6,
                  padding: 6,
                  color: T.text,
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    flex: '0 0 auto',
                    borderRadius: 4,
                    border: `1px solid ${T.border}`,
                    background: T.bg,
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
                <span style={{ minWidth: 0, flex: '1 1 auto' }}>
                  <span
                    style={{
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {project.name}
                  </span>
                  <Badge>{project.status}</Badge>
                </span>
              </button>
            ))}
            {projects.length === 0 && !creating ? (
              <div style={{ color: T.muted, fontSize: 12, padding: 8 }}>
                还没有项目。点「+ 新建」上传商品图开始。
              </div>
            ) : null}
          </div>
        </div>

        <div style={styles.main}>
          <div style={{ ...styles.row, marginBottom: 14 }}>
            {TABS.map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                active={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </Button>
            ))}
            {detail ? (
              <span style={{ marginLeft: 'auto', ...styles.row, gap: 6 }}>
                <Badge>{detail.project.status}</Badge>
                <span style={{ color: T.muted, fontSize: 12 }}>
                  {detail.project.name} · {detail.assets.length} 张图 ·{' '}
                  {detail.sections.length} 个分区
                </span>
              </span>
            ) : null}
          </div>

          {error ? <Notice kind="error">{error}</Notice> : null}

          {tab === 'channels' ? <ChannelsView api={api} /> : null}

          {tab !== 'channels' && tabsDisabled ? (
            <div style={{ color: T.muted }}>先创建或选择一个项目。</div>
          ) : null}

          {detail && tab === 'planner' ? (
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
          ) : null}

          {detail && tab === 'editor' ? (
            <EditorView
              api={api}
              detail={detail}
              busy={busy}
              run={run}
              reload={() => reloadDetail()}
              selectedSectionId={sectionId}
              onSelectSection={setSectionId}
            />
          ) : null}

          {tab === 'xiaohongshu' ? <XiaohongshuView api={api} busy={busy} run={run} /> : null}
        </div>
      </div>
    </div>
  )
}
