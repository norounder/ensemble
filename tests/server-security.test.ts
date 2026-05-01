import net from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve a test port'))
        return
      }
      const { port } = address
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

async function waitForHealthy(baseUrl: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return
    } catch {
      // Server may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`)
}

/**
 * Spawn a fresh server instance with a clean module cache. Each call binds
 * to a unique ephemeral port so that rate-limit state and env-driven config
 * are completely isolated between tests. We mock heavyweight dependencies
 * to keep the import cheap and side-effect-free.
 */
async function startFreshServer(envOverrides: Record<string, string | undefined>): Promise<{
  baseUrl: string
  port: number
  restoreEnv: () => void
}> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const previous: Record<string, string | undefined> = {}

  const apply = (key: string, value: string | undefined) => {
    previous[key] = process.env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  apply('ENSEMBLE_PORT', String(port))
  apply('ENSEMBLE_HOST', '127.0.0.1')
  for (const [key, value] of Object.entries(envOverrides)) {
    apply(key, value)
  }

  vi.resetModules()
  vi.doMock('../services/ensemble-service', () => ({
    createEnsembleTeam: vi.fn(async () => ({ data: { ok: true }, status: 200 })),
    getEnsembleTeam: vi.fn(() => ({ data: { ok: true }, status: 200 })),
    listEnsembleTeams: vi.fn(() => ({ data: [], status: 200 })),
    getTeamFeed: vi.fn(() => ({ data: [], status: 200 })),
    sendTeamMessage: vi.fn(async () => ({ data: { ok: true }, status: 200 })),
    disbandTeam: vi.fn(async () => ({ data: { ok: true }, status: 200 })),
  }))

  await import('../server')
  await waitForHealthy(baseUrl)

  const restoreEnv = () => {
    for (const [key, prev] of Object.entries(previous)) {
      if (prev === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prev
      }
    }
  }

  return { baseUrl, port, restoreEnv }
}

describe('server security — X-Forwarded-For trust', () => {
  const restorers: Array<() => void> = []

  afterAll(() => {
    while (restorers.length) restorers.pop()?.()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('ignores X-Forwarded-For when ENSEMBLE_TRUST_PROXY is unset (no rate-limit bypass)', async () => {
    const { baseUrl, restoreEnv } = await startFreshServer({ ENSEMBLE_TRUST_PROXY: undefined })
    restorers.push(restoreEnv)

    // Default rate limit is 100/minute. Sending 105 requests with unique
    // spoofed XFF headers MUST collapse onto the real socket IP, so we
    // should observe at least one 429 in the tail.
    let rateLimited = 0
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { 'X-Forwarded-For': `10.0.0.${i + 1}` },
      })
      if (res.status === 429) rateLimited++
      // Drain response body to free the socket.
      await res.text()
    }
    expect(rateLimited).toBeGreaterThan(0)
  })

  it('honors X-Forwarded-For when ENSEMBLE_TRUST_PROXY=1 (each spoofed IP gets its own bucket)', async () => {
    const { baseUrl, restoreEnv } = await startFreshServer({ ENSEMBLE_TRUST_PROXY: '1' })
    restorers.push(restoreEnv)

    let rateLimited = 0
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        // Mix multiple IPs in chain to verify the FIRST is used.
        headers: { 'X-Forwarded-For': `10.0.0.${i + 1}, 192.168.1.1` },
      })
      if (res.status === 429) rateLimited++
      await res.text()
    }
    expect(rateLimited).toBe(0)
  })
})

describe('server security — response headers and CORS', () => {
  let baseUrl: string
  let restoreEnv: () => void

  beforeAll(async () => {
    const started = await startFreshServer({
      ENSEMBLE_TRUST_PROXY: undefined,
      ENSEMBLE_CORS_ORIGIN: 'http://localhost:3000',
    })
    baseUrl = started.baseUrl
    restoreEnv = started.restoreEnv
  })

  afterAll(() => {
    restoreEnv()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('sets X-Content-Type-Options: nosniff on every response', async () => {
    const healthRes = await fetch(`${baseUrl}/api/v1/health`)
    expect(healthRes.headers.get('x-content-type-options')).toBe('nosniff')
    await healthRes.text()

    const notFoundRes = await fetch(`${baseUrl}/api/does-not-exist`)
    expect(notFoundRes.status).toBe(404)
    expect(notFoundRes.headers.get('x-content-type-options')).toBe('nosniff')
    await notFoundRes.text()

    const preflightRes = await fetch(`${baseUrl}/api/v1/health`, { method: 'OPTIONS' })
    expect(preflightRes.headers.get('x-content-type-options')).toBe('nosniff')
    await preflightRes.text()
  })

  it('rejects look-alike origins under strict URL-aware comparison', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: 'http://evilhost.localhost:3000' },
    })
    // Server returns a 403 body and must NOT echo the disallowed origin.
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    await res.text()
  })

  it('accepts the configured origin (exact match)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    await res.text()
  })
})
