# dsh-mxpage Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dsh-mxpage` as a Cordis bundle in `/workspace/dsh-plugins/dsh-mxpage` so the official DSH `web` profile can run MxPage's analyze → plan → VPA → section-generate pipeline from chat.

**Architecture:** One function plugin (`name` + `apply`). Workspace JSON replaces Prisma. Images go through an OpenAI-compatible `/v1/images/*` client, then `ctx.attachments.saveImage` plus files on disk. Whole-page work is a `ctx.jobs` background job. Skills tell the model the order; tools do the work.

**Tech Stack:** TypeScript ESM, `@deepseek-ai/cordis` + `dsh-tools` + `schemastery` as peers, `tsdown` for a self-contained `index.js`, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md`  
**Guide:** `docs/guides/dsh-mxpage-plugin-dev.md`  
**Constraints file:** `dsh-plugins/AGENTS.md`

## Global Constraints

- Package lives at `/workspace/dsh-plugins/dsh-mxpage/`. Do not put `@deepseek-ai/dsh` in `/workspace/package.json`.
- Profile stays `web`. Never switch to `sdk-minimal` / `headless`.
- Export `name` + `apply`. Never `export default function apply`.
- `inject` is a string array: `['tools', 'attachments', 'jobs']`.
- `Config` is a Schemastery schema (interface + const of the same name).
- Tool names are `mxpage_*` only. Do not register `generate_image`.
- Optional tool params omit `required`; never write `required: false`.
- `output.render` is a pure text-only function. Images via `saveImage`.
- Secrets only from env (`MXPAGE_IMAGE_API_KEY`). Redact `sk-` / Bearer in logs and tool output.
- Path normalize every write; reject `..`; never write outside the project root.
- Do not port Next.js / Electron / Prisma. Do not add `dsh.client` in P0–P3.
- `allowSvgFallback` defaults false.
- Verified DSH: `0.1.5-rc.1`. Upstream MxPage prompts stay MIT-attributed in `NOTICE`.

## File map

```
dsh-plugins/dsh-mxpage/
  package.json
  cordis.patch.yml
  tsdown.config.ts
  tsconfig.json
  README.md
  README.zh-CN.md
  LICENSE
  NOTICE
  src/index.ts
  src/config.ts
  src/util/paths.ts
  src/util/redact.ts
  src/util/images.ts
  src/service/state-machine.ts
  src/service/project-store.ts
  src/provider/openai-images.ts
  src/provider/vision-text.ts
  src/pipeline/analyze.ts
  src/pipeline/plan.ts
  src/pipeline/visual-prompt.ts
  src/pipeline/generate.ts
  src/pipeline/edit.ts
  src/pipeline/export.ts
  src/prompts/*.ts
  src/schemas/*.ts
  src/tools/*.ts
  skills/*/SKILL.md
  test/*.test.ts
```

---

### Task 1: P0 — installable empty bundle

**Files:**
- Create: `dsh-plugins/dsh-mxpage/package.json`
- Create: `dsh-plugins/dsh-mxpage/cordis.patch.yml`
- Create: `dsh-plugins/dsh-mxpage/tsconfig.json`
- Create: `dsh-plugins/dsh-mxpage/tsdown.config.ts`
- Create: `dsh-plugins/dsh-mxpage/src/index.ts`
- Create: `dsh-plugins/dsh-mxpage/src/config.ts`
- Create: `dsh-plugins/dsh-mxpage/test/bundle.test.ts`
- Create: `dsh-plugins/dsh-mxpage/LICENSE`
- Create: `dsh-plugins/dsh-mxpage/NOTICE`

**Interfaces:**
- Produces: `export const name = 'mxpage'`, `export function apply(ctx, config)`, `export const Config`, `dsh.bundle.patch`
- Produces: `index.js` loadable by Node

- [ ] **Step 1: Write the failing bundle test**

```ts
// test/bundle.test.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json declares dsh.bundle.patch', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-mxpage')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'])
})

test('plugin exports name + apply, not default function', async () => {
  const mod = await import(join(root, 'src/index.ts'))
  assert.equal(mod.name, 'mxpage')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.default, undefined)
  assert.ok(mod.Config)
  assert.deepEqual(mod.inject, ['tools', 'attachments', 'jobs'])
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /workspace/dsh-plugins/dsh-mxpage
node --experimental-strip-types --test test/bundle.test.ts
```

Expected: FAIL (package.json missing).

- [ ] **Step 3: Write the minimal package**

`package.json`:

```json
{
  "name": "dsh-mxpage",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml", "skills"],
  "scripts": {
    "build": "tsdown",
    "test": "node --experimental-strip-types --test test/**/*.test.ts"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/schemastery": "*"
  },
  "devDependencies": {
    "tsdown": "^0.12.0",
    "typescript": "^5.8.0"
  }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: mxpage
      name: dsh-mxpage
      config:
        imageModel: gpt-image-2
        defaultLanguage: zh-CN
