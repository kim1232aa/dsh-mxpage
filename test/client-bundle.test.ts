/**
 * Verifies the browser half against the DSH loader contract.
 *
 * The web shell does not load client halves as ESM: it hands each bundle a
 * `window.__ModuleLoader__.load({ id, factory })` facade and a `require` that
 * resolves the shell's live module table. A bundle that ships as ESM, or whose
 * `factory` does not return `module.exports`, silently never applies — which is
 * exactly the failure mode this test exists to catch.
 *
 * A hand-rolled DOM stub keeps the test dependency-free.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')

interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

// ---------------------------------------------------------------------------
// minimal DOM
// ---------------------------------------------------------------------------

function makeElement(tag: string): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', removeProperty() {} },
    dataset: {},
    children: [] as unknown[],
    isConnected: true,
    textContent: '',
    innerHTML: '',
    id: '',
    type: '',
    title: '',
    parentElement: null as unknown,
    append(child: unknown) {
      ;(element.children as unknown[]).push(child)
      if (child && typeof child === 'object') {
        ;(child as { parentElement?: unknown }).parentElement = element
      }
      return child
    },
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
  }
  return element
}

function installDomStub(): () => void {
  const head = makeElement('head')
  const body = makeElement('body')
  const documentElement = makeElement('html')
  const document = {
    head,
    body,
    documentElement,
    getElementById: () => null,
    createElement: (tag: string) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
    },
    location: { href: 'http://127.0.0.1:43120/', origin: 'http://127.0.0.1:43120' },
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = {
    window: globals.window,
    document: globals.document,
    MutationObserver: globals.MutationObserver,
    CustomEvent: globals.CustomEvent,
  }
  globals.window = window
  globals.document = document
  globals.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globals.CustomEvent = class {
    type: string
    init?: unknown
    constructor(type: string, init?: unknown) {
      this.type = type
      this.init = init
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
  }
}

/** Loads the bundle through the same façade the shell provides. */
async function loadClientBundle(): Promise<{ registrations: Registration[]; facade: unknown }> {
  const source = readFileSync(bundlePath, 'utf8')
  const registrations: Registration[] = []
  const facade = {
    load(registration: Registration) {
      registrations.push(registration)
    },
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const w = globals.window as Record<string, unknown>
  w.__ModuleLoader__ = facade

  // The bundle is a script, not a module: evaluate it the way the shell does.
  const evaluate = new Function('window', 'document', source)
  evaluate(w, globals.document)
  return { registrations, facade }
}

// ---------------------------------------------------------------------------

test('client bundle registers with __ModuleLoader__.load under the package id', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/client.js missing — run `npm run build`')
    return
  }
  const restore = installDomStub()
  try {
    const { registrations } = await loadClientBundle()
    assert.equal(registrations.length, 1, 'exactly one load() registration')

    const registration = registrations[0]!
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    assert.equal(registration.id, pkg.name, 'the loader keys modules by package name')
    assert.equal(typeof registration.factory, 'function')
  } finally {
    restore()
  }
})

test('factory resolves react through the injected require and exports apply + inject', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/client.js missing — run `npm run build`')
    return
  }
  const restore = installDomStub()
  try {
    const { registrations } = await loadClientBundle()
    const registration = registrations[0]!

    const nodeRequire = createRequire(import.meta.url)
    const requested: string[] = []
    const shellRequire = (specifier: string): unknown => {
      requested.push(specifier)
      if (specifier === 'react' || specifier === 'react-dom' || specifier === 'react-dom/client') {
        return nodeRequire(specifier)
      }
      throw new Error(`shell require does not provide ${specifier}`)
    }

    const exports = registration.factory(shellRequire)
    assert.ok(requested.includes('react'), 'react must come from the shell module table')
    assert.equal(typeof exports.apply, 'function', 'apply must be exported for the shell to call')
    assert.ok(Array.isArray(exports.inject), 'inject must be an array')
  } finally {
    restore()
  }
})

