/** Revision-fenced drafts over the native Thaliris ConfigForm. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { z } from 'zod'
import type { RoleRecord, UserPolicy } from '../remote'

/**
 * Exact Host namespace value: `policy` is the volatile user policy, the three
 * runtime path fields are optional volatile manual overrides.
 */
export interface ThalirisSettings {
  policy: UserPolicy
  pythonExecutable?: string
  corePath?: string
  authorityDirectory?: string
}

/** Optional runtime path overrides, in the order the page renders them. */
export const RUNTIME_FIELDS = ['pythonExecutable', 'corePath', 'authorityDirectory'] as const
export type RuntimeField = (typeof RUNTIME_FIELDS)[number]

/** Path-like manual override text fields, always strings in the draft. */
export type RuntimeDraft = Record<RuntimeField, string>

export type PolicyField = 'controllerPrompt' | 'workspaces' | 'roles' | 'memory'

export interface PolicyEditorState {
  native: ConfigFormSnapshot<ThalirisSettings>
  draft: UserPolicy | undefined
  runtime: RuntimeDraft | undefined
  dirtyFields: readonly PolicyField[]
  dirtyRuntimeFields: readonly RuntimeField[]
  runtimeInvalid: readonly RuntimeField[]
  saving: boolean
  conflict: boolean
  error: string | undefined
  validationError: string | undefined
  dirty: boolean
  writable: boolean
  available: boolean
}

/** One enabled role whose stored tool grants are empty, with its shipped recommendation. */
export interface RoleRecommendation {
  index: number
  role: RoleRecord
  template: RoleRecord | undefined
  tools: readonly string[]
}

function copyRole(value: Partial<RoleRecord>): RoleRecord {
  return {
    id: value.id ?? '',
    name: value.name ?? '',
    description: value.description ?? '',
    prompt: value.prompt ?? '',
    enabled: value.enabled ?? true,
    tools: [...(value.tools ?? [])],
    modelPolicy: {
      mode: value.modelPolicy?.mode ?? 'inherit',
      routes: structuredClone(value.modelPolicy?.routes ?? []),
    },
    memory: {
      read: [...(value.memory?.read ?? [])],
      write: [...(value.memory?.write ?? [])],
    },
    context: {
      handoff: value.context?.handoff ?? true,
      memory: value.context?.memory ?? false,
    },
  }
}

/** Fill schema-resolved defaults while keeping the native form authoritative. */
export function copyPolicy(value: Partial<UserPolicy> | undefined): UserPolicy | undefined {
  if (value === undefined) return undefined
  return {
    controllerPrompt: value.controllerPrompt ?? '',
    workspaces: structuredClone(value.workspaces ?? []),
    roles: (value.roles ?? []).map(role => copyRole(role)),
    memory: {
      mode: value.memory?.mode ?? 'disabled',
      autoAuthorized: value.memory?.autoAuthorized ?? false,
      providers: [...(value.memory?.providers ?? [])],
      controllerRead: [...(value.memory?.controllerRead ?? [])],
      controllerWrite: [...(value.memory?.controllerWrite ?? [])],
    },
  }
}

/** Draft the optional runtime overrides as strings, blank meaning "no override". */
export function copyRuntime(value: Partial<ThalirisSettings> | undefined): RuntimeDraft {
  return {
    pythonExecutable: value?.pythonExecutable ?? '',
    corePath: value?.corePath ?? '',
    authorityDirectory: value?.authorityDirectory ?? '',
  }
}

/** Absolute Windows, Windows UNC or POSIX path; the host rejects relative overrides at use. */
function absolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function invalidRuntimeFields(runtime: RuntimeDraft | undefined, fields: readonly RuntimeField[]): RuntimeField[] {
  if (runtime === undefined) return []
  return fields.filter(field => {
    const value = runtime[field].trim()
    return value !== '' && !absolutePath(value)
  })
}

function validationError(policy: UserPolicy | undefined): string | undefined {
  if (policy === undefined) return undefined
  const ids = policy.roles.map(role => role.id.trim())
  if (ids.some(id => id.length === 0)) return 'Role IDs cannot be empty.'
  if (new Set(ids).size !== ids.length) return 'Each role needs a unique ID.'
  if (policy.roles.some(role => role.modelPolicy.mode === 'fixed' && role.modelPolicy.routes.length !== 1)) {
    return 'A fixed model policy needs exactly one allowed route.'
  }
  return undefined
}

/**
 * Enabled roles whose native tool grants are empty, each paired with the shipped
 * role template that recommends tools for its id. Nothing here writes anything.
 */
export function roleRecommendations(roles: readonly RoleRecord[], templates: readonly RoleRecord[]): RoleRecommendation[] {
  return roles.flatMap((role, index) => {
    if (!role.enabled || role.tools.length > 0) return []
    const template = templates.find(candidate => candidate.id === role.id)
    return [{ index, role, template, tools: template?.tools ?? [] }]
  })
}

/** Replace only the recommended roles' empty grants; undefined means nothing to apply. */
export function withRecommendedTools(roles: readonly RoleRecord[], recommendations: readonly RoleRecommendation[]): RoleRecord[] | undefined {
  const applicable = new Map(recommendations
    .filter(recommendation => recommendation.tools.length > 0)
    .map(recommendation => [recommendation.index, recommendation.tools] as const))
  if (applicable.size === 0) return undefined
  return roles.map((role, index) => {
    const tools = applicable.get(index)
    return tools === undefined ? role : { ...role, tools: [...tools] }
  })
}

