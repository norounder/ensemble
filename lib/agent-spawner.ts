/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: tmux session creation, program launching, and session cleanup.
 */

import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getRuntime } from './agent-runtime'
import { getSelfHostId } from './hosts-config'
import { buildAgentCommand } from './agent-config'
import { collabRuntimeDir } from './collab-paths'
import {
  classifyEnv,
  writeSecretEnvFile,
  buildSafeExports,
  buildSecretEnvLoader,
} from './secret-env'

export interface SpawnedAgent {
  id: string
  name: string
  program: string
  sessionName: string
  workingDirectory: string
  hostId: string
}

interface SpawnAgentOptions {
  name: string
  program: string
  workingDirectory: string
  hostId?: string
  /** Optional team id; used to place the per-agent secret envfile under the team runtime dir. */
  teamId?: string
}

/**
 * Resolve the directory that holds an agent's private envfile.
 * Prefers the team runtime dir (already mode 0700-ish under /tmp/ensemble),
 * falls back to a unique subdir of os.tmpdir() when no teamId is provided.
 */
function agentSecretDir(teamId: string | undefined, agentName: string): string {
  const safeAgent = agentName.replace(/[^a-zA-Z0-9\-_.]/g, '_') || 'agent'
  if (teamId && /^[a-zA-Z0-9\-_.]+$/.test(teamId)) {
    return path.join(collabRuntimeDir(teamId), 'agents', safeAgent)
  }
  return path.join(os.tmpdir(), `ensemble-spawn-${uuidv4()}`)
}

/** Compute tmux session name from agent name */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

/** Resolve program name to CLI command using agents.json config */
function resolveStartCommand(program: string): string {
  return buildAgentCommand(program)
}

/**
 * Spawn a local agent: create tmux session + start the AI program
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = uuidv4()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()
  const hostId = options.hostId || getSelfHostId()

  // Create tmux session
  await runtime.createSession(sessionName, cwd)

  // Small delay for session init
  await new Promise(r => setTimeout(r, 300))

  // Start the AI program
  const startCommand = resolveStartCommand(options.program)

  // Forward ENSEMBLE_, ANTHROPIC_, OPENAI_, and NVIDIA_ prefixed env vars to the agent.
  // Secret values (matching KEY/TOKEN/SECRET/PASSWORD/API_KEY) are written
  // to a private envfile and sourced by the spawn shell, so they never appear
  // in the tmux command line, pane scrollback, or replay HTML.
  const forwarded = Object.entries(process.env)
    .filter(([k]) => k.startsWith('ENSEMBLE_') || k.startsWith('NVIDIA_') || k.startsWith('OPENAI_') || k.startsWith('ANTHROPIC_'))
  const { safe, secret } = classifyEnv(forwarded)

  let secretLoader = ''
  if (secret.length > 0) {
    try {
      const secretDir = agentSecretDir(options.teamId, options.name)
      const envFile = path.join(secretDir, '.env')
      writeSecretEnvFile(envFile, secret)
      secretLoader = buildSecretEnvLoader(envFile)
    } catch (err) {
      // Don't crash the spawn if we can't write the file; just skip secret
      // forwarding so values remain redacted (the agent will see fewer env
      // vars but won't leak secrets to the pane).
      console.error(`[Spawner] Failed to write secret envfile for ${options.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const safeExports = buildSafeExports(safe)
  const envPrefixParts: string[] = []
  if (secretLoader) envPrefixParts.push(secretLoader)
  if (safeExports) envPrefixParts.push(`${safeExports};`)
  const envPrefix = envPrefixParts.length > 0 ? `${envPrefixParts.join(' ')} ` : ''

  // Use 'nocorrect' to prevent zsh auto-correct prompt, and add leading space to avoid tmux swallowing first char
  await runtime.sendKeys(sessionName, ` nocorrect unset CLAUDECODE; ${envPrefix}${startCommand}`, { literal: true, enter: true })

  console.log(`[Spawner] Agent ${options.name} started in tmux session ${sessionName}`)

  return {
    id: agentId,
    name: options.name,
    program: options.program,
    sessionName,
    workingDirectory: cwd,
    hostId,
  }
}

/**
 * Kill a local agent's tmux session
 */
