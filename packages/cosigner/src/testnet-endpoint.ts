// Shared Testnet websocket selection.
// XRPL_URL, when set, is used as given. Otherwise the candidates are tried in
// order and the first that accepts a connection wins. A candidate that errors
// or does not connect within TESTNET_CONNECT_TIMEOUT_MS is skipped.
// resolveServiceEndpoint is the once-per-process path for a long-running
// service: an optional override env var wins and is not probed; otherwise
// this helper runs. It logs the chosen URL on one line.
// Testnet only: this list has no mainnet endpoints.
import xrpl from 'xrpl'

/** Testnet endpoints, in the order they are tried when XRPL_URL is unset. */
export const TESTNET_ENDPOINTS = [
  'wss://testnet.xrpl-labs.com',
  'wss://s.altnet.rippletest.net:51233',
] as const

/** Per-candidate connect timeout. Short on purpose: a hung endpoint must not stall the next one. */
export const TESTNET_CONNECT_TIMEOUT_MS = 5_000

export type TestnetConnect = (url: string, timeoutMs: number) => Promise<void>

export interface ResolveTestnetEndpointOptions {
  /** Environment to read XRPL_URL from. Defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Candidates. Defaults to TESTNET_ENDPOINTS. */
  endpoints?: readonly string[]
  /** Connect timeout per candidate, in milliseconds. */
  timeoutMs?: number
  /** Connection probe. Defaults to an xrpl.Client connect with connectionTimeout. */
  connect?: TestnetConnect
  /** Called when a candidate is skipped and another remains. Defaults to console.warn. */
  warn?: (message: string) => void
}

/**
 * Resolve the Testnet websocket the demos should use.
 * A set XRPL_URL wins and is not probed. Otherwise each candidate is connected
 * in order; the first success is returned. Every candidate failing throws.
 */
export async function resolveTestnetEndpoint(options: ResolveTestnetEndpointOptions = {}): Promise<string> {
  const configured = (options.env ?? process.env).XRPL_URL?.trim()
  if (configured) return configured

  const endpoints = options.endpoints ?? TESTNET_ENDPOINTS
  const timeoutMs = options.timeoutMs ?? TESTNET_CONNECT_TIMEOUT_MS
  const connect = options.connect ?? connectWithXrpl
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const failures: string[] = []

  for (const [i, url] of endpoints.entries()) {
    try {
      await attempt(url, timeoutMs, connect)
      return url
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      failures.push(`${url} (${reason})`)
      if (i < endpoints.length - 1) warn(`XRPL Testnet endpoint unreachable, trying next: ${url} (${reason})`)
    }
  }

  throw new Error(
    `No reachable XRPL Testnet endpoint. Tried ${failures.join('; ')}. Set XRPL_URL to a reachable endpoint.`,
  )
}

export interface ResolveServiceEndpointOptions extends ResolveTestnetEndpointOptions {
  /**
   * Env var that, when set to a non-blank value, is the endpoint and is not probed.
   * Blank or whitespace is treated as unset. The pool CLI passes ENG_XRPL_WSS.
   */
  overrideVar?: string
  /** Receives the one startup line `XRPL endpoint: <url>`. Defaults to console.log. */
  log?: (line: string) => void
}

/**
 * Resolve the Testnet websocket a service keeps for its lifetime. Call once at startup.
 * `overrideVar`, when set, wins over `XRPL_URL` and over probing. Otherwise
 * `resolveTestnetEndpoint` runs. Logs the chosen URL on one line.
 */
export async function resolveServiceEndpoint(options: ResolveServiceEndpointOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const log = options.log ?? ((line: string) => console.log(line))
  const override = options.overrideVar ? env[options.overrideVar]?.trim() : ''
  if (override) {
    log(`XRPL endpoint: ${override}`)
    return override
  }
  const url = await resolveTestnetEndpoint({
    env,
    endpoints: options.endpoints,
    timeoutMs: options.timeoutMs,
    connect: options.connect,
    warn: options.warn,
  })
  log(`XRPL endpoint: ${url}`)
  return url
}

/** Bound one probe. A connect that never settles is a timeout, not a hang. */
function attempt(url: string, timeoutMs: number, connect: TestnetConnect): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve()
      .then(() => connect(url, timeoutMs))
      .then(
        () => { clearTimeout(timer); resolve() },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
  })
}

/** Open a client and close it. Reachable means the websocket handshake succeeded. */
async function connectWithXrpl(url: string, timeoutMs: number): Promise<void> {
  const client = new xrpl.Client(url, { connectionTimeout: timeoutMs })
  try {
    await client.connect()
  } finally {
    await client.disconnect().catch(() => {})
  }
}
