/**
 * Panel view mounting.
 *
 * The `conversation` slot is single-occupant and external plugins cannot declare
 * slots, so the panel takes over the centre column at the DOM level: a container
 * is appended inside the conversation grid item (an extra trailing child React
 * never manages). Toggling is the container's own `display`, driven by a data
 * attribute on `<html>` so cross-panel exclusivity and the sidebar toggle stay
 * in sync — but nothing else in the DOM is touched.
 *
 * INCIDENT (fixed here): an earlier version additionally forced every sibling
 * in the centre column to `display:none!important` while the panel was active,
 * on the theory that the panel's own `position:absolute` cover was not enough.
 * That rule fires from the CSS alone, independent of whether the panel's host
 * element actually mounted. When `conversationColumn()` failed to resolve
 * (selector mismatch against a shell version, or called before the frame
 * finished rendering), `ensure()` bailed out with no host created, but `sync()`
 * ran anyway and still set the active attribute — blanking the entire
 * conversation column with nothing to show in its place. Reported in production
 * as "the whole main area goes black, only the sidebar still works". Fixed by
 * removing the sibling-hiding rule entirely: the panel's own opaque, absolutely
 * positioned, z-indexed host is sufficient to cover the conversation when it is
 * actually mounted, and a mount failure now degrades to "the panel doesn't
 * appear" rather than "the app goes black".
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

/**
 * Only the panel's OWN visibility is CSS-driven. There is deliberately no rule
 * that reaches outside `PANEL_SELECTOR` — see the incident note above.
 */
const STYLESHEET = `
${PANEL_SELECTOR} {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 5;
  background: #0f1115;
}
html[${ACTIVE_ATTR}] ${PANEL_SELECTOR} { display: block; }
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

  /**
   * Reflects `open` onto the DOM. Guarded: the active attribute is only ever
   * set when a real host element exists, so a failed mount cannot blank
   * anything — worst case the toggle silently does nothing.
   */
  const sync = (): void => {
    const html = document.documentElement
    const canShow = open && host !== undefined
    if (canShow) {
      // Exclusive activation: another panel's attribute would fight ours.
      for (const attr of OTHER_ACTIVE_ATTRS) html.removeAttribute(attr)
      html.setAttribute(ACTIVE_ATTR, '')
      window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      html.removeAttribute(ACTIVE_ATTR)
    }
    const toggle = document.querySelector<HTMLElement>(TOGGLE_SELECTOR)
    if (toggle !== null) {
      if (canShow) toggle.dataset.active = ''
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
  }

  /** Renders (or re-renders) the panel tree. Never lets a render error escape. */
  const render = (): void => {
    if (root === undefined) return
    try {
      root.render(<MxpagePanel api={api} onClose={() => handle.close()} />)
    } catch (error) {
      console.warn('[dsh-mxpage] panel render failed, closing:', error)
      open = false
      sync()
    }
  }

  const handle: PanelHandle = {
    open() {
      open = true
      ensure()
      if (host === undefined) {
        // The centre column was not found (wrong shell version, or called too
        // early). Do not set the active attribute — nothing exists to show.
        console.warn('[dsh-mxpage] could not locate the conversation column; panel not shown.')
        open = false
        return
      }
      sync()
      render()
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
    if (!open) return
    const hadHost = host !== undefined
    ensure()
    if (host === undefined) {
      // The column disappeared and could not be re-found: fail safe rather
      // than leaving a stale active attribute with nothing behind it.
      if (hadHost) {
        open = false
        sync()
      }
      return
    }
    if (!hadHost) render()
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