/** Owns only transient drafts; every accepted value and write remains in native Settings. */
export class PolicyEditorController {
  readonly store: SnapshotStore<PolicyEditorState>
  private readonly dirtyFields = new Set<PolicyField>()
  private readonly dirtyRuntimeFields = new Set<RuntimeField>()
  private draft: UserPolicy | undefined
  private runtime: RuntimeDraft | undefined
  private expectedRevision: number | undefined
  private saving = false
  private conflict = false
  private error: string | undefined
  private native: ConfigFormSnapshot<ThalirisSettings>
  private readonly unsubscribe: () => void

  constructor(private readonly form: ConfigForm<ThalirisSettings>) {
    this.native = form.getSnapshot()
    this.draft = copyPolicy(this.native.value?.policy)
    this.runtime = copyRuntime(this.native.value)
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = form.subscribe(() => this.onNativeChange())
  }

  getSnapshot = (): PolicyEditorState => this.store.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  edit<K extends PolicyField>(field: K, value: UserPolicy[K]): void {
    if (!this.canEdit()) return
    if (this.expectedRevision === undefined) this.expectedRevision = this.native.revision
    const draft = copyPolicy(this.draft)
    if (draft === undefined) return
    draft[field] = structuredClone(value)
    this.draft = draft
    this.dirtyFields.add(field)
    this.error = undefined
    this.conflict = this.native.revision !== this.expectedRevision
    this.publish()
  }

  /** Stage one optional runtime path override; blank clears it on save. */
  editRuntime(field: RuntimeField, value: string): void {
    if (!this.canEdit()) return
    if (this.expectedRevision === undefined) this.expectedRevision = this.native.revision
    this.runtime = { ...(this.runtime ?? copyRuntime(undefined)), [field]: value }
    this.dirtyRuntimeFields.add(field)
    this.error = undefined
    this.conflict = this.native.revision !== this.expectedRevision
    this.publish()
  }

  /** Stage and write the shipped native tool grants for empty, enabled roles. */
  async applyRecommended(templates: readonly RoleRecord[]): Promise<boolean> {
    const current = this.project()
    if (!current.draft || !current.writable || current.conflict || current.saving) return false
    const next = withRecommendedTools(current.draft.roles, roleRecommendations(current.draft.roles, templates))
    if (next === undefined) return false
    this.edit('roles', next)
    return await this.save()
  }

  async save(): Promise<boolean> {
    const current = this.project()
    if (!current.dirty || !current.writable || current.conflict || current.validationError
      || current.runtimeInvalid.length > 0 || this.saving || this.expectedRevision === undefined
      || this.draft === undefined) return false
    const revision = this.expectedRevision
    const operations = [
      ...[...this.dirtyFields].map(field => ({
        op: 'set' as const,
        path: ['policy', field],
        value: z.json().parse(this.draft![field]),
      })),
      ...[...this.dirtyRuntimeFields].map(field => {
        const value = (this.runtime ?? copyRuntime(undefined))[field].trim()
        return value === ''
          ? { op: 'unset' as const, path: [field as string] }
          : { op: 'set' as const, path: [field as string], value: z.json().parse(value) }
      }),
    ]
    this.saving = true
    this.error = undefined
    this.publish()
    try {
      const accepted = await this.form.mutate(operations, revision)
      if (!accepted) {
        this.conflict = true
        this.error = 'The native Settings revision changed. Reload its latest values before editing again.'
        return false
      }
      this.dirtyFields.clear()
      this.dirtyRuntimeFields.clear()
      this.expectedRevision = undefined
      this.conflict = false
      this.draft = copyPolicy(this.form.getSnapshot().value?.policy)
      this.runtime = copyRuntime(this.form.getSnapshot().value)
      return true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      this.saving = false
      this.native = this.form.getSnapshot()
      this.publish()
    }
  }

  /** Drop this page's drafts and re-read the latest native snapshot. */
  discard(): void {
    this.native = this.form.getSnapshot()
    this.draft = copyPolicy(this.native.value?.policy)
    this.runtime = copyRuntime(this.native.value)
    this.expectedRevision = undefined
    this.dirtyFields.clear()
    this.dirtyRuntimeFields.clear()
    this.saving = false
    this.conflict = false
    this.error = undefined
    this.publish()
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
  }

  private canEdit(): boolean {
    return this.native.status === 'ready' && this.native.writable && this.native.mode === 'host'
      && !this.saving && !this.conflict && this.draft !== undefined && this.native.revision !== undefined
  }

  private onNativeChange(): void {
    this.native = this.form.getSnapshot()
    if (this.saving) {
      this.publish()
      return
    }
    if (this.dirtyFields.size === 0) this.draft = copyPolicy(this.native.value?.policy)
    if (this.dirtyRuntimeFields.size === 0) this.runtime = copyRuntime(this.native.value)
    if (this.dirtyFields.size > 0 || this.dirtyRuntimeFields.size > 0) {
      if (this.native.revision !== this.expectedRevision) this.conflict = true
    }
    this.publish()
  }

  private project(): PolicyEditorState {
    const writable = this.native.status === 'ready' && this.native.writable && this.native.mode === 'host'
    const dirtyFields = [...this.dirtyFields]
    const dirtyRuntimeFields = [...this.dirtyRuntimeFields]
    return {
      native: this.native,
      draft: this.draft,
      runtime: this.runtime,
      dirtyFields,
      dirtyRuntimeFields,
      runtimeInvalid: invalidRuntimeFields(this.runtime, dirtyRuntimeFields),
      saving: this.saving,
      conflict: this.conflict,
      error: this.error,
      validationError: validationError(this.draft),
      dirty: dirtyFields.length > 0 || dirtyRuntimeFields.length > 0,
      writable,
      available: this.native.status === 'ready' && this.draft !== undefined,
    }
  }

  private publish(): void {
    this.store.set(this.project())
  }
}
