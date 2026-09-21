/**
 * Post-generation verification is read-only. Geometry alone cannot distinguish
 * intentional composition from a defect or authorize overriding requested sizes.
 * Requested repairs/polish run in the main agent with the user's full scope.
 */
import { getProviderAdapter, modelLacksVision, type AiSettings } from '@genoffice/ai-provider'
import { auditSlideLayout } from './layout-audit'
import type { DeckAccess } from './slides-skill'

/** Kill switch: localStorage 'ai-slides-qc' = '0' disables the automatic check. */
export function isQcEnabled(): boolean {
  return localStorage.getItem('ai-slides-qc') !== '0'
}

export const QC_MAX_PAGES = 20

/** Used by explicitly requested visual edits, not automatic mutation passes. */
export function settingsSupportVision(settings: Pick<AiSettings, 'provider' | 'providers'>): boolean {
  try {
    if (!getProviderAdapter(settings.provider).capabilities.vision) return false
    return !modelLacksVision(settings.providers?.[settings.provider]?.model ?? '')
  } catch {
    return false
  }
}

export function generatedPageRange(
  mode: 'replace' | 'append' | 'insert_at' | 'replace_at',
  r: { pages?: number; appendedFrom?: number; insertedIndex?: number },
): number[] {
  const total = r.pages ?? 0
  switch (mode) {
    case 'replace': return Array.from({ length: total }, (_, i) => i)
    case 'append': {
      const from = r.appendedFrom ?? 0
      return Array.from({ length: Math.max(0, total - from) }, (_, i) => from + i)
    }
    case 'insert_at':
    case 'replace_at': return typeof r.insertedIndex === 'number' ? [r.insertedIndex] : []
  }
}

/** Keep indexes stable as pages are appended/replaced/inserted during a run. */
export function mergeQcPages(
  prev: number[],
  mode: 'replace' | 'append' | 'insert_at' | 'replace_at',
  r: { pages?: number; appendedFrom?: number; insertedIndex?: number },
): number[] {
  const range = generatedPageRange(mode, r)
  const sortDedupe = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b)
  switch (mode) {
    case 'replace': return range
    case 'append':
    case 'replace_at': return sortDedupe([...prev, ...range])
    case 'insert_at': {
      const at = r.insertedIndex
      if (typeof at !== 'number') return prev
      return sortDedupe([...prev.map((p) => (p >= at ? p + 1 : p)), at])
    }
  }
}

export interface QcPageResult {
  ok: boolean
  /** Automatic verification never has mutation authority. */
  edited: false
  reply: string
  preIssues: number
  postIssues: number
  findings: string[]
  error?: string
}

export interface QcPageOptions {
  access: Pick<DeckAccess, 'getSlides'>
  pageIndex: number
  signal?: AbortSignal
}

/** No model, editor handle, transaction or tool executor is available here. */
export async function qcSlidePage({ access, pageIndex, signal }: QcPageOptions): Promise<QcPageResult> {
  if (signal?.aborted) return { ok: false, edited: false, reply: '', preIssues: 0, postIssues: 0, findings: [], error: 'Cancelled' }
  const slide = access.getSlides()[pageIndex]
  if (!slide) return { ok: false, edited: false, reply: '', preIssues: 0, postIssues: 0, findings: [], error: `slideIndex ${pageIndex} out of range` }
  const findings = auditSlideLayout(slide)
  return {
    ok: true, edited: false,
    reply: findings.length ? `${findings.length} advisory layout finding(s); requested formatting preserved.` : 'OK',
    preIssues: findings.length, postIssues: findings.length, findings,
  }
}