```

`src/config.ts` — full Config interface + Schemastery object from the spec §配置, all defaults from the guide §7.

`src/index.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as MxpageConfig } from './config.ts'

export const name = 'mxpage'
export const inject = ['tools', 'attachments', 'jobs']
export { Config }

export function apply(_ctx: Context, _config: MxpageConfig) {
  // tools registered in Task 4
}
```

`NOTICE` must credit MxPage (MIT, 灵矩绘境, https://github.com/ziguishian/MxPage) for prompts/schemas/pipeline. LICENSE is MIT.

- [ ] **Step 4: Install peers from the already-present dsh-runtime (do not add them to /workspace/package.json)**

```bash
cd /workspace/dsh-plugins/dsh-mxpage
npm install
```

Point TypeScript `paths` at `/workspace/dsh-runtime/node_modules/@deepseek-ai/*` if npm cannot hoist peers; the built `index.js` must still be self-contained for `dsh plugin add`.

- [ ] **Step 5: Re-run tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Build and add to the web profile**

```bash
npm run build
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh plugin --profile web add /workspace/dsh-plugins/dsh-mxpage
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh --profile web --dump-config | grep mxpage
```

Expected: `# == dsh-mxpage` in dump-config. Do not start a second dsh; preview is already the official web GUI.

---

### Task 2: Path safety + redact + state machine

**Files:**
- Create: `src/util/paths.ts`
- Create: `src/util/redact.ts`
- Create: `src/service/state-machine.ts`
- Create: `test/paths.test.ts`
- Create: `test/redact.test.ts`
- Create: `test/state-machine.test.ts`

**Interfaces:**
- Produces: `assertInside(root: string, target: string): string` — returns resolved path or throws
- Produces: `redactSecrets(text: string): string` — strips `sk-` tokens and `Bearer …`
- Produces: `assertTransition(from, to)` and `STATUS` union from the spec state machine

- [ ] **Step 1: Write failing tests**

```ts
// test/paths.test.ts
test('rejects path traversal', () => {
  assert.throws(() => assertInside('/tmp/proj', '/tmp/proj/../outside.png'))
})
test('accepts nested asset path', () => {
  assert.equal(assertInside('/tmp/proj', '/tmp/proj/assets/main.jpg'), '/tmp/proj/assets/main.jpg')
})

// test/redact.test.ts
test('redacts sk- and Bearer', () => {
  assert.equal(redactSecrets('key sk-abc123 Bearer tok'), 'key [REDACTED] Bearer [REDACTED]')
})

// test/state-machine.test.ts
test('refuses plan before analyze', () => {
  assert.throws(() => assertTransition('created', 'planning'))
})
test('allows created → analyzing → analyzed → planning → planned', () => {
  let s = 'created'
  s = assertTransition(s, 'analyzing')
  s = assertTransition(s, 'analyzed')
  s = assertTransition(s, 'planning')
  s = assertTransition(s, 'planned')
  assert.equal(s, 'planned')
})
```

- [ ] **Step 2: Run tests, confirm FAIL**

```bash
node --experimental-strip-types --test test/paths.test.ts test/redact.test.ts test/state-machine.test.ts
```

- [ ] **Step 3: Implement**

`assertInside`: `path.resolve`, then `rel = path.relative(root, resolved)`; throw if `rel.startsWith('..')` or `path.isAbsolute(rel)`.

Legal transitions (closed set):

```
created → analyzing | failed
analyzing → analyzed | failed
analyzed → planning | failed
planning → planned | failed
planned → generating | editing | failed
generating → generated | failed
generated → editing | generating | failed
editing → generated | failed
failed → analyzing | planning | generating | editing
```

- [ ] **Step 4: Re-run tests, expect PASS**

---

### Task 3: Project store

**Files:**
- Create: `src/service/project-store.ts`
- Create: `test/project-store.test.ts`

**Interfaces:**
- Consumes: `assertInside`, `assertTransition`
- Produces:

```ts
type AssetRole = 'main' | 'angle' | 'detail' | 'reference'
interface ProjectRecord {
  id: string
  name: string
  status: string
  language: 'zh-CN' | 'en' | 'ja' | 'ko'
  aspectRatio: '1:1' | '3:4' | '9:16'
  mainAssetPath: string
  assets: { path: string; role: AssetRole }[]
  workspaceDir: string
}
function createStore(rootDir: string): {
  create(input): ProjectRecord
  addAsset(projectId, absImagePath, role): ProjectRecord
  read(projectId): ProjectRecord
  write(projectId, patch): ProjectRecord
  projectDir(projectId): string
}
```

- [ ] **Step 1: Failing tests** — create copies images (does not move), default main = first image, `role=main` required to replace main, traversal of dest throws, missing project throws.

- [ ] **Step 2: Implement** — `rootDir/projects/<id>/` with `project.json` + `assets/`. `id` = `mxp_` + `crypto.randomUUID()`. Copy with `fs.copyFile`. Max 10 assets.

- [ ] **Step 3: Tests PASS**

---

### Task 4: OpenAI-compatible images provider (P1)

**Files:**
- Create: `src/provider/openai-images.ts`
- Create: `src/util/images.ts`
- Create: `test/provider.images.test.ts`

**Interfaces:**
- Produces:

```ts
interface ImagesClient {
  generate(input: {
    prompt: string
    size: '1024x1024' | '1024x1536'
    model: string
    references: { bytes: Uint8Array; filename: string; mediaType: string }[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>
  edit(input: {
    prompt: string
    size: '1024x1024' | '1024x1536'
    model: string
    image: { bytes: Uint8Array; filename: string; mediaType: string }
    references: { bytes: Uint8Array; filename: string; mediaType: string }[]
    signal: AbortSignal
  }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>
}
function createImagesClient(opts: {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
}): ImagesClient
function mapImageError(status: number, body: string): { ok: false; error: string }
```

Error map: `401` → readable「图像 API 密钥无效或未配置」; `429` →「额度或速率限制」; `400` model →「模型不支持」; abort →「已取消」. Never include stack or raw key.

- [ ] **Step 1: Failing mock-HTTP test**

Stand up `http.createServer` that records multipart field names. Call `generate` with one reference. Assert:

1. request URL ends with `/images/generations` or `/images/edits` when references exist
2. `Authorization` header is `Bearer testdata` (not logged)
3. form contains an `image` field when references are passed (main-image anchoring)
4. aborting the signal rejects with the cancelled error string

- [ ] **Step 2: Implement client** — `baseUrl` already includes `/v1`. Read image bytes with `src/util/images.ts` (reject > 20MiB, edge > 8192). Prefer `/images/edits` when any reference is present (MxPage adapter behavior).

- [ ] **Step 3: Tests PASS**. Confirm `redactSecrets` is applied to any thrown message.

---

### Task 5: P1 tools — create / add_asset / status / generate_section

**Files:**
- Create: `src/tools/register.ts`
- Create: `src/tools/create-project.ts`
- Create: `src/tools/add-asset.ts`
- Create: `src/tools/project-status.ts`
- Create: `src/tools/generate-section.ts`
- Create: `src/pipeline/generate.ts`
- Create: `test/tools.execute.test.ts`
- Modify: `src/index.ts` — call `registerMxpageTools(ctx, config)`

**Interfaces:**
- Consumes: project store, images client
- Produces: four `defineTool` registrations, text-only `render`

P1 generate_section may use `prompt_override` without VPA. If `prompt_override` is missing and no prompt file exists, return `{ ok: false, error: 'missing prompt; call mxpage_refine_prompt or pass prompt_override' }` — do not invent pixels.

`generate_section` parameters:

```ts
{
  project_id: { type: 'string', required: true, description: '…' },
  section_key: { type: 'string', required: true, description: 'e.g. hero_01' },
  prompt_override: { type: 'string', description: 'skip VPA' },
  reference_paths: { type: 'array', items: { type: 'string' } },
  size: { type: 'string', enum: ['1024x1024', '1024x1536'] },
  model: { type: 'string' },
}
```

Default references: main asset + first successful hero output. `timeoutMs: 180_000`. `isConcurrencySafe: false`. After bytes return: write `output/<sectionKey>.png` and `versions/<sectionKey>/vN.png`, then `ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name })`. Return `{ ok, projectId, sectionKey, outputPath, attachmentId, modelUsed, versionId }` (`attachmentId` from `ref.attachmentId`).

- [ ] **Step 1: Failing tests**

1. create_project copies fixture PNG into `assets/`, does not delete source.
2. generate_section with mock client writes png + calls `saveImage`.
3. generate_section render output is `[{ type: 'text', text: ... }]` with no `image` / base64.
4. `../etc/passwd` as image_paths throws.
5. `exec.signal` abort stops generate.

Use a fake `ctx`:

```ts
const saved = []
const ctx = {
  tools: { register(t) { tools.push(t) } },
  attachments: { saveImage: async (input) => { saved.push(input); return { attachmentId: 'att_1', mediaType: 'image/png', bytes: input.data.byteLength, width: 1, height: 1 } } },
  jobs: { start() { throw new Error('jobs unused in P1') } },
}
```

- [ ] **Step 2: Implement tools + wire `apply`**

Read API key from `process.env[config.imageApiKeyEnv]`. If missing, generate_section returns `{ ok: false, error: '未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）' }` — do not throw a stack.

- [ ] **Step 3: Tests PASS, rebuild, dump-config still shows mxpage**

```bash
npm test && npm run build
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh --profile web --dump-config | grep mxpage
```

P1 demo: in chat, 「只要一张白底主图，1:1」with a product photo in the workspace should call create + generate_section.

---

### Task 6: P2 — schemas, prompts, analyze / plan / VPA

**Files:**
- Create: `src/schemas/product-analysis.ts`
- Create: `src/schemas/section-plan.ts`
- Create: `src/schemas/visual-prompt.ts`
- Create: `src/prompts/analysis.ts`
- Create: `src/prompts/planning.ts`
- Create: `src/prompts/visual-prompt-agent.ts`
- Create: `src/prompts/generation.ts`
- Create: `src/provider/vision-text.ts`
- Create: `src/pipeline/analyze.ts`
- Create: `src/pipeline/plan.ts`
- Create: `src/pipeline/visual-prompt.ts`
- Create: `src/tools/analyze.ts`
- Create: `src/tools/plan.ts`
- Create: `src/tools/refine-prompt.ts`
- Create: `test/schemas.test.ts`
- Create: `test/prompts.snapshot.test.ts`
- Create: `test/state-machine-plan.test.ts`

**Interfaces:**
- Analysis output fields (stable): `productName, category, subcategory, material, color, styleTags[], targetAudience[], usageScenarios[], coreSellingPoints[], differentiationPoints[], userConcerns[], recommendedFocusPoints[], additionalInformation, generationRequirements, suggestedSectionPlan[{ type, title, goal }]`
- Section types closed set: `hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom`
- VPA output: `{ finalPrompt, negativePrompt, qualityChecklist }`
- Vision: prefer `ctx.llm` when the route declares `input: [text, image]`; else Config `textBaseUrl` + `textModel`; else `{ ok: false, error: '当前模型不支持视觉，无法分析商品图' }` — never guess the product from filename.

- [ ] **Step 1: Schema + snapshot tests** — valid fixture parses; missing `productName` fails; extra fields stripped or kept explicitly. Snapshot asserts physical-realism constraints exist in prompts (几何不可反转、禁止逆风、主体与参考图一致、避免乱码文字). Prompts must not contain the string `MxPage`.

- [ ] **Step 2: Port prompts from MxPage** (`lib/ai/prompts/*`) with the migration rules in the guide §9. Keep NOTICE attribution.

- [ ] **Step 3: Implement vision-text JSON caller** — system prompt "只输出一个 JSON 对象"; one repair retry; local schema validate.

- [ ] **Step 4: Tools**

`mxpage_analyze_product`: requires project, timeout 120s, writes `analysis.json`, transition `created|failed → analyzing → analyzed`.

`mxpage_plan_page`: refuses unless status is `analyzed` (or `planned` for replan). Writes `plan.json` + `style-guide.json`. `hero_count` 1–5 default 3, `detail_count` 1–10 default 6.

`mxpage_refine_prompt`: writes `prompts/<sectionKey>.json`. `generate_section` without `prompt_override` must call this automatically.

- [ ] **Step 5: Tests PASS**

---

### Task 7: P2 — ecommerce Skill

**Files:**
- Create: `skills/mxpage-ecommerce-page/SKILL.md`
- Modify: `package.json` `files` already includes `skills`

**Interfaces:**
- Produces: skill frontmatter `name` + `description` visible in DSH skill catalog

- [ ] **Step 1: Write SKILL.md** covering: triggers (电商头图、详情页、淘宝/天猫/京东/Shopee); forced order create → analyze → plan → generate_page or per-section refine+generate; main-image anchoring; stop on 401/额度 and tell the user to fix Config; never bash-edit images; remind that `generate_page` spends image quota.

- [ ] **Step 2: Confirm the built tarball / `index.js` sibling `skills/` directory is present after `npm run build`** (copy skills in `tsdown` `copy` or a `files` field so `dsh plugin add` sees them).

---

### Task 8: P3 — whole page job + edit + anchoring

**Files:**
- Create: `src/tools/generate-page.ts`
- Create: `src/tools/edit-section.ts`
- Create: `src/tools/job.ts`
- Create: `src/pipeline/edit.ts`
- Create: `test/generate-page.test.ts`
- Create: `test/edit-section.test.ts`

**Interfaces:**
- Extend `JobKindMap` with `mxpage_page`. If `exec.signal.aborted`, throw AbortError and do **not** call `start`.
- `mxpage_generate_page` returns `{ kind: 'background', jobId }` from:

```ts
const ac = new AbortController()
const jobId = ctx.jobs.start({
  kind: 'mxpage_page',
  label: `mxpage page ${projectId}`,
  ...(exec.agent ? { owner: exec.agent } : {}),
  run: () => ({
    cancel: (reason) => ac.abort(reason),
    done: runPageJob(projectId, ac.signal).then(
      () => ({ status: 'completed' as const }),
      (err) => ({ status: 'failed' as const, detail: redactSecrets(String(err?.message ?? err)) }),
    ),
  }),
})
```

`run()` is **synchronous** and returns `JobHooks`. Work happens in `done`. Do not keep using `exec.signal` after `start`.
- Job order: analyze if needed → plan if needed → all hero sections → details with references = original main + first successful hero.
- Progress file `tasks/<jobId>.json`: `{ state, progress, currentSection, error? }`.
- `mxpage_job_status` / `mxpage_job_cancel`.
- `mxpage_edit_section` modes `repaint | enhance | translate`; new version, never overwrite old version files.

- [ ] **Step 1: Failing tests**

1. Unanalyzed project: job runs analyze then plan then generate (mock).
2. Detail generate mock request includes both main image and hero output in the image fields.
3. cancel: job stops; completed sections remain on disk.
4. translate without `target_language` returns `{ ok: false, error }`.
5. edit writes `versions/<key>/v2.png` and leaves `v1.png`.

- [ ] **Step 2: Implement**. Cap parallel sections with `config.maxParallelSections` (default 2). Same sectionKey lock.

- [ ] **Step 3: Tests PASS**. This task fulfills the original chat acceptance: 「根据这张商品图出一套淘宝详情页」→ ≥1 hero + ≥3 detail files.

---

### Task 9: P4 — xiaohongshu, batch SKU, export

**Files:**
- Create: `skills/mxpage-xiaohongshu/SKILL.md`
- Create: `skills/mxpage-batch-sku/SKILL.md`
- Create: `src/tools/export.ts`
- Create: `src/pipeline/export.ts`
- Create: `test/export.test.ts`

**Interfaces:**
- Xiaohongshu skill: plan → show VPA prompt for confirmation → generate → edit; default aspect `3:4`; VPA mode `xiaohongshu_page`.
- Batch skill: one project per SKU; never mix reference images; honor `maxParallelProjects` if added to Config (default 1).
- `mxpage_export_page`: `format: "paths" | "zip"`; zip at `output/export-<iso>.zip`.

- [ ] **Step 1: Export test** — after two fake outputs, `format=paths` lists both; `format=zip` creates a zip that contains those pngs and `analysis.json`.

- [ ] **Step 2: Implement + skills**

- [ ] **Step 3: Tests PASS**

---

### Task 10: P5 — hardening, README, install smoke

**Files:**
- Create: `dsh-plugins/dsh-mxpage/README.md`
- Create: `dsh-plugins/dsh-mxpage/README.zh-CN.md`
- Modify: `dsh-plugins/README.md` — status table: `dsh-mxpage` 可安装
- Modify: `src/index.ts` inject stays `['tools', 'attachments', 'jobs']`

**Interfaces:**
- README states: verified DSH `0.1.5-rc.1`, env `MXPAGE_IMAGE_API_KEY`, difference vs `dsh-imagegen` (this plugin is analyze→plan→VPA, not a gallery), paid Images API warning, not an official DeepSeek product.

- [ ] **Step 1: README in zh-CN + en covering install, env, tools list, non-goals**

- [ ] **Step 2: Full test + build + plugin add + dump-config**

```bash
cd /workspace/dsh-plugins/dsh-mxpage
npm test
npm run build
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh plugin --profile web add /workspace/dsh-plugins/dsh-mxpage
DSH_HOME=/workspace/.dsh-home \
  /workspace/dsh-runtime/node_modules/.bin/dsh --profile web --dump-config | grep -E 'mxpage|dsh-web-app|dsh-base'
```

Expected: mxpage layer AND web-app AND dsh-base all present (still the complete web profile).

- [ ] **Step 3: HTTP completeness still official GUI**

```bash
node /workspace/scripts/dsh-http-completeness.mjs
```

Expected: official DeepSeek Harness, not a homemade page.

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Installable bundle, `dsh.bundle.patch`, name+apply | 1 |
| Path safety, redact, state machine | 2 |
| Workspace JSON store, copy-not-move, explicit main | 3 |
| Images API client, error mapping, abort | 4 |
| P1 tools + saveImage + text-only render | 5 |
| Analyze / plan / VPA + prompts + vision fallback | 6 |
| ecommerce Skill | 7 |
| generate_page jobs, edit, main-image anchoring | 8 |
| xiaohongshu / batch / export | 9 |
| README, paid-API warning, still complete web | 10 |
| No Next/Electron/Prisma, no generate_image, no dsh.client in P0–P3 | Global + Tasks 1–8 |
| Original chat acceptance (一套详情页) | Task 8 |

Do not implement SVG fallback. Do not add `dsh.client` unless a later request reopens P5 optional settings card.