test('apply() never throws even with no shell DOM present', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/client.js missing — run `npm run build`')
    return
  }
  const restore = installDomStub()
  try {
    const { registrations } = await loadClientBundle()
    const nodeRequire = createRequire(import.meta.url)
    const shellRequire = (specifier: string): unknown => {
      if (specifier.startsWith('react')) return nodeRequire(specifier)
      throw new Error(`unexpected ${specifier}`)
    }
    const exports = registration0(registrations).factory(shellRequire)
    const apply = exports.apply as (ctx: unknown) => void

    let effectRan = false
    const ctx = {
      get: () => undefined,
      effect(callback: () => unknown) {
        effectRan = true
        callback()
      },
      inject() {},
      tools: { register: () => () => {} },
      slots: { inject() {}, register: () => () => {} },
    }

    // Mounting into a shell that has no sidebar / centre column must degrade to
    // a log, never a throw: a throwing apply fails the whole GUI boot.
    apply(ctx)
    assert.ok(effectRan, 'apply must register a disposer through ctx.effect')
  } finally {
    restore()
  }
})

function registration0(registrations: Registration[]): Registration {
  const first = registrations[0]
  assert.ok(first)
  return first
}

// ---------------------------------------------------------------------------
// INCIDENT REGRESSION: the panel CSS must never be able to blank the whole
// app.
//
// A prior version's stylesheet included
//   html[data-dsh-mxpage-active] CENTRE_COLUMN > *:not(PANEL) { display: none !important; }
// which fires from the CSS alone, independent of whether the panel's own host
// element actually mounted. When the centre-column selector failed to match
// the live shell, `sync()` still set the active attribute, and every sibling
// in the conversation column vanished with nothing rendered in its place —
// reported in production as "the whole main area goes black, only the
// sidebar still works". Fixed by removing any rule that reaches outside the
// panel's own selector; the panel now covers the conversation only via its
// own absolutely positioned, opaque host element.
// ---------------------------------------------------------------------------

test('the injected stylesheet never hides anything outside the panel selector', async (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('lib/client.js missing — run `npm run build`')
    return
  }
  const restore = installDomStub()
  try {
    const createdStyleElements: Array<{ textContent: string }> = []
    const globals = globalThis as unknown as Record<string, unknown>
    const document = globals.document as {
      createElement: (tag: string) => Record<string, unknown>
      head: { append: (node: unknown) => void }
    }
    const originalCreateElement = document.createElement
    document.createElement = (tag: string) => {
      const element = originalCreateElement(tag)
      if (tag === 'style') {
        createdStyleElements.push(element as unknown as { textContent: string })
      }
      return element
    }

    const nodeRequire = createRequire(import.meta.url)
    const { registrations } = await loadClientBundle()
    const exports = registration0(registrations).factory((specifier) => {
      if (specifier.startsWith('react')) return nodeRequire(specifier)
      throw new Error(`unexpected ${specifier}`)
    })

    let effectCleanup: (() => void) | undefined
    const ctx = {
      get: () => undefined,
      effect(callback: () => (() => void) | void) {
        effectCleanup = callback() ?? undefined
      },
      inject() {},
      tools: { register: () => () => {} },
      slots: { inject() {}, register: () => () => {} },
    }
    ;(exports.apply as (ctx: unknown) => void)(ctx)

    assert.ok(createdStyleElements.length > 0, 'the panel must inject a stylesheet')
    for (const style of createdStyleElements) {
      const css = style.textContent
      assert.doesNotMatch(
        css,
        /!important/,
        'no rule in the injected stylesheet may use !important (that is what let it override sibling visibility from CSS alone)',
      )
      assert.doesNotMatch(
        css,
        />\s*\*\s*:not\(/,
        'no rule may target ">*: not(...)" — that shape is exactly what hid every sibling in the conversation column',
      )
    }

    effectCleanup?.()
  } finally {
    restore()
  }
})
