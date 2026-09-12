/**
 * Panel view mounting.
 *
 * The `conversation` slot is single-occupant and external plugins cannot declare
 * slots, so the panel takes over the centre column at the DOM level: a container
 * is appended inside the conversation grid item (an extra trailing child React
 * never manages), and a stylesheet rule hides the conversation content while the
 * panel is active. Toggling is a data attribute on `<html>`, so the conversation
 * subtree underneath stays mounted and stateful.
 *
 * Same approach as `@dickpy/dsh-imagegen`'s `mount.tsx`; the dual selector covers
 * both the legacy shell (`[data-pane="conversation"]`) and the rc.6+ AppFrame
 * layout (`[class*="centerCol"]`).
 */

import { createRoot, type Root } from 'react-dom/client'

import { MxpageApi } from './api.ts'
import { MxpagePanel } from './panel.tsx'

export const PANEL_SELECTOR = '[data-dsh-mxpage-view]'
export const TOGGLE_SELECTOR = '[data-dsh-mxpage-toggle]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-mxpage-active'
const PANEL_NAME = 'mxpage'
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-imagegen-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']

const STYLE_ID = 'dsh-mxpage-panel-style'

const STYLESHEET = `
${PANEL_SELECTOR} {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 5;
  background: #0f1115;
}
html[${ACTIVE_ATTR}] ${PANEL_SELECTOR} { display: block; }
html[${ACTIVE_ATTR}] ${CONVERSATION_COLUMN_SELECTOR} > *:not(${PANEL_SELECTOR}) { display: none !important; }
${CONVERSATION_COLUMN_SELECTOR} { position: relative; }
`

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

function ensureStylesheet(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLESHEET
  document.head.append(style)
  return () => style.remove()
}

export interface PanelHandle {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
  dispose(): void
}

/**
 * Mounts the panel container into the centre column and returns a handle. The
 * container stays in the DOM (hidden) once mounted, so panel state survives
 * opening and closing.
 */
export function mountPanel(): PanelHandle {
  const api = new MxpageApi()
  const removeStyles = ensureStylesheet()
  let host: HTMLDivElement | undefined
  let root: Root | undefined
  let open = false

  const sync = (): void => {
    const html = document.documentElement
    if (open) {
      // Exclusive activation: another panel's attribute would fight ours.
      for (const attr of OTHER_ACTIVE_ATTRS) html.removeAttribute(attr)
      html.setAttribute(ACTIVE_ATTR, '')
      window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      html.removeAttribute(ACTIVE_ATTR)
    }
    const toggle = document.querySelector<HTMLElement>(TOGGLE_SELECTOR)
    if (toggle !== null) {
      if (open) toggle.dataset.active = ''
      else delete toggle.dataset.active
    }
  }

  const ensure = (): void => {
    if (host !== undefined && !host.isConnected) {
      host = undefined
      root = undefined
    }
    if (host !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    host = document.createElement('div')
    host.dataset.dshMxpageView = ''
    column.append(host)
    root = createRoot(host)
    root.render(<MxpagePanel api={api} onClose={() => handle.close()} />)
  }

  const handle: PanelHandle = {
    open() {
      open = true
      ensure()
      sync()
      root?.render(<MxpagePanel api={api} onClose={() => handle.close()} />)
    },
    close() {
      open = false
      sync()
    },
    toggle() {
      if (open) handle.close()
      else handle.open()
    },
    isOpen: () => open,
    dispose() {
      open = false
      sync()
      root?.unmount()
      host?.remove()
      removeStyles()
    },
  }

  // Self-heal after React rebuilds the shell.
  const observer = new MutationObserver(() => {
    if (open) ensure()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // Another panel activating closes this one.
  const onActivate = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail
    if (detail !== PANEL_NAME && open) handle.close()
  }
  window.addEventListener(ACTIVATE_EVENT, onActivate)

  const originalDispose = handle.dispose
  handle.dispose = () => {
    observer.disconnect()
    window.removeEventListener(ACTIVATE_EVENT, onActivate)
    originalDispose()
  }

  return handle
}

/**
 * Adds a sidebar button that toggles the panel. Placed in the sidebar header
 * row rather than replacing the shell's New Session affordance, so it never
 * hides host UI.
 */
export function mountSidebarToggle(onToggle: () => void, label: string, tooltip: string): () => void {
  let button: HTMLButtonElement | undefined

  const ensure = (): void => {
    if (button !== undefined && button.isConnected) return
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return
    const target =
      column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement ??
      (column.firstElementChild as HTMLElement | undefined)
    if (target === undefined) return

    button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshMxpageToggle = ''
    button.setAttribute('aria-label', label)
    button.title = tooltip
    button.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;font:inherit"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.5h12M5.5 9.5h5"/></svg>${label}</span>`
    button.style.cssText =
      'display:flex;align-items:center;width:100%;margin-top:6px;padding:5px 8px;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px;cursor:pointer;font:inherit;opacity:0.85'
    button.addEventListener('click', onToggle)
    target.append(button)
  }

  const observer = new MutationObserver(ensure)
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()

  return () => {
    observer.disconnect()
    button?.remove()
  }
}
