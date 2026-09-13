/**
 * Host-side usage ledger access.
 *
 * The Logger port's `usage(event)` appends JSONL to `<storeRoot>/usage.jsonl`
 * (see `src/host/logger.ts`). This module is the read/delete half behind the
 * panel's 监控 tab — upstream served the same data from
 * `lib/monitor/api-usage.ts` + `/api/monitor/usage`.
 *
 * Ids: ledger lines carry no id, so one is derived from a stable hash of the
 * raw line. That makes "delete this entry" reproducible across reads without
 * changing the logger's write format.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { normalizeLedgerEntry, type MonitorEntry } from '../core/monitor/api-usage.ts'

function ledgerPath(storeRoot: string): string {
  return path.join(storeRoot, 'usage.jsonl')
}

function lineId(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 16)
}

/** Reads the ledger newest-first. Corrupt lines are skipped, not fatal. */
export async function readUsageEntries(storeRoot: string, limit = 1000): Promise<MonitorEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(ledgerPath(storeRoot), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const entries: MonitorEntry[] = []
  for (const line of lines.slice(-limit).reverse()) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = normalizeLedgerEntry(parsed, lineId(line))
    if (entry) entries.push(entry)
  }
  return entries
}

export async function clearUsageEntries(storeRoot: string): Promise<{ cleared: boolean }> {
  try {
    await fs.rm(ledgerPath(storeRoot), { force: true })
    return { cleared: true }
  } catch {
    return { cleared: false }
  }
}

export async function deleteUsageEntry(
  storeRoot: string,
  entryId: string,
): Promise<{ deleted: boolean }> {
  const id = entryId.trim()
  if (!id) return { deleted: false }
  let raw: string
  try {
    raw = await fs.readFile(ledgerPath(storeRoot), 'utf8')
  } catch {
    return { deleted: false }
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const kept = lines.filter((line) => lineId(line) !== id)
  if (kept.length === lines.length) return { deleted: false }
  await fs.writeFile(ledgerPath(storeRoot), kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
  return { deleted: true }
}
