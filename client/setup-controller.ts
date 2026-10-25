/** Human-only first-run setup status and actions over the Thaliris Gateway. */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describeError } from './native-controller.ts'

/** Progress of one in-flight provisioning action, as the host reports it. */
export interface SetupProgress {
  step?: string | null
  started_at?: string | null
  elapsed_ms?: number | null
}

/** First-run Workspace binding reported by the host after the one-time auto-bind. */
export interface SetupAutoBind {
  workspaceId: string
  root: string
  enabled: boolean
  at: string
}

/** Recorded or configured runtime as the host reports it. */
export interface SetupRuntimeInfo {
  pythonExecutable?: string | null
  corePath?: string | null
  version?: string | null
  commit?: string | null
  state_schema_version?: number | null
  python?: string | null
  verified_at?: string | null
  source?: string | null
  version_matches_pin?: boolean | null
}

/** Core pin the host build trusts. */
export interface SetupPin {
  version?: string
  commit?: string
  stateSchemaVersion?: number
  error?: string
}

/**
 * Tolerant human-facing setup status. The host normalizes the raw state machine
 * before answering; every optional member is absent rather than fatal.
 */
export interface SetupStatus {
  state: string
  verified: boolean
  code: string | null
  recovery: string | null
  detail: string | null
  step: string | null
  attempt: number
  elapsed_ms: number | null
  progress: SetupProgress | null
  configured: boolean
  manual_override: boolean
  authorityDirectory: string | null
  runtime: SetupRuntimeInfo | null
  pin: SetupPin
  workspaceAutoBind: SetupAutoBind | null
  ok?: boolean
  already?: boolean
  provisioned?: boolean
}

/** Setup page state; `action` is the one in-flight human click. */
export interface SetupControllerState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  setup: SetupStatus | undefined
  error: string | undefined
  action: 'idle' | 'preparing' | 'rechecking'
  actionError: string | undefined
}

interface GatewayResult {
  ok: boolean
  value?: unknown
  error?: unknown
}

interface ThalirisSetupGateway {
  setupStatus(): Promise<GatewayResult>
  prepareRuntime(signal?: AbortSignal): Promise<GatewayResult>
  recheckRuntime(signal?: AbortSignal): Promise<GatewayResult>
}

const INITIAL: SetupControllerState = {
  status: 'idle', setup: undefined, error: undefined, action: 'idle', actionError: undefined,
}

/** Poll cadence while a provisioning action runs; the action itself owns the outcome. */
const PROGRESS_POLL_MS = 800

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function runtimeInfo(value: unknown): SetupRuntimeInfo | null {
  const row = record(value)
  if (!row) return null
  return {
    pythonExecutable: stringOrNull(row.pythonExecutable), corePath: stringOrNull(row.corePath),
    version: stringOrNull(row.version), commit: stringOrNull(row.commit),
    state_schema_version: typeof row.state_schema_version === 'number' ? row.state_schema_version : null,
    python: stringOrNull(row.python), verified_at: stringOrNull(row.verified_at),
    source: stringOrNull(row.source),
    version_matches_pin: typeof row.version_matches_pin === 'boolean' ? row.version_matches_pin : null,
  }
}

