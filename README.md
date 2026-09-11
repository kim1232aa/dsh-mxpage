# dsh-mxpage

English | [简体中文](./README.zh-CN.md)

**DeepSeek Harness plugin** that ports [MxPage](https://github.com/ziguishian/MxPage)'s ecommerce image pipeline:

**register photos → analyze selling points → plan hero/detail sections → Visual Prompt Agent → generate frames**

Not another generic `generate_image`. Tools are named `mxpage_*`. Requires the official DSH **`web`** profile (not `sdk-minimal`).

Status: **docs complete, implementation in progress.** Verified against `@deepseek-ai/dsh@0.1.5-rc.1`.

## Docs

| Doc | What |
|-----|------|
| [docs/requirements.md](docs/requirements.md) | Original requirements |
| [docs/guides/dsh-plugin-spec-investigation.md](docs/guides/dsh-plugin-spec-investigation.md) | DSH plugin spec investigation (runtime d.ts) |
| [docs/guides/mxpage-tool-contracts.md](docs/guides/mxpage-tool-contracts.md) | Full `mxpage_*` contracts |
| [docs/superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md](docs/superpowers/specs/2026-09-12-dsh-mxpage-plugin-design.md) | Design spec |
| [docs/superpowers/plans/2026-09-12-dsh-mxpage-plugin.md](docs/superpowers/plans/2026-09-12-dsh-mxpage-plugin.md) | Implementation plan |
| [docs/guides/skill-drafts/](docs/guides/skill-drafts/) | Skill drafts |

## Install (after P0)

```sh
dsh plugin --profile web add github:kim1232aa/dsh-mxpage
# or a built tarball:
# dsh plugin --profile web add ./dsh-mxpage-0.1.0.tgz
```

Set `MXPAGE_IMAGE_API_KEY`. Never put keys in `cordis.patch.yml` or chat.

## License

MIT. MxPage prompts/schemas are MIT (灵矩绘境); see [NOTICE](./NOTICE). **Not** an official DeepSeek product.

Topics: `dsh-plugin` · `dsh` · `deepseek-harness`
