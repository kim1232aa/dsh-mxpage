import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(root, 'skills', 'mxpage-ecommerce-page')
const skillPath = join(skillDir, 'SKILL.md')

function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
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

function assertMxpageToolsOnly(body: string, extraAllowed: string[] = []) {
  assert.doesNotMatch(body, /generate_image|image_generate/)
  const allowed = new Set(extraAllowed)
  const mentions = body.match(/`[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*`/g) ?? []
  for (const raw of mentions) {
    const inner = raw.slice(1, -1)
    for (const part of inner.split('/')) {
      if (!part.includes('_')) continue
      if (allowed.has(part)) continue
      assert.match(part, /^mxpage_/, `non-mxpage tool mentioned: ${part}`)
    }
  }
}

test('package.json files includes skills next to index.js', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }
  assert.ok(pkg.files.includes('skills'))
  assert.ok(pkg.files.includes('index.js'))
})

test('ecommerce skill sits next to built index.js', () => {
  assert.ok(existsSync(join(root, 'index.js')), 'index.js missing')
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
  assert.match(name!, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(description, 'description required for DSH catalog')
  for (const trigger of ['电商头图', '详情页', '淘宝', '天猫', '京东', 'Shopee']) {
    assert.ok(description!.includes(trigger), `description missing trigger: ${trigger}`)
  }
})

test('skill body covers forced order, anchoring, stop-on-error, and generate_page quota', () => {
  const { body } = parseFrontmatter(readFileSync(skillPath, 'utf8'))
  assert.match(body, /mxpage_create_project/)
  assert.match(body, /mxpage_analyze_product/)
  assert.match(body, /mxpage_plan_page/)
  assert.match(body, /mxpage_generate_page/)
  assert.match(body, /mxpage_refine_prompt/)
  assert.match(body, /mxpage_generate_section/)
  assert.match(body, /主图/)
  assert.match(body, /hero/)
  assert.match(body, /401/)
  assert.match(body, /额度/)
  assert.match(body, /无视觉/)
  assert.match(body, /MXPAGE_IMAGE_API_KEY/)
  assert.match(body, /Config/)
  assert.match(body, /文件名/)
  assert.match(body, /bash/)
  assert.match(body, /配额/)
  assert.doesNotMatch(body, /几何不可反转/)
  assert.doesNotMatch(body, /禁止逆风/)
})

test('xiaohongshu skill uses 3:4 and xiaohongshu_page', () => {
  const { name, body } = loadSkill('mxpage-xiaohongshu')
  assert.equal(name, 'mxpage-xiaohongshu')
  assert.match(body, /3:4/)
  assert.match(body, /xiaohongshu_page/)
  assert.match(body, /mxpage_plan_page/)
  assert.match(body, /mxpage_refine_prompt/)
  assert.match(body, /mxpage_generate_section|mxpage_generate_page/)
  assert.match(body, /mxpage_edit_section/)
  assertMxpageToolsOnly(body, ['ask_user_question'])
})

test('batch-sku skill is one project per SKU', () => {
  const { name, body } = loadSkill('mxpage-batch-sku')
  assert.equal(name, 'mxpage-batch-sku')
  assert.match(body, /每个商品/)
  assert.match(body, /独立 `mxpage_create_project`/)
  assert.match(body, /不要跨 project/)
  assert.match(body, /mxpage_export_page/)
  assert.match(body, /maxParallelProjects/)
  assertMxpageToolsOnly(body)
})