function pinInfo(value: unknown): SetupPin {
  const row = record(value)
  if (!row) return {}
  return {
    ...(typeof row.version === 'string' ? { version: row.version } : {}),
    ...(typeof row.commit === 'string' ? { commit: row.commit } : {}),
    ...(typeof row.stateSchemaVersion === 'number' ? { stateSchemaVersion: row.stateSchemaVersion } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

function autoBindInfo(value: unknown): SetupAutoBind | null {
  const row = record(value)
  if (!row || typeof row.workspaceId !== 'string' || typeof row.root !== 'string') return null
  return { workspaceId: row.workspaceId, root: row.root, enabled: row.enabled !== false,
    at: typeof row.at === 'string' ? row.at : '' }
}

/** Normalize one Gateway JSON answer into the status the page renders. */
export function asSetupStatus(value: unknown): SetupStatus | undefined {
  const row = record(value)
  if (!row || typeof row.state !== 'string') return undefined
  const progress = record(row.progress)
  const status: SetupStatus = {
    state: row.state,
    verified: row.verified === true,
    code: stringOrNull(row.code),
    recovery: stringOrNull(row.recovery),
    detail: stringOrNull(row.detail),
    step: stringOrNull(row.step),
    attempt: typeof row.attempt === 'number' ? row.attempt : 0,
    elapsed_ms: typeof row.elapsed_ms === 'number' ? row.elapsed_ms : null,
    progress: progress ? {
      step: stringOrNull(progress.step), started_at: stringOrNull(progress.started_at),
      elapsed_ms: typeof progress.elapsed_ms === 'number' ? progress.elapsed_ms : null,
    } : null,
    configured: row.configured === true,
    manual_override: row.manual_override === true,
    authorityDirectory: stringOrNull(row.authorityDirectory),
    runtime: runtimeInfo(row.runtime),
    pin: pinInfo(row.pin),
    workspaceAutoBind: autoBindInfo(row.workspaceAutoBind),
  }
  if (typeof row.ok === 'boolean') status.ok = row.ok
  if (typeof row.already === 'boolean') status.already = row.already
  if (typeof row.provisioned === 'boolean') status.provisioned = row.provisioned
  return status
}

/**
 * Reads the host's tolerant setup status and runs the two explicit human actions.
 * A provisioning action polls the sync status read for progress while it runs, so
 * the page can show the active step; it never provisions on its own.
 */
export class SetupController {
  readonly store: SnapshotStore<SetupControllerState>
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly ctx: Context) {
    this.store = createSnapshotStore(INITIAL)
  }

  getSnapshot = (): SetupControllerState => this.store.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Read the current setup status without changing host state. */
  async load(): Promise<void> {
    const gateway = this.gateway()
    if (!gateway) {
      this.set({ status: 'error', error: undefined })
      return
    }
    this.set({ status: 'loading' })
    try {
      const response = await gateway.setupStatus()
      if (!response.ok) throw new Error(describeError(response.error))
      const setup = asSetupStatus(response.value)
      if (!setup) throw new Error('the host returned an unreadable setup status')
      this.set({ status: 'ready', setup, error: undefined })
    } catch (error) {
      this.set({ status: 'error', error: describeError(error) })
    }
  }

  /** Explicit human action: provision the pinned runtime if needed and verify it. */
  async prepare(): Promise<boolean> {
    return await this.run('preparing', gateway => gateway.prepareRuntime())
  }

  /** Explicit human action: re-read the configured or recorded runtime and verify it. */
  async recheck(): Promise<boolean> {
    return await this.run('rechecking', gateway => gateway.recheckRuntime())
  }

  dispose(): void {
    this.stopProgress()
  }

  private gateway(): ThalirisSetupGateway | undefined {
    // Non-inject read: the setup Gateway is optional for this page (the API row may be
    // absent), and `ctx.get` is the documented read for a service outside the inject list.
    return this.ctx.get('remote.thaliris') as unknown as ThalirisSetupGateway | undefined
  }

  private async run(action: 'preparing' | 'rechecking',
    invoke: (gateway: ThalirisSetupGateway) => Promise<GatewayResult>): Promise<boolean> {
    if (this.store.getSnapshot().action !== 'idle') return false
    this.set({ action, actionError: undefined })
    this.startProgress()
    try {
      const gateway = this.gateway()
      if (!gateway) throw new Error('the host does not serve the Thaliris setup Gateway')
      const response = await invoke(gateway)
      if (!response.ok) throw new Error(describeError(response.error))
      const setup = asSetupStatus(response.value)
      if (!setup) throw new Error('the host returned an unreadable setup status')
      // A failed provisioning attempt is not a transport error: the status itself
      // carries the code, recovery and detail the page renders.
      this.set({ status: 'ready', setup, error: undefined })
      return setup.state === 'ready'
    } catch (error) {
      this.set({ actionError: describeError(error) })
      return false
    } finally {
      this.stopProgress()
      this.set({ action: 'idle' })
    }
  }

  private startProgress(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.poll() }, PROGRESS_POLL_MS)
  }

  private stopProgress(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async poll(): Promise<void> {
    const gateway = this.gateway()
    if (!gateway) return
    try {
      const response = await gateway.setupStatus()
      if (!response.ok) return
      const setup = asSetupStatus(response.value)
      if (setup) this.set({ setup })
    } catch {
      // A progress poll is best-effort; the explicit action reports its own outcome.
    }
  }

  private set(patch: Partial<SetupControllerState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }
}
