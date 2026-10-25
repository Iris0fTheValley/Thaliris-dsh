/**
 * Native Agent Preset roster, Thaliris preset health and the new-Session default.
 *
 * The default is the `selectedDefault` field of the native `agent-preset-registry`
 * settings namespace. Writes use the same `remote.settings.update` call DSH's own
 * mode picker makes, fenced by the namespace revision read from the native form.
 * Nothing here writes unless a human clicks an explicit action.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the forwarded `settings/document-updated` event key and `remote` face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describeError } from './native-controller.ts'

/** Settings namespace the native Agent Preset registry owns. */
export const AGENT_PRESET_SETTINGS_NS = 'agent-preset-registry'

/** Preset id of the optional Thaliris mode. */
export const THALIRIS_PRESET_ID = 'thaliris'

/** One roster entry exactly as the host reports it. */
export interface AgentPresetRow {
  id: string
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

/** Volatile registry fields the page reads and writes. */
export interface AgentPresetRegistrySettings {
  default?: string
  selectedDefault?: string
}

/** Roster, health and default state the page renders. */
export interface ModeControllerState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  error: string | undefined
  presets: readonly AgentPresetRow[]
  /** The native settings section is served and the page may fence a write. */
  registryAvailable: boolean
  writable: boolean
  nativeDefault: string | undefined
  selectedDefault: string | undefined
  saving: boolean
  saveError: string | undefined
}

interface GatewayResult {
  ok: boolean
  value?: unknown
  error?: unknown
}

interface AgentPresetGateway {
  list(): Promise<GatewayResult>
}

interface SettingsGateway {
  update(namespace: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<GatewayResult>
}

interface RemoteEvents {
  $on?: (event: string, listener: () => void) => (() => void)
}

const INITIAL: ModeControllerState = {
  status: 'idle', error: undefined, presets: [], registryAvailable: false, writable: false,
  nativeDefault: undefined, selectedDefault: undefined, saving: false, saveError: undefined,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function presetRow(value: unknown): AgentPresetRow | undefined {
  const row = record(value)
  if (!row || typeof row.id !== 'string' || row.id.trim() === '') return undefined
  return {
    id: row.id, isDefault: row.isDefault === true,
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    ...(typeof row.broken === 'string' ? { broken: row.broken } : {}),
  }
}

function rosterRows(value: unknown): AgentPresetRow[] {
  const row = record(value)
  const presets = row && Array.isArray(row.presets) ? row.presets : []
  return presets.flatMap(item => { const parsed = presetRow(item); return parsed ? [parsed] : [] })
}

/** The roster row for the Thaliris preset, when the host registered it. */
export function thalirisRow(state: ModeControllerState): AgentPresetRow | undefined {
  return state.presets.find(row => row.id === THALIRIS_PRESET_ID)
}

/** Whether the Thaliris preset is registered and its composition mounted. */
export function thalirisHealthy(state: ModeControllerState): boolean {
  const row = thalirisRow(state)
  return row !== undefined && row.broken === undefined
}

/** The preset the host resolves for sessions that name no preset. */
export function effectiveDefaultId(state: ModeControllerState): string | undefined {
  const resolved = state.presets.find(row => row.isDefault)
  if (resolved) return resolved.id
  return state.selectedDefault ?? state.nativeDefault
}

/** The saved default points at no registered preset, so unnamed sessions cannot compose. */
export function danglingDefault(state: ModeControllerState): boolean {
  if (!state.registryAvailable || state.status !== 'ready') return false
  if (state.presets.some(row => row.isDefault)) return false
  return effectiveDefaultId(state) !== undefined
}

/** Whether Thaliris currently composes new unnamed sessions. */
export function isThalirisDefault(state: ModeControllerState): boolean {
  return effectiveDefaultId(state) === THALIRIS_PRESET_ID
}

/** The explicit set action is offered only for a healthy, registered, non-default preset. */
export function canSetThalirisDefault(state: ModeControllerState): boolean {
  return state.status === 'ready' && state.registryAvailable && state.writable && !state.saving
    && thalirisHealthy(state) && !isThalirisDefault(state)
}

/** A saved override differs from the native default, or the saved default is dangling. */
export function restoreNeeded(state: ModeControllerState): boolean {
  const override = state.selectedDefault !== undefined && state.selectedDefault !== state.nativeDefault
  return override || danglingDefault(state)
}

/** The restore action is offered when a saved override or a dangling default needs repair. */
export function canRestoreNativeDefault(state: ModeControllerState): boolean {
  return state.status === 'ready' && state.registryAvailable && state.writable && !state.saving
    && state.nativeDefault !== undefined && state.nativeDefault !== THALIRIS_PRESET_ID
    && restoreNeeded(state)
}

/** Reads the native roster and writes the one volatile default field on an explicit click. */
export class ModeController {
  readonly store: SnapshotStore<ModeControllerState>
  private readonly stops: (() => void)[] = []

  constructor(private readonly ctx: Context) {
    this.store = createSnapshotStore(INITIAL)
    const form = this.form()
    if (form) this.stops.push(form.subscribe(() => { this.publishForm() }))
    // Non-inject read: the roster and settings namespaces belong to other client plugins.
    const events = this.ctx.get('remote') as unknown as RemoteEvents | undefined
    if (events?.$on) {
      this.stops.push(events.$on('settings/document-updated', () => { void this.load() }))
    }
    this.stops.push(this.ctx.on('connection/reset', () => { void this.load() }))
  }

  getSnapshot = (): ModeControllerState => this.store.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Read the native roster and default fields without writing anything. */
  async load(): Promise<void> {
    const form = this.form()
    const snapshot = form?.getSnapshot()
    this.set({
      status: 'loading',
      registryAvailable: snapshot?.status === 'ready',
      writable: snapshot?.status === 'ready' && snapshot.writable === true,
      nativeDefault: snapshot?.value?.default,
      selectedDefault: snapshot?.value?.selectedDefault,
    })
    const roster = await this.readRoster()
    this.set({
      status: roster.status === 'ok' ? 'ready' : roster.status,
      error: roster.error,
      presets: roster.presets,
    })
  }

  /** Explicit human action: make Thaliris the native new-Session default. */
  async setThalirisDefault(): Promise<boolean> {
    return await this.writeDefault(THALIRIS_PRESET_ID)
  }

  /** Explicit human action: restore the native default preset recorded by the host. */
  async restoreNativeDefault(): Promise<boolean> {
    const target = this.store.getSnapshot().nativeDefault
    if (target === undefined) return false
    return await this.writeDefault(target)
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    this.stops.length = 0
  }

  private async writeDefault(id: string): Promise<boolean> {
    const current = this.store.getSnapshot()
    if (current.saving) return false
    // The roster and the native settings section must both be live: a write without
    // them could not fence a revision or verify the preset exists.
    if (current.status !== 'ready' || !current.registryAvailable || !current.writable) return false
    const settings = this.settings()
    if (!settings?.update) return false
    // The revision fences the write exactly like DSH's own mode picker: a namespace
    // change that landed after this page read the form makes the write refuse.
    const revision = this.form()?.getSnapshot().revision
    this.set({ saving: true, saveError: undefined })
    try {
      const response = await settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: id }, revision)
      if (!response.ok) throw new Error(describeError(response.error))
      await this.load()
      return true
    } catch (error) {
      this.set({ saveError: describeError(error) })
      // A refused fence or read-only document leaves this page's revision stale; reload
      // the native value so the next click is decided on current state.
      await this.load()
      return false
    } finally {
      this.set({ saving: false })
    }
  }

