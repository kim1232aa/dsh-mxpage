/**
 * Monitor screen — API usage stats + task history.
 *
 * Combines upstream `/monitor/usage` (489-line page: summary cards, filters,
 * entry table, clear / per-entry delete) with `/history` (task list + retry).
 * Data comes from the workspace usage ledger and the task repository.
 */

import { useCallback, useEffect, useState } from 'react'

import type { MxpageApi, TaskView, UsageSummary } from '../api.ts'
import { Badge, Button, Notice, SectionHeading, styles, T } from '../ui.tsx'

const HOUR_OPTIONS = [1, 6, 24, 72, 168] as const

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function quotaLabel(state: string): [string, 'ok' | 'warn' | 'danger' | 'muted'] {
  switch (state) {
    case 'rate_limited':
      return ['限流', 'warn']
    case 'spending_limited':
      return ['额度上限', 'danger']
    case 'auth_error':
      return ['鉴权失败', 'danger']
    case 'other_error':
      return ['其他错误', 'warn']
    default:
      return ['正常', 'ok']
  }
}

export function MonitorView(props: { api: MxpageApi }) {
  const { api } = props

  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [hours, setHours] = useState<number>(24)
  const [successFilter, setSuccessFilter] = useState<'all' | 'success' | 'failed'>('all')
  const [page, setPage] = useState(1)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [usageResult, taskResult] = await Promise.all([
        api.usage({ hours, page, limit: 30, success: successFilter }),
        api.listTasks(undefined, 40),
      ])
      setSummary(usageResult.summary)
      setTasks(taskResult.tasks)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [api, hours, page, successFilter])

  useEffect(() => {
    void load()
  }, [load])

  const doClear = async () => {
    await api.usageClear()
    setConfirmClear(false)
    setNotice('用量记录已清空')
    await load()
  }

  const doDeleteEntry = async (id: string) => {
    await api.usageDelete(id)
    await load()
  }

  const doRetry = async (task: TaskView) => {
    setBusyTask(task.id)
    setError(null)
    try {
      const result = await api.retryTask(task.id)
      setNotice(
        result.jobId
          ? `已重新派发为后台任务 ${result.jobId}`
          : `已重试 ${task.taskType}，完成`,
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyTask(null)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, display: 'grid', gap: 16 }}>
      <SectionHeading
        eyebrow="系统监控"
        title="API 用量与任务"
        description="按时间窗统计文本/图像调用、成功率与额度状态；失败任务可直接重试。"
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      {/* ----------------------------------------------------- controls -- */}
      <div style={{ ...styles.card, ...styles.row, flexWrap: 'wrap', gap: 10 }}>
        <span style={{ fontSize: 12, color: T.mutedStrong, fontWeight: 600 }}>时间窗</span>
        {HOUR_OPTIONS.map((value) => (
          <Button
            key={value}
            active={hours === value}
            onClick={() => {
              setHours(value)
              setPage(1)
            }}
            style={{ padding: '5px 12px', fontSize: 12 }}
          >
            {value < 24 ? `${value}h` : `${value / 24}d`}
          </Button>
        ))}
        <span style={{ fontSize: 12, color: T.mutedStrong, fontWeight: 600, marginLeft: 8 }}>状态</span>
        {(['all', 'success', 'failed'] as const).map((value) => (
          <Button
            key={value}
            active={successFilter === value}
            onClick={() => {
              setSuccessFilter(value)
              setPage(1)
            }}
            style={{ padding: '5px 12px', fontSize: 12 }}
          >
            {value === 'all' ? '全部' : value === 'success' ? '成功' : '失败'}
          </Button>
        ))}
        <span style={{ flex: '1 1 auto' }} />
        <Button onClick={() => void load()} disabled={loading} style={{ padding: '5px 12px', fontSize: 12 }}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
        {!confirmClear ? (
          <Button variant="danger" onClick={() => setConfirmClear(true)} style={{ padding: '5px 12px', fontSize: 12 }}>
            清空记录
          </Button>
        ) : (
          <Button variant="danger" onClick={() => void doClear()} style={{ padding: '5px 12px', fontSize: 12 }}>
            确认清空
          </Button>
        )}
      </div>

      {/* ------------------------------------------------------ summary -- */}
      {summary ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            {[
              ['总请求', summary.totalRequests, T.text],
              ['成功', summary.successRequests, T.ok],
              ['失败', summary.failedRequests, summary.failedRequests ? T.danger : T.text],
              ['文本调用', summary.chatRequests, T.text],
              ['图像调用', summary.imageRequests, T.text],
              ['限流命中', summary.rateLimitedRequests, summary.rateLimitedRequests ? T.warn : T.text],
              ['额度上限', summary.spendingLimitedRequests, summary.spendingLimitedRequests ? T.danger : T.text],
              ['平均耗时', `${summary.averageDurationMs}ms`, T.text],
            ].map(([label, value, color]) => (
              <div key={String(label)} style={styles.card}>
                <div style={{ fontSize: 11, color: T.muted }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: color as string }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={styles.card}>
              <strong>Top 模型</strong>
              <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                {summary.topModels.length === 0 ? (
                  <span style={{ color: T.muted, fontSize: 12 }}>时间窗内没有调用</span>
                ) : (
                  summary.topModels.map((item) => (
                    <div key={item.model} style={{ ...styles.row, justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.model}</span>
                      <Badge>{item.count}</Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div style={styles.card}>
              <strong>Top 项目</strong>
              <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                {summary.topProjects.length === 0 ? (
                  <span style={{ color: T.muted, fontSize: 12 }}>时间窗内没有调用</span>
                ) : (
                  summary.topProjects.map((item) => (
                    <div key={item.projectId} style={{ ...styles.row, justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.projectId === 'unassigned' ? '未归属项目' : item.projectId}
                      </span>
                      <Badge>{item.count}</Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* ------------------------------------------------ entries -- */}
          <div style={styles.card}>
            <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>调用明细（{summary.totalRequests}）</strong>
              <div style={styles.row}>
                <Button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} style={{ padding: '3px 10px', fontSize: 12 }}>
                  ← 上一页
                </Button>
                <span style={{ fontSize: 12, color: T.muted }}>
                  {summary.page} / {summary.totalPages}
                </span>
                <Button
                  disabled={page >= summary.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                  style={{ padding: '3px 10px', fontSize: 12 }}
                >
                  下一页 →
                </Button>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {summary.recentEntries.length === 0 ? (
                <span style={{ color: T.muted, fontSize: 12 }}>没有符合筛选的记录</span>
              ) : (
                summary.recentEntries.map((entry) => {
                  const [quota, tone] = quotaLabel(entry.quotaState)
                  return (
                    <div
                      key={entry.id}
                      style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 12 }}
                    >
                      <div style={{ ...styles.row, flexWrap: 'wrap', gap: 6 }}>
                        <Badge tone={entry.ok ? 'ok' : 'danger'}>{entry.ok ? 'OK' : `FAIL ${entry.status}`}</Badge>
                        <Badge>{entry.category}</Badge>
                        {entry.quotaState !== 'ok' ? <Badge tone={tone}>{quota}</Badge> : null}
                        <span style={{ ...styles.mono, color: T.mutedStrong }}>{entry.model ?? 'unknown-model'}</span>
                        <span style={{ color: T.muted }}>{entry.endpoint}</span>
                        <span style={{ flex: '1 1 auto' }} />
                        <span style={{ color: T.muted }}>{entry.durationMs}ms</span>
                        <span style={{ color: T.muted }}>{formatTime(entry.at)}</span>
                        <Button
                          variant="ghost"
                          title="删除这条记录"
                          onClick={() => void doDeleteEntry(entry.id)}
                          style={{ padding: '1px 6px', fontSize: 11, color: T.muted }}
                        >
                          ✕
                        </Button>
                      </div>
                      {entry.errorMessage ? (
                        <div style={{ color: T.danger, marginTop: 4, lineHeight: 1.5 }}>{entry.errorMessage}</div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------- task history -- */}
      <div style={styles.card}>
        <strong>任务历史（{tasks.length}）</strong>
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {tasks.length === 0 ? (
            <span style={{ color: T.muted, fontSize: 12 }}>还没有工作流任务</span>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                style={{
                  ...styles.row,
                  flexWrap: 'wrap',
                  gap: 6,
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                }}
              >
                <Badge
                  tone={
                    task.status === 'SUCCESS'
                      ? 'ok'
                      : task.status === 'FAILED'
                        ? 'danger'
                        : task.status === 'RUNNING' || task.status === 'PENDING'
                          ? 'warn'
                          : 'muted'
                  }
                >
                  {task.status}
                </Badge>
                <Badge>{task.taskType}</Badge>
                <span style={{ ...styles.mono, color: T.mutedStrong }}>{task.id.slice(0, 8)}</span>
                <span style={{ color: T.muted }}>{formatTime(task.createdAt)}</span>
                <span style={{ flex: '1 1 auto' }} />
                {task.status === 'FAILED' || task.status === 'CANCELED' ? (
                  <Button
                    disabled={busyTask !== null}
                    onClick={() => void doRetry(task)}
                    style={{ padding: '3px 12px', fontSize: 12 }}
                  >
                    {busyTask === task.id ? '重试中…' : '重试'}
                  </Button>
                ) : null}
                {task.errorMessage ? (
                  <div style={{ width: '100%', color: T.danger, lineHeight: 1.5 }}>{task.errorMessage}</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
