/**
 * Channels screen — provider diagnostics.
 *
 * Upstream had a 30 KB `provider-settings.tsx` for CRUD over provider rows plus
 * `/models` discovery and per-role default assignment. In DSH the channel list
 * lives in the plugin Config (Schemastery), so this screen is read-only
 * *diagnostics* plus a pointer to where to edit — which is the part that
 * actually helps when generation fails.
 */

import { useEffect, useState } from 'react'

import type { ChannelDiagnostics, DiscoveredModel, MxpageApi } from '../api.ts'
import { Badge, Button, Notice, SectionHeading, styles, T } from '../ui.tsx'

interface DiscoveryState {
  loading: boolean
  testResult?: string
  testOk?: boolean
  models?: DiscoveredModel[]
  recommendations?: Record<string, string | null>
  error?: string
}

export function ChannelsView(props: { api: MxpageApi }) {
  const { api } = props
  const [data, setData] = useState<ChannelDiagnostics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [probe, setProbe] = useState<Record<string, DiscoveryState>>({})

  const load = () => {
    setLoading(true)
    setError(null)
    api
      .channels()
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [api])

  const setProbeState = (channelId: string, patch: Partial<DiscoveryState>) =>
    setProbe((current) => ({ ...current, [channelId]: { ...current[channelId], loading: false, ...patch } }))

  // Upstream `POST /api/providers/test`: real connectivity probe.
  const doTest = async (channelId: string) => {
    setProbeState(channelId, { loading: true, error: undefined, testResult: undefined })
    try {
      const result = await api.providerTest(channelId)
      const record = result.result as Record<string, unknown>
      const ok = record.ok === true || record.success === true
      setProbeState(channelId, {
        testOk: ok,
        testResult: ok
          ? `连接正常${record.latencyMs ? `（${String(record.latencyMs)}ms）` : ''}`
          : `连接失败：${String(record.message ?? record.error ?? '未知错误')}`,
      })
    } catch (cause) {
      setProbeState(channelId, {
        testOk: false,
        testResult: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  // Upstream `POST /api/providers/discover-models` + `detect-capabilities`.
  const doDiscover = async (channelId: string) => {
    setProbeState(channelId, { loading: true, error: undefined })
    try {
      const result = await api.providerDiscover(channelId)
      setProbeState(channelId, { models: result.models, recommendations: result.recommendations })
    } catch (cause) {
      setProbeState(channelId, { error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 760, display: 'grid', gap: 16 }}>
      <SectionHeading eyebrow="系统设置" title="AI 配置" description="渠道用于连接图像/文本模型服务，在设置中配置后即可在此诊断。" />
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>渠道</strong>
          <Button onClick={load} disabled={loading}>
            {loading ? '检测中…' : '重新检测'}
          </Button>
        </div>
        <div style={{ color: T.muted, fontSize: 12 }}>
          渠道在 <strong>设置 → 插件 → MxPage</strong> 里配置：baseUrl + 密钥（建议用
          <code style={styles.mono}> apiKeyEnv </code>指向环境变量）+ 模型目录。
        </div>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {data ? (
        <>
          <div style={styles.card}>
            <div style={{ ...styles.row, marginBottom: 8 }}>
              <strong>当前生效渠道</strong>
              <Badge tone="ok">{data.channel.label ?? data.channel.id ?? 'unnamed'}</Badge>
            </div>
            <div style={{ ...styles.mono, color: T.muted }}>{data.channel.baseUrl}</div>
            <div style={{ ...styles.row, marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
              <Badge tone={data.modelCount ? 'ok' : 'danger'}>共 {data.modelCount} 个模型</Badge>
              <Badge tone={data.imageModels.length ? 'ok' : 'warn'}>
                图像 {data.imageModels.length}
              </Badge>
              <Badge tone={data.visionModels.length ? 'ok' : 'warn'}>
                视觉 {data.visionModels.length}
              </Badge>
              <Badge tone={data.textModels.length ? 'ok' : 'warn'}>文本 {data.textModels.length}</Badge>
            </div>

            {data.imageModels.length === 0 ? (
              <Notice kind="error">
                没有识别出任何图像模型。模型能力是<strong>按名字推断</strong>的 —— 上游为避免消耗图像额度
                跳过了真实端点探测，所以「名字像图像模型」不等于网关真支持生图。请在渠道里显式列出
                <code style={styles.mono}> models </code>。
              </Notice>
            ) : (
              <div style={{ marginTop: 10, ...styles.mono, color: T.muted }}>
                图像模型：{data.imageModels.join(', ')}
              </div>
            )}
          </div>

          <div style={styles.card}>
            <strong>已配置渠道（{data.channels.length}）</strong>
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {data.channels.map((channel) => {
                const state = probe[channel.id]
                return (
                  <div
                    key={channel.id}
                    style={{
                      border: `1px solid ${T.border}`,
                      borderRadius: 6,
                      padding: 10,
                      opacity: channel.disabled ? 0.5 : 1,
                    }}
                  >
                    <div style={{ ...styles.row, marginBottom: 4, flexWrap: 'wrap' }}>
                      <strong>{channel.label}</strong>
                      <Badge>{channel.id}</Badge>
                      {channel.disabled ? <Badge tone="warn">已禁用</Badge> : null}
                      <Badge tone={channel.hasKey ? 'ok' : 'danger'}>
                        {channel.hasKey ? '密钥已配置' : '缺少密钥'}
                      </Badge>
                      {channel.models.length > 0 ? (
                        <Badge tone="ok">{channel.models.length} 个显式模型</Badge>
                      ) : (
                        <Badge tone="warn">靠 GET /models 发现</Badge>
                      )}
                      <span style={{ flex: '1 1 auto' }} />
                      <Button
                        disabled={!channel.hasKey || state?.loading}
                        onClick={() => void doTest(channel.id)}
                        style={{ padding: '3px 12px', fontSize: 12 }}
                      >
                        测试连接
                      </Button>
                      <Button
                        disabled={!channel.hasKey || state?.loading}
                        onClick={() => void doDiscover(channel.id)}
                        style={{ padding: '3px 12px', fontSize: 12 }}
                      >
                        {state?.loading ? '探测中…' : '发现模型'}
                      </Button>
                    </div>
                    <div style={{ ...styles.mono, color: T.muted }}>{channel.baseUrl}</div>

                    {state?.testResult ? (
                      <div style={{ marginTop: 8 }}>
                        <Badge tone={state.testOk ? 'ok' : 'danger'}>{state.testResult}</Badge>
                      </div>
                    ) : null}
                    {state?.error ? (
                      <div style={{ marginTop: 8 }}>
                        <Notice kind="error">{state.error}</Notice>
                      </div>
                    ) : null}
                    {state?.models ? (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 12, color: T.mutedStrong, marginBottom: 6 }}>
                          发现 {state.models.length} 个模型：
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {state.models.slice(0, 40).map((model) => (
                            <Badge
                              key={model.modelId}
                              tone={model.capabilities.image_gen || model.capabilities.image_edit ? 'accent' : 'muted'}
                            >
                              {model.modelId}
                            </Badge>
                          ))}
                          {state.models.length > 40 ? <Badge>…共 {state.models.length} 个</Badge> : null}
                        </div>
                        {state.recommendations ? (
                          <div style={{ ...styles.mono, color: T.muted, marginTop: 8, fontSize: 11 }}>
                            推荐：分析 {state.recommendations.analysisModelId ?? '—'} · 规划{' '}
                            {state.recommendations.planningModelId ?? '—'} · 头图{' '}
                            {state.recommendations.heroImageModelId ?? '—'} · 详情{' '}
                            {state.recommendations.detailImageModelId ?? '—'} · 编辑{' '}
                            {state.recommendations.imageEditModelId ?? '—'}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {data.channels.length === 0 ? (
                <Notice kind="error">
                  还没有配置任何渠道。所有 mxpage_* 工具都会返回 MXPAGE_HTTP_401 直到配置完成。
                </Notice>
              ) : null}
            </div>
          </div>

          <div style={styles.card}>
            <strong>配额行为</strong>
            <div style={{ color: T.muted, fontSize: 12, marginTop: 6 }}>
              上游对 <code style={styles.mono}>429 / 额度 / 403 / 401</code> <strong>不轮换模型</strong>，
              所以一个渠道额度用尽会直接失败而不是试下一个。本插件把这条做成了配置项
              <code style={styles.mono}> rotateChannelOnQuotaExhausted </code>，默认开启。
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