  private async readRoster(): Promise<{ status: 'ok' | 'unavailable' | 'error'; presets: AgentPresetRow[]; error?: string }> {
    // Non-inject read: the native preset UI may not be composed in every client.
    const roster = this.ctx.get('remote.agentPresets') as unknown as AgentPresetGateway | undefined
    if (!roster?.list) return { status: 'unavailable', presets: [] }
    try {
      const response = await roster.list()
      if (!response.ok) {
        const code = record(response.error)?.code
        if (code === 'gateway/invocation-unavailable') return { status: 'unavailable', presets: [] }
        return { status: 'error', presets: [], error: describeError(response.error) }
      }
      return { status: 'ok', presets: rosterRows(response.value) }
    } catch (error) {
      return { status: 'error', presets: [], error: describeError(error) }
    }
  }

  private settings(): SettingsGateway | undefined {
    return this.ctx.get('remote.settings') as unknown as SettingsGateway | undefined
  }

  private form(): ConfigForm<AgentPresetRegistrySettings> | undefined {
    try {
      return this.ctx.configForms.get<AgentPresetRegistrySettings>(AGENT_PRESET_SETTINGS_NS)
    } catch {
      // A deployment without the native settings service shows no preset state; that is
      // reported through `registryAvailable`, not raised from page render.
      return undefined
    }
  }

  private publishForm(): void {
    const snapshot = this.form()?.getSnapshot()
    this.set({
      registryAvailable: snapshot?.status === 'ready',
      writable: snapshot?.status === 'ready' && snapshot.writable === true,
      nativeDefault: snapshot?.value?.default,
      selectedDefault: snapshot?.value?.selectedDefault,
    })
  }

  private set(patch: Partial<ModeControllerState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }
}
