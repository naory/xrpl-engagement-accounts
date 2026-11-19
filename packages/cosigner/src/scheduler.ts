// Tick scheduler: a stored pre-signed default completes when its conditions come true, not only when someone calls
// the tick endpoint. One round ticks every open engagement, one after another, in quiet mode; the next round starts
// `intervalMs` after the previous one FINISHES (a setTimeout chain), so rounds never overlap.
import type { CosignerService, TickResult } from './service.ts'

export interface TickSchedulerOptions {
  intervalMs: number
  /** Called for each SIGN result (it carries the submittable `blob`). A throw is logged and does not stop the round. */
  onResult?: (engagementId: string, r: TickResult) => Promise<void> | void
  /** A fatal error that stopped the scheduler (STORE_LOCKED: the store lease is lost). The caller should exit. */
  onError?: (e: Error) => void
  log?: (level: 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void
}

const defaultLog: NonNullable<TickSchedulerOptions['log']> = (level, msg, extra) =>
  console.error(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }))

export function startTickScheduler(svc: CosignerService, o: TickSchedulerOptions): { stop(): Promise<void> } {
  const log = o.log ?? defaultLog
  const staleLogged = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let round: Promise<void> = Promise.resolve()

  const fatal = (e: Error): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    log('error', 'tick scheduler stopped', { error: e.message })
    o.onError?.(e)
  }

  async function tickOne(id: string): Promise<void> {
    const results = await svc.tick(id, { quiet: true })
    if (!results.length && !(await svc.accountExists(id))) {
      await svc.markClosed(id)
      log('warn', 'engagement account is gone; closed', { engagementId: id })
      return
    }
    for (const r of results) {
      if (r.decision !== 'SIGN') continue
      try { await o.onResult?.(id, r) } catch (e) { log('error', 'onResult failed', { engagementId: id, outcome: r.outcome, error: String((e as Error).message ?? e) }) }
    }
  }

  async function runRound(): Promise<void> {
    for (const id of svc.openEngagementIds()) {
      if (stopped) return
      try {
        await tickOne(id)
      } catch (e) {
        const message = String((e as Error)?.message ?? e)
        if (message.startsWith('STORE_LOCKED')) return fatal(e as Error)
        if (message.startsWith('ENGAGEMENT_STALE')) {
          if (!staleLogged.has(id)) { staleLogged.add(id); log('warn', 'engagement is quarantined', { engagementId: id, error: message }) }
          continue
        }
        log('error', 'tick failed', { engagementId: id, error: message })
      }
    }
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      round = runRound().finally(schedule)
    }, o.intervalMs)
  }
  schedule()

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await round
    },
  }
}
