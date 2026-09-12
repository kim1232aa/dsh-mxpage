/**
 * Host implementation of the Logger port.
 *
 * Upstream's `logApiUsage` wrote into an 18 KB in-app HTTP ledger
 * (`lib/monitor/api-usage.ts`) with request/response byte counts and a 23 KB
 * admin page. A DSH plugin has no such surface, so usage events are appended to
 * a JSONL file under the workspace (kept bounded) and mirrored to the plugin
 * console at debug level.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { Logger, UsageEvent } from '../core/ports/logger.ts'
import { redactSecrets } from '../util/redact.ts'

const MAX_LEDGER_BYTES = 2 * 1024 * 1024

function fmt(prefix: string, message: string, meta?: Record<string, unknown>): string {
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
  return redactSecrets(`[mxpage] ${prefix}${message}${suffix}`)
}

export interface FileLoggerOptions {
  /** Directory for `usage.jsonl`. Omit to disable the ledger. */
  ledgerDir?: string
  verbose?: boolean
}

export function createFileLogger(options: FileLoggerOptions = {}): Logger {
  const ledgerPath = options.ledgerDir
    ? path.join(options.ledgerDir, 'usage.jsonl')
    : null
  let ledgerBroken = false

  async function appendUsage(event: UsageEvent): Promise<void> {
    if (!ledgerPath || ledgerBroken) return
    try {
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
      const info = await fs.stat(ledgerPath).catch(() => null)
      if (info && info.size > MAX_LEDGER_BYTES) {
        // Truncate rather than rotate: this is a diagnostic aid, not an audit log.
        await fs.writeFile(ledgerPath, '', 'utf8')
      }
      const line = JSON.stringify({ at: new Date().toISOString(), ...event })
      await fs.appendFile(ledgerPath, `${redactSecrets(line)}\n`, 'utf8')
    } catch {
      ledgerBroken = true
    }
  }

  return {
    debug(message, meta) {
      if (options.verbose) console.debug(fmt('debug: ', message, meta))
    },
    info(message, meta) {
      console.log(fmt('', message, meta))
    },
    warn(message, meta) {
      console.warn(fmt('warn: ', message, meta))
    },
    error(message, meta) {
      console.error(fmt('error: ', message, meta))
    },
    usage(event) {
      if (options.verbose) {
        console.debug(
          fmt('usage: ', `${event.method ?? 'POST'} ${event.endpoint ?? '?'}`, {
            status: event.status,
            ok: event.ok,
            model: event.model,
            ms: event.durationMs,
            attempts: event.attemptCount,
          }),
        )
      }
      void appendUsage(event)
    },
  }
}
