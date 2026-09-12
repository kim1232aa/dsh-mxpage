/**
 * Xiaohongshu screen — the four-step carousel flow.
 *
 * Ported surface from upstream `components/xiaohongshu/xiaohongshu-flow.tsx`
 * (39 KB / 961 lines) + `xiaohongshu-flow-state.ts`.
 *
 * Upstream kept the draft in `localStorage` + IndexedDB because no server state
 * existed for XHS output. Here the draft lives in React state for the session
 * and the generated images are surfaced as data URLs, matching the service,
 * which never persists XHS output either.
 */

import { useState } from 'react'

import type { MxpageApi, XiaohongshuPage, XiaohongshuPlan } from '../api.ts'
import { Badge, Button, Field, Notice, styles, T } from '../ui.tsx'

const ASPECTS = ['3:4', '1:1', '9:16'] as const

type Step = 1 | 2 | 3 | 4

export function XiaohongshuView(props: {
  api: MxpageApi
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
}) {
  const { api, busy, run } = props

  const [step, setStep] = useState<Step>(1)
  const [topic, setTopic] = useState('')
  const [imageCount, setImageCount] = useState(5)
  const [aspect, setAspect] = useState<string>('3:4')
  const [plan, setPlan] = useState<XiaohongshuPlan | null>(null)
  const [pages, setPages] = useState<XiaohongshuPage[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<XiaohongshuPage | null>(null)
  const [editPrompt, setEditPrompt] = useState('')

  const doPlan = () =>
    run('xhs-plan', async () => {
      const result = await api.xhsPlan(topic, imageCount, aspect)
      setPlan(result.plan)
      setNote(`已规划 ${result.plan.pages?.length ?? 0} 页，请逐页确认 imagePrompt。`)
      setStep(2)
    })

  const doGenerate = () =>
    run('xhs-generate', async () => {
      if (!plan) return
      const result = await api.xhsGenerate(plan, aspect)
      setPages(result.pages)
      setNote(`已生成 ${result.pages.length} 页。`)
      setStep(4)
    })

  const doEdit = () =>
    run('xhs-edit', async () => {
      if (!editTarget || !editPrompt.trim()) return
      const result = await api.xhsEdit(editTarget.imageUrl, editPrompt, aspect)
      setPages((current) =>
        current.map((page) =>
          page.pageNumber === editTarget.pageNumber
            ? { ...page, imageUrl: result.edited.imageUrl }
            : page,
        ),
      )
      setEditTarget(null)
      setEditPrompt('')
      setNote(`第 ${editTarget.pageNumber} 页已修改。`)
    })

  const setPagePrompt = (pageNumber: number, value: string) => {
    setPlan((current) => {
      if (!current) return current
      return {
        ...current,
        pages: current.pages.map((page) =>
          page.pageNumber === pageNumber ? { ...page, imagePrompt: value } : page,
        ),
      }
    })
  }

  return (
    <div>
      <div style={{ ...styles.row, marginBottom: 14 }}>
        {([1, 2, 3, 4] as Step[]).map((value) => (
          <Button
            key={value}
            variant="ghost"
            active={step === value}
            onClick={() => setStep(value)}
          >
            {value === 1 ? '① 规划' : value === 2 ? '② 审阅' : value === 3 ? '③ 生成' : '④ 改图'}
          </Button>
        ))}
        <span style={{ color: T.muted, fontSize: 12, marginLeft: 'auto' }}>
          小红书链路不落盘、不建项目，图只以引用形式返回
        </span>
      </div>

      {note ? <Notice kind="info">{note}</Notice> : null}

      {step === 1 ? (
        <div style={styles.card}>
          <Field label="选题 / 商品角度">
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="例如：秋冬通勤保温杯怎么选"
              style={styles.input}
            />
          </Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="页数 (3–8)" style={{ width: 120 }}>
              <input
                type="number"
                min={3}
                max={8}
                value={imageCount}
                onChange={(event) => setImageCount(Number(event.target.value))}
                style={styles.input}
              />
            </Field>
            <Field label="画幅" style={{ width: 120 }}>
              <select value={aspect} onChange={(event) => setAspect(event.target.value)} style={styles.input}>
                {ASPECTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button variant="primary" disabled={!topic.trim() || busy !== null} onClick={doPlan}>
            {busy === 'xhs-plan' ? '规划中…' : '开始规划'}
          </Button>
          <div style={{ color: T.muted, fontSize: 12, marginTop: 8 }}>
            模型不可用时会自动回退到完全本地的中文模板方案，仍然可用。
          </div>
        </div>
      ) : null}

      {step === 2 && plan ? (
        <div style={styles.card}>
          <strong>审阅每页的 imagePrompt</strong>
          <div style={{ color: T.muted, fontSize: 12, margin: '4px 0 12px' }}>
            改完再生成。这一步不消耗额度。
          </div>
          <div style={{ display: 'grid', gap: 12 }}>
            {plan.pages.map((page) => (
              <div key={page.pageNumber} style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: 10 }}>
                <div style={{ ...styles.row, marginBottom: 6 }}>
                  <Badge>第 {page.pageNumber} 页</Badge>
                  <strong>{String(page.title ?? '')}</strong>
                </div>
                {page.body ? (
                  <div style={{ color: T.muted, fontSize: 12, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                    {String(page.body)}
                  </div>
                ) : null}
                <textarea
                  rows={4}
                  value={String(page.imagePrompt ?? '')}
                  onChange={(event) => setPagePrompt(page.pageNumber, event.target.value)}
                  style={{ ...styles.input, resize: 'vertical', ...styles.mono }}
                />
              </div>
            ))}
          </div>
          <div style={{ ...styles.row, marginTop: 12 }}>
            <Button variant="primary" disabled={busy !== null} onClick={() => setStep(3)}>
              确认，进入生成
            </Button>
            <Button variant="ghost" onClick={() => setStep(1)}>
              返回重来
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div style={styles.card}>
          <strong>生成整组图</strong>
          <Notice kind="info">
            每页都会先跑 Visual Prompt Agent。**消耗付费图像额度** —— 确认后再开始。
          </Notice>
          <div style={{ ...styles.row }}>
            <Button variant="primary" disabled={!plan || busy !== null} onClick={doGenerate}>
              {busy === 'xhs-generate' ? '生成中…' : `生成 ${plan?.pages.length ?? 0} 页`}
            </Button>
            <Button variant="ghost" onClick={() => setStep(2)}>
              返回审阅
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div style={styles.card}>
          <strong>成品与改图（{pages.length} 页）</strong>
          {pages.length === 0 ? (
            <div style={{ color: T.muted, fontSize: 12, marginTop: 8 }}>还没有成品，先走第 ③ 步。</div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: 12,
                marginTop: 12,
              }}
            >
              {pages.map((page) => (
                <div key={page.pageNumber} style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: 6 }}>
                  <img
                    src={page.imageUrl}
                    alt={page.title}
                    style={{ width: '100%', borderRadius: 4, display: 'block', background: T.bg }}
                  />
                  <div style={{ fontSize: 11, marginTop: 6, color: T.muted }}>
                    第 {page.pageNumber} 页 · {page.model}
                  </div>
                  <div style={{ ...styles.row, marginTop: 6 }}>
                    <Button
                      onClick={() => {
                        setEditTarget(page)
                        setEditPrompt('')
                      }}
                    >
                      改图
                    </Button>
                    <a
                      href={page.imageUrl}
                      download={`xiaohongshu-${page.pageNumber}.png`}
                      style={{ color: T.accent, fontSize: 12 }}
                    >
                      下载
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {editTarget ? (
        <div style={{ ...styles.card, marginTop: 14 }}>
          <strong>改第 {editTarget.pageNumber} 页</strong>
          <Field label="要改什么" hint="例如：把标题改成「一杯顶三杯」，配色换成暖橙">
            <textarea
              rows={3}
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              style={{ ...styles.input, resize: 'vertical' }}
            />
          </Field>
          <div style={styles.row}>
            <Button variant="primary" disabled={!editPrompt.trim() || busy !== null} onClick={doEdit}>
              {busy === 'xhs-edit' ? '修改中…' : '提交修改'}
            </Button>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
