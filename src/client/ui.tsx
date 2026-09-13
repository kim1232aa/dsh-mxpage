/**
 * Design tokens and primitives for the MxPage panel.
 *
 * Rebuilt to match the actual upstream MxPage product (ziguishian/MxPage):
 * light theme, white cards with soft shadows, rounded-xl corners, a dark pill
 * CTA, and a phone-frame preview — not a generic dark dev-tool panel.
 */

import type { CSSProperties, ReactNode } from 'react'

export const T = {
  bg: '#f7f7f8',
  card: '#ffffff',
  cardMuted: '#fafafb',
  border: '#e7e8ec',
  borderStrong: '#d9dbe0',
  text: '#171719',
  muted: '#8b8d97',
  mutedStrong: '#5b5d68',
  accent: '#ff5b30',
  accentSoft: '#fff1ec',
  dark: '#17181c',
  ok: '#16a34a',
  okSoft: '#eafbf0',
  warn: '#d97706',
  warnSoft: '#fef6e7',
  danger: '#e0392f',
  dangerSoft: '#fdedec',
  radius: 14,
  radiusSm: 10,
  shadow: '0 1px 2px rgba(23,24,28,0.04), 0 8px 24px rgba(23,24,28,0.05)',
  shadowSm: '0 1px 2px rgba(23,24,28,0.05)',
} as const

const fontStack =
  'ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

export const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: T.bg,
    backgroundImage:
      'linear-gradient(90deg, rgba(0,0,0,0.025) 1px, transparent 1px), linear-gradient(rgba(0,0,0,0.025) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
    color: T.text,
    font: `13px/1.55 ${fontStack}`,
  } satisfies CSSProperties,

  body: { display: 'flex', flex: '1 1 auto', minHeight: 0, gap: 16, padding: 16 } satisfies CSSProperties,

  rail: {
    width: 208,
    flex: '0 0 auto',
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    boxShadow: T.shadow,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } satisfies CSSProperties,

  main: {
    flex: '1 1 auto',
    minWidth: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  } satisfies CSSProperties,

  card: {
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    boxShadow: T.shadowSm,
    padding: 18,
  } satisfies CSSProperties,

  row: { display: 'flex', alignItems: 'center', gap: 8 } satisfies CSSProperties,

  input: {
    width: '100%',
    boxSizing: 'border-box',
    background: T.cardMuted,
    color: T.text,
    border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm,
    padding: '8px 10px',
    font: `13px ${fontStack}`,
    outline: 'none',
  } satisfies CSSProperties,

  mono: {
    font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
    color: T.mutedStrong,
  } satisfies CSSProperties,
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'dark' | 'ghost' | 'danger' | 'nav'
  disabled?: boolean
  title?: string
  active?: boolean
  full?: boolean
  style?: CSSProperties
}) {
  const { variant = 'default', disabled, active, full } = props

  if (variant === 'nav') {
    return (
      <button
        type="button"
        title={props.title}
        disabled={disabled}
        onClick={props.onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          textAlign: 'left',
          background: active ? T.accentSoft : 'transparent',
          color: active ? T.accent : T.mutedStrong,
          border: 'none',
          borderRadius: T.radiusSm,
          padding: '9px 10px',
          font: `13px ${fontStack}`,
          fontWeight: active ? 600 : 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          ...props.style,
        }}
      >
        {props.children}
      </button>
    )
  }

  const background =
    variant === 'dark' ? T.dark : variant === 'danger' ? T.dangerSoft : variant === 'ghost' ? 'transparent' : T.card
  const color = variant === 'dark' ? '#fff' : variant === 'danger' ? T.danger : T.text
  const border =
    variant === 'dark' ? T.dark : variant === 'danger' ? '#f3c9c6' : variant === 'ghost' ? 'transparent' : T.border

  return (
    <button
      type="button"
      title={props.title}
      disabled={disabled}
      onClick={props.onClick}
      style={{
        background,
        color,
        border: `1px solid ${border}`,
        borderRadius: 999,
        padding: '8px 16px',
        font: `13px ${fontStack}`,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        width: full ? '100%' : undefined,
        transition: 'opacity .15s, background .15s',
        ...props.style,
      }}
    >
      {props.children}
    </button>
  )
}

export function Field(props: {
  label: string
  children: ReactNode
  hint?: string
  style?: CSSProperties
}) {
  return (
    <label style={{ display: 'block', marginBottom: 14, ...props.style }}>
      <span style={{ display: 'block', color: T.mutedStrong, marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
        {props.label}
      </span>
      {props.children}
      {props.hint ? (
        <span style={{ display: 'block', color: T.muted, fontSize: 11, marginTop: 5, lineHeight: 1.5 }}>
          {props.hint}
        </span>
      ) : null}
    </label>
  )
}

export function Badge(props: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'accent' }) {
  const tone = props.tone ?? 'muted'
  const map = {
    ok: { color: T.ok, bg: T.okSoft },
    warn: { color: T.warn, bg: T.warnSoft },
    danger: { color: T.danger, bg: T.dangerSoft },
    accent: { color: T.accent, bg: T.accentSoft },
    muted: { color: T.mutedStrong, bg: T.cardMuted },
  }[tone]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color: map.color,
        background: map.bg,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: map.color, flex: '0 0 auto' }} />
      {props.children}
    </span>
  )
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'SUCCESS') return 'ok'
  if (status === 'GENERATING') return 'warn'
  if (status === 'FAILED') return 'danger'
  return 'muted'
}

export function statusLabel(status: string): string {
  return (
    ({ SUCCESS: '已完成', GENERATING: '生成中', FAILED: '失败', IDLE: '未开始' } as Record<string, string>)[
      status
    ] ?? status
  )
}

export function Notice(props: { kind: 'info' | 'error' | 'success'; children: ReactNode }) {
  const map = {
    info: { color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
    error: { color: T.danger, bg: T.dangerSoft, border: '#f3c9c6' },
    success: { color: T.ok, bg: T.okSoft, border: '#bbe8cb' },
  }[props.kind]
  return (
    <div
      style={{
        border: `1px solid ${map.border}`,
        background: map.bg,
        color: map.color,
        borderRadius: T.radiusSm,
        padding: '10px 12px',
        marginBottom: 14,
        fontSize: 12.5,
        lineHeight: 1.6,
      }}
    >
      {props.children}
    </div>
  )
}

export function SectionHeading(props: { eyebrow?: string; title: ReactNode; description?: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {props.eyebrow ? (
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 4, fontWeight: 600 }}>{props.eyebrow}</div>
      ) : null}
      <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em' }}>{props.title}</div>
      {props.description ? (
        <div style={{ color: T.muted, fontSize: 13, marginTop: 6 }}>{props.description}</div>
      ) : null}
    </div>
  )
}

/** A configuration chip like upstream's "内容语言：简体中文" strip. */
export function ConfigChip(props: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'accent' }) {
  const tone = props.tone ?? 'ok'
  const dot = { ok: T.ok, warn: T.warn, accent: T.accent }[tone]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: T.mutedStrong }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: dot }} />
      {props.label}：<strong style={{ color: T.text, fontWeight: 600 }}>{props.value}</strong>
    </span>
  )
}
