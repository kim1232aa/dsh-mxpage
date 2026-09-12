/**
 * Standalone OpenAI-compatible mock upstream for live plugin verification.
 *
 * Used by the headless-profile end-to-end run: a real DSH host, a real model
 * driving the real mxpage_* tools, against this fake provider. Keeps credentials
 * out of the loop entirely.
 *
 *   node scripts/mock-upstream.mjs [port]
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 8791)

/** 1×1 transparent PNG. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const calls = []
let sectionCounter = 0

function section(type) {
  sectionCounter += 1
  return {
    id: `s${sectionCounter}`,
    type,
    title: `分区 ${sectionCounter}`,
    goal: `目标 ${sectionCounter}`,
    copy: `文案 ${sectionCounter}`,
    visualPrompt: 'Primary Prompt: 主视觉\nEnglish Prompt: main visual',
    editableFields: { styleRole: 'role', sharedStyleAnchors: ['a'], localVariation: 'v' },
  }
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = req.url ?? ''
    const body = Buffer.concat(chunks).toString('utf8')
    calls.push(`${req.method} ${url}`)
    console.log(`[mock] ${req.method} ${url}`)

    const json = (payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    if (url.endsWith('/models')) {
      json({
        data: [
          { id: 'mock-vision', object: 'model' },
          { id: 'mock-image-1', object: 'model' },
        ],
      })
      return
    }

    if (url.endsWith('/chat/completions')) {
      let prompt = body
      try {
        const parsed = JSON.parse(body)
        prompt = (parsed.messages ?? [])
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
      } catch {
        /* keep raw */
      }

      const content = prompt.includes('Visual Prompt Agent')
        ? JSON.stringify({
            analysisSummary: 'mock vpa',
            finalPrompt:
              'A polished mobile commerce hero image of the product on a soft studio backdrop with a bold Chinese headline and two selling-point callouts.',
            negativePrompt: 'no garbled text',
            qualityChecklist: ['clear headline'],
          })
        : prompt.includes('mobile detail-page planner')
          ? JSON.stringify({
              visualStyleGuide: {
                styleName: 'mock 风格',
                colorPalette: '暖白 + 深灰',
                backgroundSystem: '统一浅色背景',
                lighting: '柔和棚拍光',
                cameraLanguage: '中焦段',
                typography: '黑体标题',
                layoutRules: '移动端安全边距',
                propRules: '少量道具',
                productRenderingRules: '保持商品一致',
                negativeStyleConstraints: '禁止跳变',
              },
              sections: [
                section('hero'),
                section('hero'),
                section('selling_points'),
                section('scenario'),
                section('detail_closeup'),
                section('specs'),
              ],
            })
          : prompt.includes('小红书') || prompt.includes('Xiaohongshu')
            ? JSON.stringify({
                topic: 'mock 选题',
                audience: '通勤人群',
                coreInsight: '省心',
                titleOptions: ['标题 A'],
                coverTitle: '封面标题',
                coverSubtitle: '封面副标题',
                pages: [1, 2, 3].map((n) => ({
                  pageNumber: n,
                  title: `第 ${n} 页`,
                  subtitle: `副标题 ${n}`,
                  body: `正文 ${n}`,
                  visualDirection: '清爽',
                  layout: '上图下文',
                  imagePrompt: `第 ${n} 页配图提示词，干净浅色背景，主体居中。`,
                  negativePrompt: '不要乱码',
                })),
                caption: '正文',
                hashtags: ['#通勤'],
                exportNote: 'mock',
              })
            : JSON.stringify({
                productName: '测试保温杯',
                category: '家居日用',
                subcategory: '杯壶',
                material: '304 不锈钢',
                color: '哑光白',
                styleTags: ['简约'],
                targetAudience: ['上班族'],
                usageScenarios: ['办公室'],
                coreSellingPoints: ['保温 12 小时'],
                differentiationPoints: ['轻量'],
                userConcerns: ['是否漏水'],
                recommendedFocusPoints: ['密封性'],
                additionalInformation: '容量 500ml；待用户补充重量。',
                generationRequirements: '多角度展示',
                suggestedSectionPlan: [
                  { type: 'hero', title: '头图', goal: '吸引' },
                  { type: 'selling_points', title: '卖点', goal: '讲清' },
                  { type: 'scenario', title: '场景', goal: '代入' },
                  { type: 'detail_closeup', title: '细节', goal: '做工' },
                  { type: 'specs', title: '规格', goal: '参数' },
                  { type: 'summary', title: '收口', goal: '转化' },
                ],
              })

      json({ choices: [{ message: { content } }] })
      return
    }

    if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
      json({ data: [{ b64_json: TINY_PNG_B64, revised_prompt: 'mock revised' }] })
      return
    }

    json({ error: { message: `unhandled ${url}` } })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}/v1`)
})
