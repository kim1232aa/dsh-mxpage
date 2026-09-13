/**
 * The `mxpage` settings card: registered into the real `settings.plugin.item`
 * slot (设置 → 插件 → MxPage), the same mechanism `@dickpy/dsh-imagegen` uses
 * for its own card.
 *
 * BACKGROUND: an earlier version of this plugin mounted its panel and sidebar
 * toggle with hand-rolled DOM queries (`document.querySelector` +
 * `MutationObserver`) and registered no settings card at all. The host
 * `ctx.settings.installSection` call in `src/index.ts` makes the `mxpage`
 * namespace exist, but nothing rendered a form for it: 设置 → 插件 → MxPage
 * had no card because no plugin ever contributed one to
 * `settings.plugin.item`. That slot is keyed by settings namespace and
 * dispatched by `@deepseek-ai/dsh-client-ui-settings-plugins`'s configurable
 * tab; a plugin distributed outside the host repo earns its card by
 * registering here, in its OWN client bundle — the tab never learns what a
 * namespace means, it only pairs a served namespace with whichever card
 * claimed that key.
 *
 * The channel list is staged as one JSON blob (`set` on the `channels` path)
 * rather than field-by-field, because upstream MxPage's channel shape is
 * itself a list of objects — there is no single scalar path per channel field
 * the generic `CardForm` text/number controls model.
 */

import { useState, useSyncExternalStore } from 'react'

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

import type { ChannelConfig, Config as MxpageConfig } from '../config.ts'

const CARD_STYLE = {
  display: 'grid',
  gap: 10,
} as const

const ROW_STYLE = {
  border: '1px solid var(--dsw-alias-border-l4, #33343a)',
  borderRadius: 8,
  padding: 10,
  display: 'grid',
  gap: 8,
} as const

const LABEL_STYLE = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #9a9ba3)',
  display: 'block',
  marginBottom: 4,
} as const

const INPUT_STYLE = {
  width: '100%',
  boxSizing: 'border-box' as const,
  border: '1px solid var(--dsw-alias-border-l4, #33343a)',
  background: 'var(--dsw-alias-bg-layer-3, #1c1d21)',
  color: 'var(--dsw-alias-label-primary, #f3f4f6)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 13,
  lineHeight: 1.5,
  font: 'inherit',
}

const BUTTON_STYLE = {
  border: '1px solid var(--dsw-alias-border-l4, #33343a)',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 8,
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
}

const PRIMARY_BUTTON_STYLE = {
  ...BUTTON_STYLE,
  background: 'var(--dsw-alias-brand-primary, #ff5b30)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 600,
}

let channelSeq = 0
function freshChannelId(): string {
  channelSeq += 1
  return `channel-${Date.now().toString(36)}-${channelSeq}`
}

function emptyChannel(): ChannelConfig {
  return { id: freshChannelId(), label: '', baseUrl: '', apiKey: '', models: [] }
}

/** Comma/newline separated model list <-> array. */
function modelsToText(models: string[] | undefined): string {
  return (models ?? []).join(', ')
}
function textToModels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

interface ChannelRowProps {
  channel: ChannelConfig
  disabled: boolean
  onChange: (next: ChannelConfig) => void
  onRemove: () => void
}

