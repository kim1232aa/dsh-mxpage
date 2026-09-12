# mxpage-core

A host-agnostic port of [ziguishian/MxPage](https://github.com/ziguishian/MxPage)
(MIT, 灵矩绘境) — the ecommerce product-image pipeline: **analyze → plan →
Visual Prompt Agent → generate → edit → export**, plus the Xiaohongshu four-step
carousel flow.

Everything under `src/core/` talks to its host **only** through the five ports in
[`ports/`](./ports). It never imports `@deepseek-ai/*`, `schemastery`, Next.js,
Prisma or React, and never touches `process.cwd()` / `process.env`. The test
suite enforces this (`test/bundle.test.ts` → "mxpage-core stays host-agnostic").

## Why the extraction was cheap

Upstream is a Next.js 14 App Router app with Prisma/SQLite and an Electron shell
(174 files). Three measured facts made this port viable:

| Fact | Evidence |
|---|---|
| Zero `next/*` imports inside `lib/` | the only exception was `provider-runtime.ts`, importing `NextRequest` solely to read two headers |
| `@prisma/client` appears 9 times | two are type-only; four use only the `Prisma` namespace (`JsonNull` / `InputJsonValue`) |
| The 1344-line adapter had exactly one hard coupling | `import { inferCategory, logApiUsage } from "@/lib/monitor/api-usage"` |

So the port is mostly mechanical: swap types, inject the seams, delete the
framework glue.

## The five ports

| Port | Replaces | Notes |
|---|---|---|
| [`Repository`](./ports/repository.ts) | `import { prisma } from "@/lib/db/prisma"` (~40 call sites) | intent-named methods, not a Prisma clone. `patchProjectModelSnapshot`'s compare-and-swap loop collapses into `mergeModelSnapshot` (single-writer host) |
| [`ProviderResolver`](./ports/provider.ts) | `getProviderAdapter()` + `AsyncLocalStorage` request credentials | trivially replaceable because upstream's `ProviderConfig.apiKeyEncrypted` is *always* `encryptSecret("")` — the real key lives in the browser, so there is no server-side key material to migrate |
| [`Logger`](./ports/logger.ts) | `logApiUsage` / `inferCategory` | the adapter's only hard coupling |
| [`StorageDriver`](./ports/storage.ts) | `path.resolve(process.cwd(), env.STORAGE_ROOT)` (3 sites) | also fixes upstream's path-traversal gap: `normalizeRelPath` rejects escapes |
| [`TaskRunner`](./ports/tasks.ts) | `void handler().catch(console.error)` | upstream had no queue and a `NODE_ENV`-guarded abort registry that production builds could not share |

## What was deliberately NOT ported

- `app/**` — 38 route handlers and 15 pages (Next.js transport)
- `components/**` — upstream UI. The *client* half of this plugin ports it
  separately under `src/client/`, because those components are already
  `"use client"` React whose only framework coupling is `next/link` and
  `next/navigation`.
- `lib/db/prisma.ts`, `prisma/migrations/**` — Prisma ships a query-engine
  binary that cannot be bundled (upstream had to `asarUnpack` it for Electron).
  The 7-model schema ports 1:1 to the host repository instead.
- `lib/monitor/api-usage.ts` — an 18 KB in-app HTTP ledger with a 23 KB admin
  page. The host owns usage accounting.
- `archiver` — replaced by a dependency-free ZIP writer (`utils/zip.ts`), which
  also removes upstream's `process.cwd()` temp file.

## Behaviour intentionally preserved (including two flaws)

1. **Quota does not rotate models.** `shouldFallbackToNextImageModel` returns
   `false` for `429 / quota / 403 / 401`, so an exhausted channel aborts instead
   of trying the next candidate. Kept verbatim behind a `NOTE(dsh-port)` marker;
   the host exposes it as a configurable policy
   (`rotateChannelOnQuotaExhausted`).
2. **`editSectionImage` is not cancellable.** Upstream never registered an abort
   controller on the edit path. Preserved and flagged rather than silently fixed.

Fixed during the port (documented at each site):

- **Visual Prompt Agent retry bug.** Upstream `requestRaw` read
  `if (urls.length === 1 || options?.suppressUsageLog)`, conflating "skip usage
  logging" with "skip the base-URL retry". The VPA is the only caller passing
  `suppressUsageLog: true`, so it silently lost the `/v1`-vs-root fallback and
  degraded to the template prompt whenever a gateway needed the versioned base
  URL.
- **Cross-platform storage paths.** Upstream stored `path.join` output (so
  Windows held backslashes) while the URL builder converted back with
  `split(path.sep)`. Stored paths are now always POSIX.
- **Production cancellation.** The abort-controller registry's
  `process.env.NODE_ENV !== "production"` guard is gone; the registry is now
  per-service-instance.
- **Dead values dropped.** `ProjectStatus.COMPLETED` and
  `GenerationStatus.QUEUED` were never written by any upstream service.

## Layout

```
src/core/
├── ports/         the five injection points (+ CoreHost)
├── types/         domain types (7 models / 6 enums, no Prisma)
├── ai/
│   ├── adapters/  openai-compatible.ts (1344 lines, logger-injected)
│   ├── prompts/   analysis · planning · generation
│   └── schemas/   zod schemas
├── services/      asset-store · task-service · visual-prompt-agent
│                  analysis · planner · generation · xiaohongshu · export
└── utils/         visual-style-guide · content-language · files · zip
```

## Provenance

Prompts, schemas and pipeline logic are MIT from 灵矩绘境 · MxPage.
See [`../../NOTICE`](../../NOTICE) and [`../../LICENSE`](../../LICENSE).
