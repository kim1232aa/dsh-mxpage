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
 * row when found, and next to the shell's own "设置" utility button otherwise
 * — either way it degrades to a self-contained, high-contrast pill rather than
 * inheriting ambient text color, which previously rendered as invisible plain
 * text against a dark sidebar (no icon, no background, effectively no button)
 * when the host's own text/icon colors did not resolve the way `color:
 * inherit` assumed.
 */
export function mountSidebarToggle(onToggle: () => void, label: string, tooltip: string): () => void {
  let button: HTMLButtonElement | undefined

  /** Pins the button right above the session-list region (`regionArea`), i.e.
   * directly under the 新会话/生图 row. Returns false while the shell has not
   * rendered that region yet. Anchoring on `newSession` itself is unreliable:
   * in some shells it IS the row button whose parent is the whole sidebar
   * root, so inserting after its parent drops the toggle below all content. */
  const pin = (column: HTMLElement): boolean => {
    if (button === undefined) return false
    const region = column.querySelector<HTMLElement>('[class*="regionArea"]')
    if (region?.parentElement) {
      if (button.nextSibling !== region) region.parentElement.insertBefore(button, region)
      return true
    }
    return false
  }

  /**
   * Theme-aware foreground/background for the toggle. The colors were once
   * hardcoded light-on-dark (#f3f4f6 text, white-alpha fill) — invisible when
   * the shell sidebar renders in a LIGHT theme (white text on a white
   * sidebar). Instead of trusting `prefers-color-scheme` (the shell theme may
   * not follow the OS setting), walk up from the sidebar column to the first
   * non-transparent computed background and pick contrast colors from its
   * luminance. Recomputed on every ensure(), so a live theme switch corrects
   * the button on the next DOM mutation.
   */
  const themeFor = (column: HTMLElement): { fg: string; bg: string; bgHover: string; border: string } => {
    let el: HTMLElement | null = column
    let bg = 'rgba(0, 0, 0, 0)'
    while (el) {
      const c = getComputedStyle(el).backgroundColor
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (m) {
        const parts = m[1].split(',').map((s) => Number.parseFloat(s))
        const alpha = parts.length > 3 ? parts[3] : 1
        if (alpha > 0.01) {
          bg = c
          break
        }
      }
      el = el.parentElement
    }
    const m = bg.match(/rgba?\(([^)]+)\)/)
    const parts = m ? m[1].split(',').map((s) => Number.parseFloat(s)) : [255, 255, 255]
    // sRGB relative luminance, linearized.
    const lum =
      (0.2126 * lin(parts[0]) + 0.7152 * lin(parts[1]) + 0.0722 * lin(parts[2])) / 255
    const dark = lum < 0.5
    return dark
      ? { fg: '#f3f4f6', bg: 'rgba(255,255,255,0.06)', bgHover: 'rgba(255,255,255,0.12)', border: 'rgba(255,255,255,0.1)' }
      : { fg: '#1f2329', bg: 'rgba(0,0,0,0.05)', bgHover: 'rgba(0,0,0,0.09)', border: 'rgba(0,0,0,0.1)' }
  }
  const lin = (v: number): number => {
    const s = v / 255
    return (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * 255
  }

  const applyTheme = (column: HTMLElement): void => {
    if (button === undefined) return
    const t = themeFor(column)
    button.dataset.mxBg = t.bg
    button.dataset.mxBgHover = t.bgHover
    button.style.color = t.fg
    button.style.background = t.bg
    button.style.border = `1px solid ${t.border}`
  }

  const ensure = (): void => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return
    if (button !== undefined && button.isConnected) {
      // Already mounted: keep correcting the position — the first ensure()
      // often runs before the shell renders the new-session row, and without
      // re-pinning the button stays buried at the sidebar bottom. Also
      // re-apply the theme so a live theme switch is picked up.
      applyTheme(column)
      pin(column)
      return
    }
    const target =
      column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement ??
      (column.firstElementChild as HTMLElement | undefined)
    if (target === undefined) return

    button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshMxpageToggle = ''
    button.setAttribute('aria-label', label)
    button.title = tooltip
    // `currentColor` everywhere inside, so applyTheme() alone re-skins the
    // whole button (icon included) for light/dark sidebars.
    button.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;font:inherit;color:inherit"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12M5.5 9.5h5"/></svg><span style="color:inherit">${label}</span></span>`
    // Self-contained styling: explicit colors via applyTheme(), not
    // `color: inherit` from the shell, so the button stays visible regardless
    // of the host shell's ambient text color AND theme.
    button.style.cssText =
      'display:flex;align-items:center;width:100%;margin:6px 0 0;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1.3;transition:background .15s'
    applyTheme(column)
    button.addEventListener('mouseenter', () => {
      if (button) button.style.background = button.dataset.mxBgHover ?? button.style.background
    })
    button.addEventListener('mouseleave', () => {
      if (button) button.style.background = button.dataset.mxBg ?? button.style.background
    })
    button.addEventListener('click', onToggle)
    // Prefer pinning the toggle right under the 新会话/生图 row so it is as
    // discoverable as the shell's own entries; appending to the sidebar
    // container buries it below 设置 where nobody finds it.
    if (!pin(column)) target.append(button)
  }

  const observer = new MutationObserver(ensure)
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()

  return () => {
    observer.disconnect()
    button?.remove()
  }
}