function ChannelRow(props: ChannelRowProps) {
  const { channel, disabled, onChange, onRemove } = props
  const [showKey, setShowKey] = useState(false)

  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>{channel.label?.trim() || channel.id}</strong>
        <button type="button" style={BUTTON_STYLE} disabled={disabled} onClick={onRemove}>
          删除
        </button>
      </div>

      <div>
        <label style={LABEL_STYLE}>渠道标识（id）</label>
        <input
          style={INPUT_STYLE}
          value={channel.id}
          disabled={disabled}
          onChange={(event) => onChange({ ...channel, id: event.target.value })}
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>显示名（可选）</label>
        <input
          style={INPUT_STYLE}
          value={channel.label ?? ''}
          disabled={disabled}
          placeholder="例如：xAI（Grok）"
          onChange={(event) => onChange({ ...channel, label: event.target.value })}
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>Base URL（OpenAI 兼容）</label>
        <input
          style={INPUT_STYLE}
          value={channel.baseUrl}
          disabled={disabled}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onChange({ ...channel, baseUrl: event.target.value })}
        />
      </div>

      <div>
        <label style={LABEL_STYLE}>API Key</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ ...INPUT_STYLE, flex: 1 }}
            type={showKey ? 'text' : 'password'}
            value={channel.apiKey ?? ''}
            disabled={disabled}
            placeholder="sk-..."
            onChange={(event) => onChange({ ...channel, apiKey: event.target.value })}
          />
          <button type="button" style={BUTTON_STYLE} disabled={disabled} onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      <div>
        <label style={LABEL_STYLE}>图像模型（逗号分隔；留空则用 GET /models 自动发现）</label>
        <input
          style={INPUT_STYLE}
          value={modelsToText(channel.models)}
          disabled={disabled}
          placeholder="grok-imagine-image-2.0, gpt-image-2"
          onChange={(event) => onChange({ ...channel, models: textToModels(event.target.value) })}
        />
      </div>

      <label style={{ ...LABEL_STYLE, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={channel.disabled === true}
          disabled={disabled}
          onChange={(event) => onChange({ ...channel, disabled: event.target.checked })}
        />
        禁用此渠道
      </label>
    </div>
  )
}

export interface MxpageSettingsCardProps {
  scope: SettingsScope<MxpageConfig>
}

/**
 * Self-contained channel editor. Stages edits locally (React state) and
 * writes the whole `channels` array in one `mutate([{ op: 'set', path:
 * ['channels'], value }])` call on Save — mirroring the staged-then-committed
 * discipline every other settings card in the host uses, without pulling in
 * the generic per-scalar-field `CardForm` (channels are a list of objects,
 * not a flat field set).
 */
export function MxpageSettingsCard(props: MxpageSettingsCardProps) {
  const { scope } = props
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const [draft, setDraft] = useState<ChannelConfig[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stored = (snapshot.value?.channels ?? []) as ChannelConfig[]
  if (snapshot.status === 'unavailable') return null

  const channels = draft ?? stored
  const dirty = draft !== null
  const disabled = snapshot.writable === false || saving

  const setChannels = (next: ChannelConfig[]) => {
    setDraft(next)
    setError(null)
  }

  const handleSave = async () => {
    if (draft === null) return
    setSaving(true)
    setError(null)
    try {
      await scope.mutate([{ op: 'set', path: ['channels'], value: draft as never }], snapshot.revision)
      setDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={CARD_STYLE}>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b6c74)' }}>
        渠道用于连接 OpenAI 兼容的图像/文本模型网关。配置至少一个渠道后，
        <code>mxpage_*</code> 工具才能分析商品、规划页面并生成图片。
      </p>

      {channels.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, #9a9ba3)' }}>
          还没有配置任何渠道。
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {channels.map((channel, index) => (
            <ChannelRow
              key={channel.id || index}
              channel={channel}
              disabled={disabled}
              onChange={(next) => {
                const nextList = channels.slice()
                nextList[index] = next
                setChannels(nextList)
              }}
              onRemove={() => {
                const nextList = channels.slice()
                nextList.splice(index, 1)
                setChannels(nextList)
              }}
            />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          style={BUTTON_STYLE}
          disabled={disabled}
          onClick={() => setChannels([...channels, emptyChannel()])}
        >
          + 添加渠道
        </button>
        {dirty ? (
          <>
            <button type="button" style={PRIMARY_BUTTON_STYLE} disabled={disabled} onClick={handleSave}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" style={BUTTON_STYLE} disabled={saving} onClick={() => setDraft(null)}>
              放弃修改
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error, #f87171)' }}>{error}</p>
      ) : null}
      {snapshot.writable === false ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b6c74)' }}>
          当前设置文档为只读，无法保存修改。
        </p>
      ) : null}
    </div>
  )
}