export async function killLocalAgent(sessionName: string): Promise<void> {
  const runtime = getRuntime()
  try {
    // Try graceful exit first
    await runtime.sendKeys(sessionName, 'C-c', { enter: false })
    await new Promise(r => setTimeout(r, 500))
    await runtime.sendKeys(sessionName, '"exit"', { enter: true })
    await new Promise(r => setTimeout(r, 500))
    await runtime.killSession(sessionName)
  } catch {
    // Session may already be gone
    try { await runtime.killSession(sessionName) } catch { /* ok */ }
  }
}

/**
 * Spawn a remote agent via Maestro API on another machine
 */
export async function spawnRemoteAgent(
  hostUrl: string,
  agentName: string,
  program: string,
  cwd: string,
  taskDescription?: string,
  teamName?: string,
): Promise<{ id: string }> {
  // Create agent on remote host (15s timeout)
  const createCtrl = new AbortController()
  const createTimer = setTimeout(() => createCtrl.abort(), 15000)
  let createRes: Response
  try {
    createRes = await fetch(`${hostUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        program,
        workingDirectory: cwd,
        taskDescription,
        team: teamName,
      }),
      signal: createCtrl.signal,
    })
  } finally {
    clearTimeout(createTimer)
  }

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`Remote agent create failed: ${createRes.status} ${body}`)
  }

  const { agent } = await createRes.json()

  // Wake agent on remote host (15s timeout)
  const wakeCtrl = new AbortController()
  const wakeTimer = setTimeout(() => wakeCtrl.abort(), 15000)
  try {
    const wakeRes = await fetch(`${hostUrl}/api/agents/${agent.id}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startProgram: true, sessionIndex: 0 }),
      signal: wakeCtrl.signal,
    })
    if (!wakeRes.ok) {
      const body = await wakeRes.text()
      throw new Error(`Remote agent wake failed: ${wakeRes.status} ${body}`)
    }
  } finally {
    clearTimeout(wakeTimer)
  }

  return { id: agent.id }
}

/**
 * Kill a remote agent via Maestro API
 */
export async function killRemoteAgent(hostUrl: string, agentId: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    await fetch(`${hostUrl}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killSession: true }),
      signal: ctrl.signal,
    })
  } catch { /* non-fatal */ }
  finally { clearTimeout(timer) }
}

/**
 * Send command to a remote agent's session
 */
export async function postRemoteSessionCommand(
  hostUrl: string,
  sessionName: string,
  command: string,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, requireIdle: false, addNewline: true }),
      signal: ctrl.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Remote session command failed: ${response.status} ${body}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scrape token usage from an agent's tmux pane output.
 * Best-effort: returns 'unknown' if parsing fails.
 *
 * Claude Code patterns: "NNk tokens", "NN,NNN tokens", "NNN tokens"
 * Codex patterns: "NN% left", "NNk tokens"
 */
export async function getAgentTokenUsage(sessionName: string): Promise<string> {
  try {
    const runtime = getRuntime()
    const output = await runtime.capturePane(sessionName, 100)

    // Claude Code: "123k tokens" or "12,345 tokens" or "1.2k tokens"
    const claudeKMatch = output.match(/(\d+(?:\.\d+)?k)\s*tokens/i)
    if (claudeKMatch) return `~${claudeKMatch[1]} tokens`

    const claudeFullMatch = output.match(/([\d,]+)\s*tokens/i)
    if (claudeFullMatch) return `~${claudeFullMatch[1]} tokens`

    // Codex: "NN% left"
    const codexPctMatch = output.match(/(\d+)%\s*left/i)
    if (codexPctMatch) return `${codexPctMatch[1]}% budget left`

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a remote session exists and is ready
 */
export async function isRemoteSessionReady(hostUrl: string, sessionName: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return Boolean(body?.exists)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
