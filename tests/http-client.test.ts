import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import { createApiClient } from '../lib/http-client'

interface RecordedRequest {
  method: string | undefined
  url: string | undefined
  headers: http.IncomingHttpHeaders
  body: string
}

const recorded: RecordedRequest[] = []
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      recorded.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      })

      const url = req.url || '/'
      if (url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, hello: 'world' }))
        return
      }
      if (url === '/echo' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: JSON.parse(body || 'null') }))
        return
      }
      if (url === '/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'kaboom', code: 500 }))
        return
      }
      if (url === '/slow') {
        // Never respond — let the client timeout fire.
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  // Force-close lingering sockets (e.g. /slow handlers) so the process can
  // exit cleanly.
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('createApiClient', () => {
  it('get<T> parses JSON for a 200 response', async () => {
    const api = createApiClient({ baseUrl })
    const data = await api.get<{ ok: boolean; hello: string }>('/json')
    expect(data).toEqual({ ok: true, hello: 'world' })
  })

  it('post<T> sends JSON body with Content-Type and parses response', async () => {
    const api = createApiClient({ baseUrl })
    const payload = { foo: 'bar', count: 42 }
    const data = await api.post<{ received: typeof payload }>('/echo', payload)
    expect(data).toEqual({ received: payload })

    const last = recorded[recorded.length - 1]
    expect(last.method).toBe('POST')
    expect(last.url).toBe('/echo')
    expect(last.headers['content-type']).toBe('application/json')
    expect(last.body).toBe(JSON.stringify(payload))
    // Content-Length should equal byte length of the payload.
    expect(last.headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify(payload))),
    )
  })

  it('non-2xx responses still parse and resolve (preserves original CLI behavior)', async () => {
    // The previous inline implementations did not check status codes; they
    // returned whatever JSON the server emitted. This test pins that
    // behavior so a future change is visible.
    const api = createApiClient({ baseUrl })
    const data = await api.get<{ error: string; code: number }>('/error')
    expect(data).toEqual({ error: 'kaboom', code: 500 })
  })

  it('rejects when the server fails to respond before timeoutMs', async () => {
    const api = createApiClient({ baseUrl, timeoutMs: 100 })
    await expect(api.get('/slow')).rejects.toThrow(/timed out/i)
  })

  it('per-call timeoutMs overrides the client default', async () => {
    const api = createApiClient({ baseUrl, timeoutMs: 60_000 })
    await expect(api.get('/slow', { timeoutMs: 100 })).rejects.toThrow(/timed out/i)
  })

  it('default base URL falls back to process.env.ENSEMBLE_URL', async () => {
    const prev = process.env.ENSEMBLE_URL
    process.env.ENSEMBLE_URL = baseUrl
    try {
      const api = createApiClient() // no baseUrl
      const data = await api.get<{ ok: boolean }>('/json')
      expect(data.ok).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ENSEMBLE_URL
      else process.env.ENSEMBLE_URL = prev
    }
  })
})
