/**
 * Agent spawner secret-env redaction tests.
 *
 * Verifies that when spawnLocalAgent forwards env vars into a tmux session,
 * secret values (matching KEY/TOKEN/SECRET/PASSWORD/API_KEY) never appear
 * inline in the string passed to `tmux send-keys` — they're sourced from a
 * private envfile (mode 0600, parent dir 0700) instead.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface SendKeysCall {
  name: string
  keys: string
  opts: { literal?: boolean; enter?: boolean } | undefined
}

const sendKeysCalls: SendKeysCall[] = []

const fakeRuntime = {
  type: 'tmux' as const,
  createSession: vi.fn(async () => {}),
  sendKeys: vi.fn(async (name: string, keys: string, opts?: { literal?: boolean; enter?: boolean }) => {
    sendKeysCalls.push({ name, keys, opts })
  }),
  killSession: vi.fn(async () => {}),
  capturePane: vi.fn(async () => ''),
  pasteFromFile: vi.fn(async () => {}),
}

vi.mock('../lib/agent-runtime', () => ({
  getRuntime: () => fakeRuntime,
  setRuntime: vi.fn(),
}))

vi.mock('../lib/agent-config', () => ({
  buildAgentCommand: (program: string) => `${program} --no-banner`,
  resolveAgentProgram: () => ({ readyMarker: '>', inputMethod: 'sendKeys' }),
}))

vi.mock('../lib/hosts-config', () => ({
  isSelf: () => true,
  getHostById: () => undefined,
  getSelfHostId: () => 'local',
}))

const FORWARDED_KEYS = [
  'ENSEMBLE_PORT',
  'ENSEMBLE_DATA_DIR',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'ENSEMBLE_REDACT_ENV_PATTERN',
  'ENSEMBLE_SECRET_TOKEN',
]

let tempRoot: string
let originalEnv: Record<string, string | undefined>

function clearForwardedEnv(): void {
  for (const key of FORWARDED_KEYS) {
    delete process.env[key]
  }
}

beforeEach(() => {
  sendKeysCalls.length = 0
  fakeRuntime.createSession.mockClear()
  fakeRuntime.sendKeys.mockClear()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-redact-'))
  // Snapshot env vars we'll mutate.
  originalEnv = {}
  for (const key of FORWARDED_KEYS) {
    originalEnv[key] = process.env[key]
  }
  clearForwardedEnv()
  process.env.ENSEMBLE_DATA_DIR = tempRoot
})

afterEach(() => {
  clearForwardedEnv()
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = val
    }
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch { /* best-effort */ }
})

async function spawn(teamId: string | undefined = 'team-redact-test') {
  const { spawnLocalAgent } = await import('../lib/agent-spawner')
  return spawnLocalAgent({
    name: 'agent-redact-1',
    program: 'claude',
    workingDirectory: tempRoot,
    hostId: 'local',
    teamId,
  })
}

function lastSpawnCommand(): string {
  // The first sendKeys call is the spawn command (literal: true, enter: true).
  const call = sendKeysCalls.find(c => c.opts?.literal === true)
  if (!call) throw new Error('No literal sendKeys call captured')
  return call.keys
}

describe('agent-spawner secret env redaction', () => {
  it('does not include ANTHROPIC_API_KEY value inline in tmux send-keys', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test123-anthropic-secret'
    await spawn()

    const cmd = lastSpawnCommand()
    expect(cmd).not.toContain('sk-test123-anthropic-secret')
    expect(cmd).not.toContain('export ANTHROPIC_API_KEY=')
    // It should source an envfile and remove it.
    expect(cmd).toMatch(/set -a; \. '[^']+\.env'; set \+a; rm -f '[^']+\.env';/)
  })

  it('does not include OPENAI_API_KEY value inline in tmux send-keys', async () => {
    process.env.OPENAI_API_KEY = 'sk-openaitest-XYZ'
    await spawn()

    const cmd = lastSpawnCommand()
    expect(cmd).not.toContain('sk-openaitest-XYZ')
    expect(cmd).not.toContain('export OPENAI_API_KEY=')
  })

  it('still inlines non-secret ENSEMBLE_PORT export with exact value', async () => {
    process.env.ENSEMBLE_PORT = '23000'
    await spawn()

    const cmd = lastSpawnCommand()
    expect(cmd).toContain('export ENSEMBLE_PORT="23000"')
  })

  it('writes the envfile with mode 0600 and parent dir mode 0700', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-permission-check'
    await spawn('team-perm-check')

    const cmd = lastSpawnCommand()
    const match = cmd.match(/\. '([^']+\.env)'/)
    expect(match).toBeTruthy()
    const envFilePath = match![1]
    expect(fs.existsSync(envFilePath)).toBe(true)

    const fileStat = fs.statSync(envFilePath)
    // eslint-disable-next-line no-bitwise
    expect(fileStat.mode & 0o777).toBe(0o600)

    const dirStat = fs.statSync(path.dirname(envFilePath))
    // eslint-disable-next-line no-bitwise
    expect(dirStat.mode & 0o777).toBe(0o700)

    // File contents should hold the secret in shell-quoted form.
    const contents = fs.readFileSync(envFilePath, 'utf8')
    expect(contents).toContain(`ANTHROPIC_API_KEY='sk-permission-check'`)
  })

  it('forwards multiple secrets and multiple safe vars in one spawn', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthro-multi'
    process.env.OPENAI_API_KEY = 'sk-openai-multi'
    process.env.ENSEMBLE_PORT = '24001'
    process.env.ENSEMBLE_DATA_DIR = tempRoot

    await spawn()
    const cmd = lastSpawnCommand()

    // Neither secret leaks.
    expect(cmd).not.toContain('sk-anthro-multi')
    expect(cmd).not.toContain('sk-openai-multi')

    // Both safe vars appear inline.
    expect(cmd).toContain('export ENSEMBLE_PORT="24001"')
    expect(cmd).toMatch(/export ENSEMBLE_DATA_DIR="/)

    // Single envfile loader.
    const loaderMatches = cmd.match(/set -a; \. '[^']+\.env'; set \+a; rm -f '[^']+\.env';/g) || []
    expect(loaderMatches.length).toBe(1)
  })

  it('honors ENSEMBLE_REDACT_ENV_PATTERN to widen the secret allowlist', async () => {
    // Mark ENSEMBLE_PORT as secret too via the override pattern.
    process.env.ENSEMBLE_REDACT_ENV_PATTERN = 'PORT|TOKEN|KEY|SECRET'
    process.env.ENSEMBLE_PORT = '29999'

    await spawn('team-pattern-test')
    const cmd = lastSpawnCommand()

    // Now ENSEMBLE_PORT should NOT be inlined.
    expect(cmd).not.toContain('export ENSEMBLE_PORT="29999"')
    expect(cmd).not.toContain('29999')
    // Should be in the envfile instead.
    expect(cmd).toMatch(/set -a; \. '[^']+\.env';/)

    const match = cmd.match(/\. '([^']+\.env)'/)
    const envFilePath = match![1]
    const contents = fs.readFileSync(envFilePath, 'utf8')
    expect(contents).toContain(`ENSEMBLE_PORT='29999'`)
  })

  it('skips envfile loader entirely when no secrets are forwarded', async () => {
    process.env.ENSEMBLE_PORT = '25000'

    await spawn()
    const cmd = lastSpawnCommand()

    expect(cmd).toContain('export ENSEMBLE_PORT="25000"')
    expect(cmd).not.toContain('set -a;')
    expect(cmd).not.toContain('.env')
  })
})
