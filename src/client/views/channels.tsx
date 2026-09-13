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

import type { ChannelDiagnostics, MxpageApi } from '../api.ts'
import { Badge, Button, Notice, SectionHeading, styles, T } from '../ui.tsx'

export function ChannelsView(props: { api: MxpageApi }) {
  const { api } = props
  const [data, setData] = useState<ChannelDiagnostics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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
              {data.channels.map((channel) => (
                <div
                  key={channel.id}
                  style={{
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: 10,
                    opacity: channel.disabled ? 0.5 : 1,
                  }}
                >
                  <div style={{ ...styles.row, marginBottom: 4 }}>
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
                  </div>
                  <div style={{ ...styles.mono, color: T.muted }}>{channel.baseUrl}</div>
                </div>
              ))}
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
