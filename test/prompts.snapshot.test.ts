import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProductAnalysisPrompt, buildProductAnalysisRepairPrompt } from '../src/prompts/analysis.ts'
import { buildSectionImagePrompt, buildImageEditPrompt, buildRegenerationPrompt } from '../src/prompts/generation.ts'
import { buildSectionPlanningPrompt, buildVisualStyleGuidePrompt } from '../src/prompts/planning.ts'
import { buildVisualPromptAgentPrompt } from '../src/prompts/visual-prompt-agent.ts'
import { VALID_ANALYSIS } from './fixtures.ts'

function corpus(): string {
  const analysis = {
    ...VALID_ANALYSIS,
    additionalInformation: VALID_ANALYSIS.additionalInformation,
    generationRequirements: VALID_ANALYSIS.generationRequirements,
  }
  const section = {
    type: 'hero',
    title: '主视觉',
    goal: '第一眼吸引力',
    copy: '核心卖点',
    visualPrompt: 'Primary Prompt: 商品居中\nEnglish Prompt: product centered',
  }
  return [
    buildProductAnalysisPrompt([{ role: 'main', isMain: true }]),
    buildProductAnalysisRepairPrompt('{broken'),
    buildSectionPlanningPrompt(analysis, {
      style: 'premium',
      platform: 'ecommerce',
      heroCount: 3,
      detailCount: 6,
      language: 'zh-CN',
    }),
    buildVisualStyleGuidePrompt(analysis, { style: 'premium', platform: 'ecommerce', language: 'zh-CN' }),
    buildVisualPromptAgentPrompt({
      mode: 'ecommerce_section',
      title: section.title,
      goal: section.goal,
      copy: section.copy,
      basePrompt: section.visualPrompt,
      aspectRatio: '1:1',
      contentLanguage: 'zh-CN',
    }),
    buildSectionImagePrompt(section, [{ role: 'main', isMain: true }], '1:1', 'zh-CN'),
    buildRegenerationPrompt(section, [], '1:1', 'zh-CN'),
    buildImageEditPrompt(section, [], 'repaint', '1:1', 'zh-CN'),
  ].join('\n')
}

test('physical-realism constraints present and product name MxPage absent', () => {
  const text = corpus()
  assert.match(text, /几何不可反转/)
  assert.match(text, /禁止逆风/)
  assert.match(text, /主体与参考图一致/)
  assert.match(text, /避免乱码文字/)
  assert.doesNotMatch(text, /MxPage/)
})
