/**
 * Secret env utilities — classify forwarded env vars as "secret" vs "safe"
 * and write secrets to a private envfile so their values never appear in
 * shell command lines or tmux pane scrollback.
 *
 * Used by lib/agent-spawner.ts when forwarding ENSEMBLE_, ANTHROPIC_, OPENAI_,
 * and NVIDIA_ prefixed vars to a tmux-spawned agent. Without redaction, secret
 * values would be visible via `tmux capture-pane`, in the auto-generated replay
 * HTML, and in /proc/<pid>/cmdline while the shell parses the export statement.
 */

import fs from 'fs'
import path from 'path'

/** Default regex matching env-var names that should be treated as secret. */
const DEFAULT_SECRET_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|API[_-]?KEY)/i

/**
 * Get the regex used to classify env vars as secret.
 * Override via ENSEMBLE_REDACT_ENV_PATTERN (a JS regex source, case-insensitive).
 */
export function getSecretPattern(): RegExp {
  const override = process.env['ENSEMBLE_REDACT_ENV_PATTERN']?.trim()
  if (override) {
    try {
      return new RegExp(override, 'i')
    } catch {
      // Fall back to default on invalid pattern
    }
  }
  return DEFAULT_SECRET_PATTERN
}

/** Returns true if the var name should be redacted (kept out of command line). */
export function isSecretVar(name: string, pattern: RegExp = getSecretPattern()): boolean {
  return pattern.test(name)
}

export interface ClassifiedEnv {
  /** Vars whose values are safe to inline as `export K="V"` in shell. */
  safe: Array<[string, string]>
  /** Vars whose values must be sourced from a private file. */
  secret: Array<[string, string]>
}

/**
 * Split forwarded env entries into safe vs secret based on the name pattern.
 * Empty/undefined values are dropped.
 */
export function classifyEnv(
  entries: Iterable<[string, string | undefined]>,
  pattern: RegExp = getSecretPattern(),
): ClassifiedEnv {
  const safe: Array<[string, string]> = []
  const secret: Array<[string, string]> = []
  for (const [k, v] of entries) {
    if (!v) continue
    if (isSecretVar(k, pattern)) secret.push([k, v])
    else safe.push([k, v])
  }
  return { safe, secret }
}

/**
 * Escape a string for safe inclusion inside a single-quoted POSIX shell value.
 * Single quote → end-quote, escaped quote, restart-quote.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Write secret env vars to a file in `KEY='value'` format suitable for
 * `set -a; . file; set +a`. Parent directory is created with mode 0700,
 * file is written with mode 0600.
 *
 * Returns the absolute file path. Caller is responsible for arranging
 * deletion (typically `rm -f` in the spawn shell command, after sourcing).
 */
export function writeSecretEnvFile(
  filePath: string,
  entries: Iterable<[string, string]>,
): string {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir with mode is ignored if the dir already exists; force perms.
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort */ }

  const lines: string[] = []
  for (const [k, v] of entries) {
    lines.push(`${k}=${shellSingleQuote(v)}`)
  }
  // Write with restrictive umask: open with O_CREAT|O_WRONLY|O_TRUNC, mode 0600.
  const fd = fs.openSync(filePath, 'w', 0o600)
  try {
    fs.writeSync(fd, lines.join('\n') + (lines.length ? '\n' : ''))
  } finally {
    fs.closeSync(fd)
  }
  // Re-assert mode in case of pre-existing file.
  try { fs.chmodSync(filePath, 0o600) } catch { /* best-effort */ }
  return filePath
}

/**
 * Build the `export K="V"; export K2="V2"` snippet for safe (non-secret) vars.
 * Returns empty string if no entries.
 */
export function buildSafeExports(entries: Iterable<[string, string]>): string {
  const parts: string[] = []
  for (const [k, v] of entries) {
    // Double-quoted is fine here; values don't contain user-supplied control
    // chars in normal use, but escape `"`, `\`, `$`, and backticks defensively.
    const escaped = v.replace(/([\\"$`])/g, '\\$1')
    parts.push(`export ${k}="${escaped}"`)
  }
  return parts.join('; ')
}

/**
 * Build the prefix that loads the secret envfile and removes it.
 * Returns empty string if no envfile path is provided.
 *
 * Format: `set -a; . '<file>'; set +a; rm -f '<file>';`
 *   - `set -a` auto-exports every var defined while sourcing the file
 *   - `. file` (POSIX dot) sources the file
 *   - `set +a` restores normal behavior
 *   - `rm -f file` removes the file before the agent CLI starts; the values
 *     remain in the shell's process env (and are inherited by `exec`).
 */
export function buildSecretEnvLoader(envFile: string | undefined): string {
  if (!envFile) return ''
  const quoted = shellSingleQuote(envFile)
  return `set -a; . ${quoted}; set +a; rm -f ${quoted};`
}
