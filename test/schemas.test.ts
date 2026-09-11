import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProductAnalysis } from '../src/schemas/product-analysis.ts'
import { parseSectionPlan, SECTION_TYPES } from '../src/schemas/section-plan.ts'
import { parseVisualPrompt } from '../src/schemas/visual-prompt.ts'
import { VALID_ANALYSIS } from './fixtures.ts'

test('valid analysis fixture parses and strips extra fields', () => {
  const parsed = parseProductAnalysis({ ...VALID_ANALYSIS, extra: 'drop me', leftover: 1 })
  assert.equal(parsed.productName, '三阶磁力魔方')
  assert.equal(parsed.category, '益智玩具')
  assert.deepEqual(parsed.styleTags, ['竞速', '磁力'])
  assert.equal(parsed.suggestedSectionPlan[0]?.type, 'hero')
  assert.equal('extra' in parsed, false)
  assert.equal('leftover' in parsed, false)
})

test('missing productName fails', () => {
  const { productName: _drop, ...rest } = VALID_ANALYSIS
  assert.throws(() => parseProductAnalysis(rest), /productName/)
  assert.throws(() => parseProductAnalysis({ ...VALID_ANALYSIS, productName: '' }), /productName/)
  assert.throws(() => parseProductAnalysis({ ...VALID_ANALYSIS, productName: '   ' }), /productName/)
})

test('analysis defaults blank optional strings', () => {
  const { additionalInformation: _a, generationRequirements: _g, ...rest } = VALID_ANALYSIS
  const parsed = parseProductAnalysis(rest)
  assert.equal(parsed.additionalInformation, '')
  assert.equal(parsed.generationRequirements, '')
})

test('section plan closed set and extra fields stripped', () => {
  const parsed = parseSectionPlan({
    visualStyleGuide: {
      styleName: '清爽电商',
      colorPalette: '白+商品本色',
      extraGuide: 'nope',
    },
    sections: [
      {
        id: 'hero_01',
        type: 'hero',
        title: '主视觉',
        goal: '第一眼',
        copy: '核心卖点',
        visualPrompt: 'Primary Prompt: x\nEnglish Prompt: y',
        leftover: true,
      },
      {
        type: 'not_a_real_type',
        title: '自定义',
        goal: '兜底',
        copy: 'copy',
        visualPrompt: 'prompt',
      },
    ],
    extra: 1,
  })
  assert.equal('extra' in parsed, false)
  assert.equal(parsed.visualStyleGuide.styleName, '清爽电商')
  assert.equal('extraGuide' in parsed.visualStyleGuide, false)
  assert.equal(parsed.sections[0]?.type, 'hero')
  assert.equal('leftover' in parsed.sections[0]!, false)
  assert.equal(parsed.sections[1]?.type, 'custom')
  for (const type of SECTION_TYPES) {
    assert.equal(typeof type, 'string')
  }
})

test('visual prompt requires finalPrompt min 20 chars', () => {
  const parsed = parseVisualPrompt({
    analysisSummary: '策略',
    finalPrompt: 'A'.repeat(20),
    negativePrompt: '乱码',
    qualityChecklist: ['清晰'],
    extra: true,
  })
  assert.equal(parsed.finalPrompt.length, 20)
  assert.equal('extra' in parsed, false)
  assert.throws(() => parseVisualPrompt({ finalPrompt: 'too short' }), /finalPrompt/)
})
