import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(root, 'skills', 'mxpage-ecommerce-page')
const skillPath = join(skillDir, 'SKILL.md')

/**
 * NOTE: the v0.1 version of this regex required bare `\n`, so it rejected every
 * SKILL.md checked out with CRLF line endings on Windows. Line endings are
 * normalized before matching now.
 */
function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const text = raw.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  assert.ok(match, 'SKILL.md must have YAML frontmatter')
  const yaml = match[1]!
  const body = match[2]!
  const name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(yaml)?.[1]?.trim()
  return { name, description, body }
}

function loadSkill(dirName: string) {
  const path = join(root, 'skills', dirName, 'SKILL.md')
  assert.ok(existsSync(path), `skills/${dirName}/SKILL.md missing`)
  return parseFrontmatter(readFileSync(path, 'utf8'))
}

/**
 * Parameter and field names that legitimately appear in backticks alongside tool
 * names. Anything else containing an underscore must be an `mxpage_*` tool, so a
 * stray `generate_image` still fails the check.
 */
const PARAM_IDENTIFIERS = new Set([
  'attachment_id',
  'attachment_ids',
  'image_path',
  'image_paths',
  'reference_image_paths',
  'section_id',
  'section_ids',
  'project_id',
  'job_id',
  'plan_json',
  'prompt_override',
  'target_language',
  'reference_asset_ids',
  'image_count',
  'aspect_ratio',
  'hero_count',
  'detail_count',
  'auto_decide_counts',
  'mxpage_ecommerce_page',
  'mxpage_xiaohongshu',
  'mxpage_batch_sku',
])

/**
 * The skills legitimately *name* the community image tools in order to forbid
 * them ("不要用 `generate_image`"). A bare `doesNotMatch` therefore produced a
 * false failure, so an occurrence only fails when it is not negated nearby.
 */
function assertNoToolEndorsement(body: string) {
  const forbidden = /generate_image|image_generate/g
  for (const match of body.matchAll(forbidden)) {
    const lookBehind = body.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0)
    const negated = /不要|禁止|别用|never|not\s+use/i.test(lookBehind)
    assert.ok(negated, `skill must not endorse ${match[0]} (context: "${lookBehind}${match[0]}")`)
  }
}

function assertMxpageToolsOnly(body: string) {
  assertNoToolEndorsement(body)
  const mentions = body.match(/`[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*`/g) ?? []
  for (const raw of mentions) {
    const inner = raw.slice(1, -1)
    for (const part of inner.split('/')) {
      if (!part.includes('_')) continue
      if (PARAM_IDENTIFIERS.has(part)) continue
      // `generate_image` / `image_generate` were already handled above.
      if (part === 'generate_image' || part === 'image_generate') continue
      assert.match(part, /^mxpage_/, `non-mxpage tool mentioned: ${part}`)
    }
  }
}

test('package.json ships skills and the built lib/', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }
  assert.ok(pkg.files.includes('skills'))
  assert.ok(pkg.files.includes('lib'))
})

test('ecommerce skill sits next to the built bundle', () => {
  assert.ok(existsSync(join(root, 'lib', 'index.js')), 'lib/index.js missing — run `npm run build`')
  assert.ok(existsSync(skillPath), 'skills/mxpage-ecommerce-page/SKILL.md missing')
})

test('ships kebab-case ecommerce, xiaohongshu, and batch-sku skills', () => {
  assert.ok(existsSync(join(root, 'skills')))
  const names = readdirSync(join(root, 'skills')).sort()
  assert.deepEqual(names, ['mxpage-batch-sku', 'mxpage-ecommerce-page', 'mxpage-xiaohongshu'])
  for (const dir of names) {
    const { name, description } = loadSkill(dir)
    assert.equal(name, dir)
    assert.match(name!, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(description, `${dir} description required for DSH catalog`)
  }
})

test('skill frontmatter is kebab-case with Chinese catalog triggers', () => {
  const { name, description } = parseFrontmatter(readFileSync(skillPath, 'utf8'))
  assert.equal(name, 'mxpage-ecommerce-page')
  assert.ok(description, 'description required for DSH catalog')
  for (const trigger of ['电商头图', '详情页', '淘宝', '天猫', '京东', 'Shopee']) {
    assert.ok(description!.includes(trigger), `description missing trigger: ${trigger}`)
  }
})

test('ecommerce skill covers the forced order, anchoring, quota warning and channel diagnosis', () => {
  const { body } = parseFrontmatter(readFileSync(skillPath, 'utf8'))
  // forced order
  assert.match(body, /mxpage_create_project/)
  assert.match(body, /mxpage_analyze_product/)
  assert.match(body, /mxpage_plan_page/)
  // generation, both whole-page and per-section
  assert.match(body, /mxpage_generate_page/)
  assert.match(body, /mxpage_generate_section/)
  assert.match(body, /mxpage_edit_section/)
  assert.match(body, /mxpage_export_page/)
  // job handling: never busy-poll
  assert.match(body, /mxpage_job_status/)
  assert.match(body, /mxpage_job_cancel/)
  // anchoring + stop-on-error
  assert.match(body, /主图/)
  assert.match(body, /hero/)
  assert.match(body, /401/)
  assert.match(body, /额度/)
  assert.match(body, /无视觉/)
  // v0.2: channels replaced the MXPAGE_IMAGE_API_KEY env var
  assert.match(body, /渠道/)
  assert.match(body, /mxpage_channels/)
  assert.doesNotMatch(body, /MXPAGE_IMAGE_API_KEY/)
  // guardrails
  assert.match(body, /文件名/)
  assert.match(body, /bash/)
  assertMxpageToolsOnly(body)
})

test('xiaohongshu skill drives the four-step flow with its own tools', () => {
  const { name, body } = loadSkill('mxpage-xiaohongshu')
  assert.equal(name, 'mxpage-xiaohongshu')
  assert.match(body, /3:4/)
  assert.match(body, /mxpage_xiaohongshu_plan/)
  assert.match(body, /mxpage_xiaohongshu_generate/)
  assert.match(body, /mxpage_xiaohongshu_edit/)
  assert.match(body, /Visual Prompt Agent/)
  assertMxpageToolsOnly(body)
})

test('batch-sku skill is one project per SKU', () => {
  const { name, body } = loadSkill('mxpage-batch-sku')
  assert.equal(name, 'mxpage-batch-sku')
  assert.match(body, /每个商品一个独立 `mxpage_create_project`/)
  assert.match(body, /不要跨 project/)
  assert.match(body, /mxpage_export_page/)
  assert.match(body, /maxParallelProjects/)
  assert.match(body, /mxpage_job_cancel/)
  assertMxpageToolsOnly(body)
})
