/**
 * Shared HTTP client for ensemble CLI tools.
 *
 * Wraps Node's built-in `http` module to provide a small JSON-over-HTTP API
 * surface used by `cli/ensemble.ts` and `cli/monitor.ts`. The base URL is
 * resolved per-call from `process.env.ENSEMBLE_URL` (so test/CLI overrides
 * keep working) and timeouts can be configured per-client or per-call.
 *
 * Behavior notes (preserved from the original inline implementations):
 *   - Response bodies are JSON-parsed regardless of HTTP status code.
 *     Callers that need status-code branching must continue to handle it
 *     themselves (no current call site does).
 *   - JSON parse failures reject the promise.
 *   - Socket-level errors (e.g. ECONNREFUSED) reject the promise.
 *
 * One small improvement over the previous inline copies: a fired `timeout`
 * event now actually destroys the request and rejects with a timeout error.
 * Previously the `timeout` option was set but never observed, so timed-out
 * requests would hang. No live call site relied on the silent-hang behavior.
 */

import http from 'http'

export interface HttpClientOptions {
  /**
   * Base URL for all requests. When omitted, each call reads
   * `process.env.ENSEMBLE_URL` at request time (falling back to
   * `http://localhost:23000`).
   */
  baseUrl?: string
  /**
   * Default per-request timeout in milliseconds. Individual `get`/`post`
   * calls may override via `RequestOptions.timeoutMs`.
   */
  timeoutMs?: number
}

export interface RequestOptions {
  /** Override the client default for this single request. */
  timeoutMs?: number
}

export interface ApiClient {
  get<T>(path: string, opts?: RequestOptions): Promise<T>
  post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T>
}

const DEFAULT_BASE_URL = 'http://localhost:23000'
const DEFAULT_TIMEOUT_MS = 5000

function resolveBaseUrl(opt?: string): string {
  if (opt) return opt
  return process.env.ENSEMBLE_URL || DEFAULT_BASE_URL
}

function buildUrl(baseUrl: string, urlPath: string): string {
  // Match original behavior: support both raw concatenation and URL parsing.
  // Using `new URL(urlPath, base)` handles relative paths and absolute paths
  // identically to how `monitor.ts` did it, while also accepting the raw
  // concatenation form `ensemble.ts` used (paths beginning with `/`).
  return new URL(urlPath, baseUrl).toString()
}

export function createApiClient(opts: HttpClientOptions = {}): ApiClient {
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  function get<T>(urlPath: string, reqOpts?: RequestOptions): Promise<T> {
    const timeout = reqOpts?.timeoutMs ?? defaultTimeout
    const url = buildUrl(resolveBaseUrl(opts.baseUrl), urlPath)
    return new Promise<T>((resolve, reject) => {
      const req = http.get(url, { timeout }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data) as T) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error(`Request to ${urlPath} timed out after ${timeout}ms`))
      })
    })
  }

  function post<T>(urlPath: string, body: unknown, reqOpts?: RequestOptions): Promise<T> {
    const timeout = reqOpts?.timeoutMs ?? defaultTimeout
    const url = buildUrl(resolveBaseUrl(opts.baseUrl), urlPath)
    const payload = JSON.stringify(body)
    return new Promise<T>((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout,
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data) as T) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error(`Request to ${urlPath} timed out after ${timeout}ms`))
      })
      req.write(payload)
      req.end()
    })
  }

  return { get, post }
}
