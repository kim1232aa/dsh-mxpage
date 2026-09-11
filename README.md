# dsh-mxpage

English | [简体中文](./README.zh-CN.md)

**DeepSeek Harness plugin** that ports [MxPage](https://github.com/ziguishian/MxPage)'s ecommerce image pipeline into the official DSH **`web`** profile:

**register photos → analyze selling points → plan hero/detail sections → Visual Prompt Agent → generate frames**

This is **not** a generic gallery. Community plugins such as `dsh-imagegen` / `image-generate` / `image_generate` register a one-shot `generate_image` (or similar) tool. **dsh-mxpage does not.** Every tool is named `mxpage_*`. The model must walk **analyze → plan → VPA → section generate** so a product photo becomes a coherent detail-page set, not a pile of unrelated images.

Verified against **`@deepseek-ai/dsh@0.1.5-rc.1`**. Requires the official **`web`** profile (not `sdk-minimal`).

**Not an official DeepSeek product.** Not affiliated with DeepSeek AI. MxPage prompts/schemas remain MIT (灵矩绘境); see [NOTICE](./NOTICE).

## Paid Images API — read this first

Generation and edit tools call an **OpenAI-compatible Images API** (`/v1/images/generations`, `/v1/images/edits`). That API is **paid**. Each `mxpage_generate_section`, `mxpage_generate_page`, and `mxpage_edit_section` consumes quota. The ecommerce skill will remind the model to warn you before a whole-page job.

Set the key in the environment only:

```sh
export MXPAGE_IMAGE_API_KEY=sk-...   # example — use your real key locally, never paste it here
```

**Never** put the key in chat, git, `cordis.patch.yml`, tool arguments, browser storage, or session events. The plugin reads `process.env[config.imageApiKeyEnv]` (default env **name**: `MXPAGE_IMAGE_API_KEY`). Logs and tool output redact `sk-` / `Bearer` tokens.

## Install

Must target the **`web`** profile:

```sh
dsh plugin --profile web add <path-or-spec>
```

Examples:

```sh
# GitHub spec
dsh plugin --profile web add github:kim1232aa/dsh-mxpage

# Local path (this workspace)
dsh plugin --profile web add /workspace/dsh-plugins/dsh-mxpage

# Built tarball
dsh plugin --profile web add ./dsh-mxpage-0.1.0.tgz
```

Then set `MXPAGE_IMAGE_API_KEY` (see above). Restart the `web` profile so the new layer loads.

After add, `dsh --profile web --dump-config` must still show **all three** layers: `dsh-mxpage` **and** `@deepseek-ai/dsh-web-app` **and** `@deepseek-ai/dsh-base`. Do not switch the profile to `sdk-minimal`.

### Skills catalog (filesystem)

DSH's official web catalog scans **`$DSH_HOME/skills`**, not the package's `skills/` directory. After `plugin add`, copy the packaged skills so the catalog sees them (this is not a DSH source patch):

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills"
cp -R skills/mxpage-ecommerce-page \
      skills/mxpage-xiaohongshu \
      skills/mxpage-batch-sku \
      "${DSH_HOME:-$HOME/.dsh}/skills/"
```

## Chat example

Attach a product photo (or point at a workspace path) and say:

> 根据这张商品图出一套淘宝详情页

Expected: the agent runs create → analyze → plan → generate, and you get **≥1 hero + ≥3 detail** images as session attachments **and** workspace files under `$DSH_HOME/mxpage/projects/<id>/`.

## Tools (`mxpage_*` only)

No `generate_image` / `image_generate` / `image-generate`.

| Tool | Role |
|------|------|
| `mxpage_create_project` | Create a project and copy (not move) 1–10 product photos into `assets/` |
| `mxpage_add_asset` | Append a photo; replacing the main image requires explicit `role=main` |
| `mxpage_project_status` | Read-only state machine / sections / job |
| `mxpage_analyze_product` | Vision analysis → `analysis.json` |
| `mxpage_plan_page` | Hero/detail plan + style guide (refuses if not analyzed) |
| `mxpage_refine_prompt` | Visual Prompt Agent for one section |
| `mxpage_generate_section` | Generate one frame; runs VPA unless `prompt_override` is set |
| `mxpage_generate_page` | Orchestrate the whole page (default: background job) |
| `mxpage_edit_section` | `repaint` / `enhance` / `translate` (new version; never overwrites) |
| `mxpage_job_status` | Poll a page job |
| `mxpage_job_cancel` | Cancel a running job; completed sections stay on disk |
| `mxpage_export_page` | List output paths or write `output/export-<iso>.zip` |

Forced order: **create → analyze → plan → generate**. Detail frames are anchored on the original main photo plus the first successful hero.

## Skills (shipped in the package)

| Skill | When |
|-------|------|
| `mxpage-ecommerce-page` | Taobao / Tmall / JD / Shopee hero + detail pages |
| `mxpage-xiaohongshu` | Xiaohongshu four-step: plan → confirm VPA prompt → generate → edit |
| `mxpage-batch-sku` | One project per SKU; never mix reference images |

## Config (host, not the browser)

Schemastery `Config` on the plugin. Defaults that matter:

| Field | Default |
|-------|---------|
| `imageBaseUrl` | `https://api.openai.com/v1` |
| `imageApiKeyEnv` | `MXPAGE_IMAGE_API_KEY` (env **name**, not the key) |
| `imageModel` | `gpt-image-2` |
| `defaultLanguage` | `zh-CN` |
| `defaultHeroCount` | `3` |
| `defaultDetailCount` | `6` |
| `allowSvgFallback` | `false` (SVG fallback is **not** implemented) |
| `generateAsJob` | `true` |

Analyze / plan / VPA use `ctx.llm` when the web profile provides vision, or optional `textBaseUrl` + `textApiKeyEnv` + `textModel`. Image gen always uses the Images API — never the chat adapter.

Workspace default: `$DSH_HOME/mxpage/projects/<projectId>/`. Override with `workspaceDir`.

## Non-goals

- **No** Next.js App Router / Electron / Prisma port. This is a Cordis ESM bundle, not a standalone app.
- **No** `generate_image` tool (avoids colliding with community gallery plugins).
- **No** API key in the browser, chat, git, or tool args.
- **No** `dsh.client` Studio panel in this release (official attachment preview is enough).
- **No** SVG fallback. Failed gens return a mapped error (`401` / quota / timeout / abort).
- **No** DSH source patches. Profile stays `web`.

## Develop

```sh
npm test
npm run build   # writes prebuilt index.js (committed; GitHub installs do not need prepare)
```

`peerDependencies` are `"*"`. The host `web` profile provides `@deepseek-ai/cordis`, `dsh-tools`, `dsh-jobs`, `dsh-llm`, `schemastery`. `devDependencies` `file:` paths point at this workspace's `dsh-runtime` so `npm test` type-strips against the same copies; a GitHub-only clone does not need them for `dsh plugin add` as long as `index.js` is present.

Do not add `@deepseek-ai/dsh` to an application `package.json`.

## License

MIT. MxPage prompts, schemas, and pipeline logic are MIT (灵矩绘境); see [NOTICE](./NOTICE) and [LICENSE](./LICENSE).

Topics: `dsh-plugin` · `dsh` · `deepseek-harness`
