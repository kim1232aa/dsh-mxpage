# dsh-mxpage implementer constraints

Read `docs/guides/dsh-plugin-spec-investigation.md`, `docs/guides/mxpage-tool-contracts.md`
and `docs/guides/mxpage-core-architecture.md` before writing code.

## Architecture (v0.2 — "换芯留壳")

The plugin is a thin host adapter over `src/core/` (see `src/core/README.md`).

- `src/core/**` — host-agnostic port of ziguishian/MxPage. Must NEVER import
  `@deepseek-ai/*`, `schemastery`, Next.js, Prisma, React, or touch
  `process.cwd()` / `process.env`. It talks to the host only through the five
  ports in `src/core/ports/`.
- `src/**` (outside `core/`) — the DSH adapter: config, tools, host port
  implementations, attachment bridging.
- `src/client/**` — the browser panel.

## Hard rules

- Export `name` + `apply`. Never `export default function apply`.
- `inject` is a **string array of host service names actually provided by the
  runtime**. Verified from `dsh --profile desktop --dump-config`: `webServer`,
  `tools`, `attachments` and `jobs` all exist (`jobs` is provided by
  `@deepseek-ai/dsh-jobs-local` in `dsh-base`).
- **Background work goes through `ctx.jobs`** (`@deepseek-ai/dsh-jobs`), which
  owns job identity, session-scoped access, lifecycle state, completion
  notices and owner-disposal cancellation. `src/host/jobs-task-runner.ts` is the
  implementation; `src/host/task-runner.ts` is the fallback for hosts without a
  registry. Custom kinds require declaration merging on `JobKindMap`.
  Three registry rules that are silent when broken: `run()` returns hooks
  **synchronously** (it is not an async work fn), `hooks.done` must **never
  reject**, and `hooks.cancel` must be synchronous and idempotent.
- `jobs` is read via the optional `ctx.get('jobs')` accessor rather than put in
  the fiber `inject` list, so a host without a registry degrades gracefully
  instead of failing the plugin boot.
- `Config` is a Schemastery schema (interface + const), imported from
  **`schemastery`** — not `@deepseek-ai/schemastery`.
- Tools come from `defineTool` in `@deepseek-ai/dsh-tools` and are registered
  with `ctx.tools.register(...)`.
- Attachments come from `@deepseek-ai/dsh-attachment`
  (`AttachmentStore`, `ImageAttachmentRef`).
- `package.json` has `dsh.bundle.patch` and outputs to `lib/` (`lib/index.js`,
  `lib/client.js`).
- Tools are `mxpage_*` only. Never `generate_image` / `image_generate` —
  channels are shared with `dsh-imagegen` through the ProviderResolver port,
  not by registering a competing tool.
- Optional params omit `required`. Object output schemas set `additionalProperties`.
- `render` is pure text-only. Images: `saveImage({ data, mediaType, name })`,
  return `attachmentId`.
- Path-normalize writes; reject `..` (`src/util/paths.ts`).
- Keep NOTICE / MIT attribution for MxPage (灵矩绘境).

## Revoked rules (do not reinstate)

These two rules produced the v0.1 architecture that discarded MxPage's product
surface. They are explicitly **reversed**:

1. ~~`Secrets from MXPAGE_IMAGE_API_KEY only.`~~
   → Credentials come from the DSH host through `ProviderResolver`
   (`src/host/provider-resolver.ts`). Environment variables are a fallback for
   CLI use, never the primary path. Redaction (`sk-` / `Bearer`) still applies.

2. ~~`Do not port Next.js / Electron / Prisma. No dsh.client in P0–P3.`~~
   → Still true: do **not** port Next.js, Electron, or the Prisma ORM.
   But the client React components **are** in scope for `src/client/**`; the
   upstream UI is written as `"use client"` components whose only framework
   coupling is `next/link` and `next/navigation`. And `dsh.client` is a
   first-class deliverable, not a deferred one.
