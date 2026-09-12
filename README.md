# dsh-mxpage

English | [简体中文](./README.zh-CN.md)

**DeepSeek Harness plugin** that brings [MxPage](https://github.com/ziguishian/MxPage)'s
ecommerce product-image workbench into the official DSH **`web`** profile:

**register photos → analyze selling points → plan hero/detail sections → Visual Prompt Agent → generate → edit → export**

This is **not** a generic gallery, and it is **not** a thin prompt wrapper.
Community plugins such as `dsh-imagegen` register a one-shot `generate_image`.
**dsh-mxpage does not.** Every tool is named `mxpage_*`, and the model must walk
**analyze → plan → VPA → generate** so a product photo becomes a coherent
detail-page set rather than a pile of unrelated images.

Verified against **DSH `0.1.2-rc.1`** host packages. Requires the official
**`web`** profile (not `sdk-minimal`).

**Not an official DeepSeek product.** Not affiliated with DeepSeek AI.
MxPage prompts/schemas remain MIT (灵矩绘境); see [NOTICE](./NOTICE).

---

## Architecture — "换芯留壳"

v0.1 reimplemented MxPage's pipeline by hand and threw away the parts that make
it a product. v0.2 inverts that: the upstream **kernel is ported**, the DSH
adapter is **thin**, and the upstream **UI is in scope**.

```
src/core/     host-agnostic port of upstream lib/   (never imports @deepseek-ai/*)
   └── ports/   Repository · ProviderResolver · Logger · StorageDriver · TaskRunner
src/host/     the five port implementations (JSON repository, fs storage, channels)
src/tools/    thin mxpage_* wrappers over core services
src/client/   the browser panel
```

`src/core/**` cannot import `@deepseek-ai/*`, `schemastery`, Next.js, Prisma or
React, and cannot touch `process.cwd()` / `process.env` — enforced by a test.

Why the extraction was cheap, with evidence:

| Fact | Evidence |
|---|---|
| Zero `next/*` imports inside upstream `lib/` | the one exception, `provider-runtime.ts`, imported `NextRequest` solely to read two headers |
| `@prisma/client` appears 9 times | two are type-only; four use only the `Prisma` namespace |
| The 1344-line OpenAI adapter had **one** hard coupling | `import { inferCategory, logApiUsage } from "@/lib/monitor/api-usage"` |

See [`src/core/README.md`](src/core/README.md) for the full seam list.

---

## Configuration — channels, not an env var

v0.1 required `MXPAGE_IMAGE_API_KEY`. v0.2 uses a **channel list**, so several
endpoints can be configured and rotated:

**设置 → 插件 → MxPage → 渠道**, or in `cordis.patch.yml`:

```yaml
- insert:
    - id: mxpage
      name: dsh-mxpage
      config:
        channels:
          - id: xai
            label: xAI (Grok)
            baseUrl: https://api.example.com/v1
            apiKeyEnv: MXPAGE_XAI_KEY   # preferred: keeps the secret out of the doc
            models: [grok-imagine-image-2.0]
            textModel: grok-4
            imageModel: grok-imagine-image-2.0
        rotateChannelOnQuotaExhausted: true
```

| Field | Meaning |
|---|---|
| `id` / `label` | rotation key and display name |
| `baseUrl` | OpenAI-compatible base URL; a missing `/v1` is retried automatically |
| `apiKey` / `apiKeyEnv` | literal secret, or (preferred) the **name** of an env var |
| `models` | explicit image model ids; leave empty to discover via `GET /models` |
| `textModel` / `imageModel` | preferred models for analyze+plan / generate on this channel |
| `disabled` | skip this channel without deleting it |

Run **`mxpage_channels`** first whenever something fails — it reports which
channel is active, its catalog, and whether any image-capable model was found.

> **Model capability is inferred from the model name.** Upstream deliberately
> skips real endpoint probing to avoid burning image quota, so "the name looks
> like an image model" does not prove the gateway can render images. A gateway
> that advertises a model it cannot serve is discovered by *failing*.

---

## Paid Images API — read this first

Generation and edit tools call an **OpenAI-compatible Images API**
(`/images/generations`, `/images/edits`). That API is **paid**. Each
`mxpage_generate_section`, `mxpage_generate_page` and `mxpage_edit_section`
consumes quota. The shipped skills instruct the model to confirm with you before
a whole-page job.

Secrets never appear in tool output, logs or session events — `sk-` and `Bearer`
tokens are redacted (`src/util/redact.ts`).

---

## Install

```sh
# from a checkout
dsh plugin add link:/absolute/path/to/mxpage

# or from the built tarball
dsh plugin add ./dsh-mxpage-0.2.0.tgz
```

`dsh plugin add` registers the bundle in the profile's
`dsh.profile.bundles` for you. Then configure a channel (above) and restart the
profile so the layer loads.

### Skills catalog

The skills ship inside the package. Copy them next to the DSH catalog so they
are discoverable:

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills"
cp -R skills/mxpage-ecommerce-page skills/mxpage-xiaohongshu skills/mxpage-batch-sku \
      "${DSH_HOME:-$HOME/.dsh}/skills/"
```

---

## Chat example

Attach a product photo and say:

> 根据这张商品图出一套淘宝详情页

Expected: the agent runs create → analyze → plan → generate and you get a hero
set plus detail sections, each as a **new version** (never overwriting), stored
under `$DSH_HOME/mxpage/projects/<projectId>/` and returned as attachments.

---

## Tools (all `mxpage_*`)

| Tool | Role |
|---|---|
| `mxpage_create_project` | New project from 1–10 photos via `attachment_ids` (chat) and/or `image_paths` |
| `mxpage_add_asset` | Append a photo; `role: "main"` swaps the primary reference |
| `mxpage_project_status` | Read-only: analysis, sections, versions, running tasks |
| `mxpage_analyze_product` | Vision analysis → category, materials, selling points, suggested plan |
| `mxpage_plan_page` | Section plan + project-level `visualStyleGuide`. **Re-planning deletes existing sections and images** |
| `mxpage_generate_section` | One frame; runs the VPA unless `prompt_override` is set |
| `mxpage_edit_section` | `repaint` / `enhance` / `translate`; new version, never overwrites |
| `mxpage_generate_page` | Whole page as a background job; `mode: "missing"` fills gaps only |
| `mxpage_job_status` / `mxpage_job_cancel` | Job control; completed sections stay on disk |
| `mxpage_export_page` | ZIP (`00-头图/` + `01-详情页/` + `export-manifest.json`) or project JSON |
| `mxpage_xiaohongshu_plan` | Xiaohongshu step 1 — has a fully local Chinese fallback plan |
| `mxpage_xiaohongshu_generate` | Step 3 — one image per page, VPA-gated |
| `mxpage_xiaohongshu_edit` | Step 4 — edit one page in place |
| `mxpage_channels` | Channel diagnostics |

---

## Skills

| Skill | When |
|---|---|
| `mxpage-ecommerce-page` | Taobao / Tmall / JD / Shopee hero + detail pages |
| `mxpage-xiaohongshu` | The four-step carousel flow |
| `mxpage-batch-sku` | One project per SKU; never mix reference images |

---

## Differences from upstream, and fixes made during the port

**Fixed** (each documented at its call site):

1. **Visual Prompt Agent retry bug.** Upstream `requestRaw` read
   `if (urls.length === 1 || options?.suppressUsageLog)`, conflating "skip usage
   logging" with "skip the base-URL retry". The VPA is the only caller passing
   `suppressUsageLog: true`, so it silently lost the `/v1`-vs-root fallback and
   degraded to the template prompt on gateways needing a versioned base URL.
2. **Path traversal.** Upstream's `/api/files/[...path]` route joined
   `rootDir()` with an unvalidated relative path. The storage port rejects
   escapes (`normalizeRelPath`) and the route is gone entirely.
3. **Cross-platform paths.** Upstream stored `path.join` output (backslashes on
   Windows) while its URL builder converted back with `split(path.sep)`.
4. **Production cancellation.** Upstream's abort registry was guarded by
   `process.env.NODE_ENV !== "production"`, so production builds could not cancel.
5. **Dead values dropped:** `ProjectStatus.COMPLETED` and
   `GenerationStatus.QUEUED` were never written by any upstream service.

**Preserved deliberately** (flagged, not silently changed):

- **Quota does not rotate models.** Upstream `shouldFallbackToNextImageModel`
  returns false for `429 / quota / 403 / 401`, so an exhausted channel aborts
  instead of trying the next candidate. Exposed as the
  `rotateChannelOnQuotaExhausted` config flag.
- **`editSectionImage` is not cancellable** — upstream never registered an abort
  controller on that path.
- `archiver` was replaced by a dependency-free ZIP writer, which also removes
  upstream's `process.cwd()` temp file.

---

## Develop

```sh
npm install
npm run build     # tsdown → lib/index.js (+ lib/client.js when src/client exists)
npm test          # node --experimental-strip-types --test
npx tsc --noEmit  # 0 errors expected
```

Tests worth knowing about:

- `test/bundle.test.ts` — package manifest sanity **and** the host-agnostic
  invariant on `src/core/**`
- `test/core.test.ts` — ZIP header/CRC format, repository semantics
  (terminal-state stickiness, system-project hiding, stale recovery), storage
  path containment, task cancellation
- `test/smoke.test.ts` — loads the **built** `lib/index.js`, runs the real
  `apply()` against a mock Cordis context, and asserts all 15 tools register

---

## License

MIT. MxPage prompts, schemas and pipeline logic are MIT (灵矩绘境) — see
[NOTICE](./NOTICE) and [LICENSE](./LICENSE).

Topics: `dsh-plugin` · `dsh` · `deepseek-harness` · `mxpage` · `ecommerce`
