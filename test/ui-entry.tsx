/**
 * SSR harness for the panel views (built by tsdown into lib/ui-test.mjs).
 *
 * Every view is rendered once with realistic mock data. Effects don't run
 * under SSR, so data-loading views get their data via initial-state props;
 * the point is to catch render-path crashes (undefined access, bad JSX
 * wiring) in the exact code the browser bundle ships.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ProjectDetailResponse } from '../src/client/api.ts'
import { AnalysisView } from '../src/client/views/analysis.tsx'
import { BatchView } from '../src/client/views/batch.tsx'
import { ChannelsView } from '../src/client/views/channels.tsx'
import { EditorView } from '../src/client/views/editor.tsx'
import { ExportView } from '../src/client/views/export.tsx'
import { MonitorView } from '../src/client/views/monitor.tsx'
import { PlannerView } from '../src/client/views/planner.tsx'
import { XiaohongshuView } from '../src/client/views/xiaohongshu.tsx'

const noopAsync = async () => {}

const mockDetail: ProjectDetailResponse = {
  project: {
    id: 'p1',
    name: '测试保温杯',
    status: 'generated',
    platform: 'taobao_tmall',
    style: 'premium',
    modelSnapshot: {
      previewConfig: {
        heroImageCount: 2,
        detailSectionCount: 2,
        imageAspectRatio: '3:4',
        contentLanguage: 'zh-CN',
      },
      visualStyleGuide: { styleName: '暖白极简', colorPalette: '暖白+深灰' },
    },
  },
  analysis: {
    productName: '保温杯',
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
    additionalInformation: '容量 500ml',
    generationRequirements: '多角度展示',
  },
  coverImageUrl: '/img/main.png',
  assets: [
    { id: 'a1', type: 'MAIN', fileName: 'main.png', isMain: true, sortOrder: 0, url: '/img/main.png' },
    { id: 'a2', type: 'REFERENCE', fileName: 'angle.png', isMain: false, sortOrder: 1, url: '/img/angle.png' },
  ],
  sections: [
    {
      id: 's1',
      sectionKey: 'hero_1',
      type: 'HERO',
      title: '头图主视觉',
      goal: '第一眼吸引',
      copy: '文案',
      visualPrompt: 'prompt',
      order: 1,
      status: 'SUCCESS',
      editableData: null,
      imageUrl: '/img/s1.png',
      versions: [{ id: 'v1', versionNumber: 1, isActive: true, createdAt: '2026-09-13', imageUrl: '/img/s1.png' }],
    },
    {
      id: 's2',
      sectionKey: 'selling_points_2',
      type: 'SELLING_POINTS',
      title: '卖点模块',
      goal: '讲清优势',
      copy: '文案2',
      visualPrompt: 'prompt2',
      order: 2,
      status: 'IDLE',
      editableData: null,
      imageUrl: null,
      versions: [],
    },
  ],
}

const mockApi = {} as never

export function renderAllViews(): Record<string, string> {
  const run = async (_label: string, action: () => Promise<void>) => {
    await action()
  }
  return {
    analysis: renderToStaticMarkup(
      createElement(AnalysisView, {
        api: mockApi,
        detail: mockDetail,
        busy: null,
        run,
        reload: noopAsync,
        onDeleted: () => {},
      }),
    ),
    planner: renderToStaticMarkup(
      createElement(PlannerView, {
        api: mockApi,
        detail: mockDetail,
        busy: null,
        run,
        reload: noopAsync,
        onOpenEditor: () => {},
      }),
    ),
    editor: renderToStaticMarkup(
      createElement(EditorView, {
        api: mockApi,
        detail: mockDetail,
        busy: null,
        run,
        reload: noopAsync,
        selectedSectionId: 's1',
        onSelectSection: () => {},
      }),
    ),
    export: renderToStaticMarkup(
      createElement(ExportView, { api: mockApi, detail: mockDetail, busy: null, run }),
    ),
    xiaohongshu: renderToStaticMarkup(
      createElement(XiaohongshuView, { api: mockApi, busy: null, run }),
    ),
    batch: renderToStaticMarkup(
      createElement(BatchView, { api: mockApi, busy: null, run, onOpenProject: () => {} }),
    ),
    monitor: renderToStaticMarkup(createElement(MonitorView, { api: mockApi })),
    channels: renderToStaticMarkup(createElement(ChannelsView, { api: mockApi })),
  }
}
