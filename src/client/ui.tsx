/**
 * Design tokens and shared primitives for the MxPage panel.
 *
 * Inline styles rather than a CSS pipeline: the browser bundle stays
 * dependency-free apart from React, and nothing here can collide with the DSH
 * shell's stylesheets.
 */

import type { CSSProperties, ReactNode } from 'react'

export const T = {
  bg: '#0f1115',
  panel: '#161a21',
  raised: '#1d222b',
  border: '#2a3040',
  text: '#e6e9ef',
  muted: '#9aa4b8',
  accent: '#5b8def',
  accentSoft: 'rgba(91,141,239,0.14)',
  ok: '#3fb950',
  warn: '#d29922',
  danger: '#f85149',
  radius: 8,
} as const

export const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: T.bg,
    color: T.text,
    font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  } satisfies CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    borderBottom: `1px solid ${T.border}`,
    background: T.panel,
    flex: '0 0 auto',
  } satisfies CSSProperties,

  body: { display: 'flex', flex: '1 1 auto', minHeight: 0 } satisfies CSSProperties,

  rail: {
    width: 240,
    flex: '0 0 auto',
    borderRight: `1px solid ${T.border}`,
    background: T.panel,
    overflowY: 'auto',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } satisfies CSSProperties,

  main: { flex: '1 1 auto', minWidth: 0, overflowY: 'auto', padding: 16 } satisfies CSSProperties,

  card: {
    background: T.raised,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    padding: 12,
  } satisfies CSSProperties,

  row: { display: 'flex', alignItems: 'center', gap: 8 } satisfies CSSProperties,

  tabs: { display: 'flex', gap: 4 } satisfies CSSProperties,

  input: {
    width: '100%',
    boxSizing: 'border-box',
    background: T.bg,
    color: T.text,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '6px 8px',
    font: 'inherit',
    outline: 'none',
  } satisfies CSSProperties,

  mono: {
    font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  } satisfies CSSProperties,
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  active?: boolean
  style?: CSSProperties
}) {
  const { variant = 'default', disabled, active } = props
  const background =
    variant === 'primary'
      ? T.accent
      : variant === 'danger'
        ? 'rgba(248,81,73,0.14)'
        : variant === 'ghost'
          ? 'transparent'
          : active
            ? T.accentSoft
            : T.raised
  const color =
    variant === 'primary' ? '#fff' : variant === 'danger' ? T.danger : active ? T.accent : T.text
  return (
    <button
      type="button"
      title={props.title}
      disabled={disabled}
      onClick={props.onClick}
      style={{
        background,
        color,
        border: `1px solid ${active ? T.accent : T.border}`,
        borderRadius: 6,
        padding: '5px 10px',
        font: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
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
    <label style={{ display: 'block', marginBottom: 10, ...props.style }}>
      <span style={{ display: 'block', color: T.muted, marginBottom: 4, fontSize: 12 }}>
        {props.label}
      </span>
      {props.children}
      {props.hint ? (
        <span style={{ display: 'block', color: T.muted, fontSize: 11, marginTop: 4 }}>
          {props.hint}
        </span>
      ) : null}
    </label>
  )
}

export function Badge(props: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const tone = props.tone ?? 'muted'
  const color =
    tone === 'ok' ? T.ok : tone === 'warn' ? T.warn : tone === 'danger' ? T.danger : T.muted
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        color,
        border: `1px solid ${color}44`,
        background: `${color}14`,
        whiteSpace: 'nowrap',
      }}
    >
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

export function Notice(props: { kind: 'info' | 'error' | 'success'; children: ReactNode }) {
  const color = props.kind === 'error' ? T.danger : props.kind === 'success' ? T.ok : T.accent
  return (
    <div
      style={{
        border: `1px solid ${color}55`,
        background: `${color}12`,
        color,
        borderRadius: 6,
        padding: '8px 10px',
        marginBottom: 12,
        fontSize: 12,
      }}
    >
      {props.children}
    </div>
  )
}

export function Spinner() {
  return <span style={{ color: T.muted }}>…</span>
}
