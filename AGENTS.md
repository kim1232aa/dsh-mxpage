# dsh-mxpage implementer constraints

Read docs/guides/dsh-plugin-spec-investigation.md and docs/guides/mxpage-tool-contracts.md before writing code.

Hard rules:

- Export `name` + `apply`. Never `export default function apply`.
- `inject` is `['tools', 'attachments', 'jobs']` (string array).
- `Config` is a Schemastery schema (interface + const).
- `package.json` has `dsh.bundle.patch`. Prebuilt `index.js`.
- Tools are `mxpage_*` only. Never `generate_image` / `image_generate`.
- Optional params omit `required`. Object output schemas set `additionalProperties`.
- `render` is pure text-only. Images: `saveImage({ data, mediaType, name })`, return `attachmentId`.
- Jobs: `start({ kind: 'mxpage_page', label, owner, run: () => JobHooks })`. Merge `JobKindMap`. `run()` is sync. Do not start if `exec.signal.aborted`.
- Secrets from `MXPAGE_IMAGE_API_KEY` only. Redact `sk-` / Bearer.
- Path-normalize writes; reject `..`.
- Do not port Next.js / Electron / Prisma. No `dsh.client` in P0–P3.
- Keep NOTICE / MIT attribution for MxPage.
