import { useId, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { RoleRecord, UserPolicy } from '../remote'
import type { PolicyEditorController, RuntimeDraft, RuntimeField } from './policy-controller.ts'
import { RUNTIME_FIELDS, roleRecommendations } from './policy-controller.ts'
import type { NativeProjectionController, NativeProjectionState } from './native-controller.ts'
import type { SetupController, SetupControllerState } from './setup-controller.ts'
import type { ModeController, ModeControllerState } from './mode-controller.ts'
import {
  canRestoreNativeDefault, canSetThalirisDefault, danglingDefault, effectiveDefaultId, isThalirisDefault,
  restoreNeeded, thalirisHealthy, thalirisRow,
} from './mode-controller.ts'
import { Button, Checkbox, Input, SegmentedTabs, SettingsForm, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, type LocaleKey } from './locales.ts'
import css from './ThalirisPage.module.css'

export interface ThalirisPageFace {
  hooks: {
    policy: PolicyEditorController['store']
    native: NativeProjectionController['store']
    setup: SetupController['store']
    mode: ModeController['store']
  }
  edit: PolicyEditorController['edit']
  editRuntime: (field: RuntimeField, value: string) => void
  save: () => void
  discard: () => void
  refresh: () => void
  loadDiagnostics: (sessionId: string, taskId: string) => void
  openPlugin: (packageName: string) => void
  openSession: (sessionId: string) => void
  approveMemory: (sessionId: string, taskId: string, proposalId: string) => void
  loadSetup: () => void
  prepareRuntime: () => void
  recheckRuntime: () => void
  setThalirisDefault: () => void
  restoreNativeDefault: () => void
  applyRecommended: (templates: readonly RoleRecord[]) => void
}

type Props = PropsRuntime<'plugins.item'> & PropsLocale<typeof NS> & InjectFace<ThalirisPageFace>
type Tab = 'general' | 'roles' | 'memory' | 'context' | 'diagnostics'

const TABS: readonly { id: Tab; key: LocaleKey }[] = [
  { id: 'general', key: 'tabGeneral' }, { id: 'roles', key: 'tabRoles' },
  { id: 'memory', key: 'tabMemory' }, { id: 'context', key: 'tabContext' },
  { id: 'diagnostics', key: 'tabDiagnostics' },
]

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, any> : undefined
}

function routeKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function exactRouteKey(route: { provider: string; model: string; reasoningEffort?: string }): string {
  return JSON.stringify([route.provider, route.model, route.reasoningEffort ?? null])
}

function routesOf(state: NativeProjectionState) {
  return state.modelCatalog?.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    modelName: model.name,
    efforts: model.reasoning?.efforts ?? [],
  }))) ?? []
}

function roleWith(role: RoleRecord, patch: Partial<RoleRecord>): RoleRecord {
  return { ...role, ...patch }
}

function duplicateRole(role: RoleRecord, roles: readonly RoleRecord[]): RoleRecord {
  const base = role.id.trim() || 'role'
  let id = `${base}-copy`
  for (let suffix = 2; roles.some(value => value.id === id); suffix++) id = `${base}-copy-${suffix}`
  return { ...structuredClone(role), id }
}

const SETUP_STATE_KEYS: Readonly<Record<string, LocaleKey>> = {
  unconfigured: 'stateUnconfigured', detecting: 'stateDetecting', provisioning: 'stateProvisioning',
  verifying: 'stateVerifying', ready: 'stateReady', failed: 'stateFailed',
}

function setupStateLabel(state: string, t: (key: LocaleKey) => string): string {
  const key = SETUP_STATE_KEYS[state]
  return key === undefined ? t('stateUnknown') : t(key)
}

function setupStateTone(state: string): TagTone {
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'danger'
  if (state === 'detecting' || state === 'provisioning' || state === 'verifying') return 'warning'
  return 'outline'
}

const SETUP_STEP_KEYS: Readonly<Record<string, LocaleKey>> = {
  'detect-python': 'setupStepDetectPython', 'fetch-source': 'setupStepFetchSource',
  'create-runtime': 'setupStepCreateRuntime', 'install-core': 'setupStepInstallCore',
  'verify-core': 'setupStepVerifyCore', 'write-manifest': 'setupStepWriteManifest',
  'verify-recorded': 'setupStepVerifyRecorded', 'verify-configured': 'setupStepVerifyConfigured',
  ready: 'setupStepReady',
}

function setupStepLabel(step: string | null | undefined, t: (key: LocaleKey) => string): string | undefined {
  if (!step) return undefined
  const key = SETUP_STEP_KEYS[step]
  return key === undefined ? step : t(key)
}

const SETUP_SOURCE_KEYS: Readonly<Record<string, LocaleKey>> = {
  provisioned: 'sourceProvisioned', recorded: 'sourceRecorded', configuration: 'sourceConfiguration', detected: 'sourceDetected',
}

function setupSourceLabel(source: string | null | undefined, t: (key: LocaleKey) => string): string | undefined {
  if (!source) return undefined
  const key = SETUP_SOURCE_KEYS[source]
  return key === undefined ? source : t(key)
}

function runtimeFieldLabel(field: RuntimeField, t: (key: LocaleKey) => string): string {
  return field === 'pythonExecutable' ? t('setupPythonOverride')
    : field === 'corePath' ? t('setupCoreOverride') : t('setupAuthorityOverride')
}

/**
 * The Settings page is root-scoped and owns no Session selection, so the explicit
 * "most recent Workspace" action uses the same native rule DSH applies when a flow
 * opens a Workspace without naming one: latest Session activity, then creation time.
 */
function recentWorkspaceId(
  workspaces: readonly { workspaceId: string; sessionIds: readonly string[]; createdAt: string }[],
  sessions: Readonly<Record<string, { updatedAt?: number } | undefined>>,
): string | undefined {
  let selected: string | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const updatedAt = sessions[sessionId]?.updatedAt
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) {
      const created = Date.parse(workspace.createdAt)
      if (Number.isFinite(created)) latest = created
    }
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export function ThalirisPage(props: Props) {
  const { t } = props
  const policy = props.usePolicy(state => state)
  const native = props.useNative(state => state)
  const setup = props.useSetup(state => state)
  const mode = props.useMode(state => state)
  const [tab, setTab] = useState<Tab>('general')
  const [templateId, setTemplateId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [copied, setCopied] = useState(false)
  const headingId = useId()
  const draft = policy.draft
  const shell: SettingsFormShell = {
    available: policy.available,
    writable: policy.writable,
    dirty: policy.dirty && policy.writable,
    invalid: Boolean(policy.validationError) || policy.conflict || policy.runtimeInvalid.length > 0,
    saving: policy.saving,
    failed: Boolean(policy.error),
  }
  const tfn = t as (key: LocaleKey) => string
  const templates = native.templates as RoleRecord[]
  const routeChoices = useMemo(() => routesOf(native), [native.modelCatalog])
  const edit = <K extends keyof UserPolicy>(field: K, value: UserPolicy[K]): void => props.edit(field as any, value as any)
  const editRole = (index: number, patch: Partial<RoleRecord>): void => {
    if (!draft) return
    const roles = draft.roles.map((role, i) => i === index ? roleWith(role, patch) : role)
    edit('roles', roles)
  }
  const editMemory = (patch: Partial<UserPolicy['memory']>): void => {
    if (draft) edit('memory', { ...draft.memory, ...patch })
  }
  const autoBind = setup.setup?.workspaceAutoBind ?? undefined
  const recentId = recentWorkspaceId(native.workspaces.items,
    native.sessions.byId as unknown as Readonly<Record<string, { updatedAt?: number } | undefined>>)
  const recentWorkspace = native.workspaces.items.find(row => row.workspaceId === recentId)

  if (props.view === 'summary') return t('summary')
  return (
    <div className={css.page}>
      <header className={css.header}>
        <div>
          <h2 className={css.title} id={headingId}>Thaliris</h2>
          <p className={css.summary}>{t('summary')}</p>
        </div>
        <Button onClick={props.refresh}>{t('projectionRefresh')}</Button>
      </header>
      <SegmentedTabs label={t('settingsLabel')} value={tab}
        onChange={value => setTab(value as Tab)} items={TABS.map(item => ({
          value: item.id, label: t(item.key), id: `${headingId}-tab-${item.id}`, panelId: `${headingId}-panel`,
        })) as [SegmentedTab<Tab>, ...SegmentedTab<Tab>[]]} />
      <SettingsForm labels={{
        unavailable: t('formUnavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'),
        save: t('save'), saving: t('saving'),
      }} state={shell} onSave={props.save} onDiscard={props.discard}>
        {policy.conflict ? <p className={css.error} role="alert">{t('conflict')}</p> : null}
        {policy.validationError ? <p className={css.error} role="alert">{policy.validationError}</p> : null}
        {policy.error ? <p className={css.error} role="alert">{policy.error}</p> : null}
        {policy.available && (!policy.writable || policy.conflict) ? <Button onClick={props.discard}>{t('discard')}</Button> : null}
        <fieldset className={css.fieldset} disabled={!policy.writable}>
        <legend className={css.visuallyHidden}>{t('settingsLabel')}</legend>
        {tab === 'general' && draft ? <>
          <SetupSection setup={setup} runtime={policy.runtime} runtimeInvalid={policy.runtimeInvalid}
            writable={policy.writable} editRuntime={props.editRuntime} t={tfn}
            onPrepare={props.prepareRuntime} onRecheck={props.recheckRuntime} onRefresh={props.loadSetup} />
          <ModeSection mode={mode} t={tfn}
            onSet={props.setThalirisDefault} onRestore={props.restoreNativeDefault} />
          <RecommendedPermissions draft={draft} native={native} t={tfn}
            disabled={!policy.writable || policy.saving} onApply={props.applyRecommended}
            onLoadTemplates={props.refresh} />
          <section className={css.section}>
            <h3>{t('generalTitle')}</h3><p>{t('generalHelp')}</p>
            <label className={css.field}><span>{t('controllerPrompt')}</span>
              <textarea value={draft.controllerPrompt} onChange={event => edit('controllerPrompt', event.currentTarget.value)} />
            </label>
          </section>
        </> : null}

        {tab === 'roles' && draft ? (
          <section className={css.section}>
            <div className={css.sectionHead}><div><h3>{t('rolesTitle')}</h3><p>{t('rolesHelp')}</p></div>
              <Button variant="primary" onClick={() => edit('roles', [...draft.roles, {
                id: '', name: '', description: '', prompt: '', enabled: true, tools: [],
                modelPolicy: { mode: 'inherit', routes: [] }, memory: { read: [], write: [] },
                context: { handoff: true, memory: false },
              }])}>{t('addRole')}</Button>
            </div>
            {native.templateStatus === 'idle' || native.templateStatus === 'error'
              ? <Button onClick={() => props.refresh()}>{t('loadTemplates')}</Button> : null}
            {native.templateStatus === 'error' ? <p>{t('templateUnavailable')}</p> : null}
            {templates.length ? <div className={css.inline}>
              <select value={templateId} onChange={event => setTemplateId(event.currentTarget.value)}>
                <option value="">{t('chooseTemplate')}</option>
                {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <Button disabled={!templateId || draft.roles.some(role => role.id === templateId)} onClick={() => {
                const template = templates.find(role => role.id === templateId)
                if (template) edit('roles', [...draft.roles, structuredClone(template)])
              }}>{t('addTemplate')}</Button>
            </div> : null}
            {draft.roles.length === 0 ? <p>{t('noRoles')}</p> : null}
            {draft.roles.map((role, index) => {
              const chosenRoutes = role.modelPolicy.routes
              const route = chosenRoutes[0]
              const selectedKey = route ? routeKey(route.provider, route.model) : ''
              const selectedChoice = routeChoices.find(candidate => routeKey(candidate.provider, candidate.model) === selectedKey)
              const routeUnavailable = role.modelPolicy.mode === 'fixed' && Boolean(route && !selectedChoice)
              const availableExactRoutes = routeChoices.flatMap(choice => [
                { ...choice, reasoningEffort: undefined, effortName: t('defaultEffort'), available: true },
                ...choice.efforts.map(effort => ({ ...choice, reasoningEffort: effort.id,
                  effortName: effort.name ?? effort.id, available: true })),
              ])
              const allowedChoices = [
                ...availableExactRoutes,
                ...chosenRoutes.filter(value => !availableExactRoutes.some(choice => exactRouteKey(choice) === exactRouteKey(value)))
                  .map(value => ({ ...value, providerName: value.provider, modelName: value.model,
                    effortName: value.reasoningEffort ?? t('defaultEffort'), available: false })),
              ]
              const updateRoute = (key: string): void => {
                const candidate = routeChoices.find(item => routeKey(item.provider, item.model) === key)
                if (!candidate) return
                const next = { provider: candidate.provider, model: candidate.model }
                editRole(index, { modelPolicy: { ...role.modelPolicy, routes: role.modelPolicy.mode === 'allowed'
                  ? [...role.modelPolicy.routes.filter(item => routeKey(item.provider, item.model) !== key), next]
                  : [next] } })
              }
              return <article className={css.card} key={`${role.id || 'draft'}-${index}`}>
                <div className={css.cardHead}><div><strong>{role.name || role.id || t('addRole')}</strong></div>
                  <Switch checked={role.enabled} label={`${t('enabled')}: ${role.name || role.id || index + 1}`}
                    onChange={enabled => editRole(index, { enabled })} />
                </div>
                <div className={css.grid}>
                  <label className={css.field}><span>{t('roleId')}</span><Input value={role.id} onChange={event => editRole(index, { id: event.currentTarget.value })} /></label>
                  <label className={css.field}><span>{t('roleName')}</span><Input value={role.name} onChange={event => editRole(index, { name: event.currentTarget.value })} /></label>
                  <label className={`${css.field} ${css.wide}`}><span>{t('roleDescription')}</span><Input value={role.description} onChange={event => editRole(index, { description: event.currentTarget.value })} /></label>
                </div>
                <label className={css.field}><span>{t('rolePrompt')}</span>
                  <textarea aria-label={t('rolePrompt')} value={role.prompt} onChange={event => editRole(index, { prompt: event.currentTarget.value })} />
                  <small>{t('rolePromptHelp')}</small></label>
                <div className={css.subsection}><h4>{t('modelPolicy')}</h4>
                  <label className={css.field}><span>{t('modelPolicy')}</span><select value={role.modelPolicy.mode} onChange={event => editRole(index, { modelPolicy: { ...role.modelPolicy,
                    mode: event.currentTarget.value as RoleRecord['modelPolicy']['mode'],
                    routes: event.currentTarget.value === 'inherit' ? [] : role.modelPolicy.routes,
                  } })}>
                    <option value="inherit">{t('inherit')}</option><option value="fixed">{t('fixed')}</option><option value="allowed">{t('allowed')}</option>
                  </select></label>
                  {role.modelPolicy.mode !== 'inherit' ? <>
                    {native.modelStatus === 'loading' ? <p>{t('modelCatalogLoading')}</p> : null}
                    {native.modelStatus !== 'ready' ? <p>{t('modelCatalogUnavailable')}</p> : null}
                    {routeUnavailable ? <p className={css.notice}>{t('unavailableRoute')}: {route?.provider}/{route?.model}</p> : null}
                    {role.modelPolicy.mode === 'fixed' ? <label className={css.field}><span>{t('selectedModel')}</span>
                      <select value={selectedKey} onChange={event => updateRoute(event.currentTarget.value)}>
                        <option value="">{t('noModels')}</option>{routeChoices.map(item => <option key={routeKey(item.provider, item.model)} value={routeKey(item.provider, item.model)}>{item.providerName} / {item.modelName}</option>)}
                      </select></label> : null}
                    {role.modelPolicy.mode === 'allowed' ? <div className={css.checkGrid}>{allowedChoices.map(item => {
                      const key = exactRouteKey(item)
                      const checked = role.modelPolicy.routes.some(value => exactRouteKey(value) === key)
                      return <div key={key} className={css.stack}>
                      <Checkbox checked={checked} label={item.available
                        ? `${item.providerName} / ${item.modelName} (${item.effortName})`
                        : `${item.provider}/${item.model} (${item.effortName}) — ${t('unavailableRoute')}`} onChange={next => {
                        const selected = role.modelPolicy.routes.filter(value => exactRouteKey(value) !== key)
                        if (next && item.available) selected.push({ provider: item.provider, model: item.model,
                          ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}) })
                        editRole(index, { modelPolicy: { ...role.modelPolicy, routes: selected } })
                      }} />
                      </div>
                    })}</div> : null}
                    {role.modelPolicy.mode === 'fixed' && selectedChoice?.efforts.length ? <label className={css.field}><span>{t('reasoningEffort')}</span>
                      <select value={route?.reasoningEffort ?? ''} onChange={event => {
                        if (!route) return
                        const next = { provider: route.provider, model: route.model, ...(event.currentTarget.value ? { reasoningEffort: event.currentTarget.value } : {}) }
                        editRole(index, { modelPolicy: { ...role.modelPolicy, routes: [next] } })
                      }}><option value="">{t('defaultEffort')}</option>{selectedChoice.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name ?? effort.id}</option>)}</select></label> : null}
                  </> : null}
                </div>
                <div className={css.subsection}><h4>{t('tools')}</h4>
                  {native.toolStatus !== 'ready' ? <><p>{t('toolsUnavailable')}</p>{role.tools.map(name =>
                    <Checkbox key={name} checked label={`${name} — ${t('toolUnavailable')}`} onChange={checked => {
                      if (!checked) editRole(index, { tools: role.tools.filter(value => value !== name) })
                    }} />)}</> : native.tools.length === 0 ? <><p>{t('noTools')}</p>{role.tools.map(name =>
                      <Checkbox key={name} checked label={`${name} — ${t('toolUnavailable')}`} onChange={checked => {
                        if (!checked) editRole(index, { tools: role.tools.filter(value => value !== name) })
                      }} />)}</> :
                    <div className={css.checkGrid}>{[...new Set([
                      ...native.tools.filter(tool => !tool.name.startsWith('thaliris_task_') && tool.name !== 'thaliris_reconcile' && tool.name !== 'thaliris_workstream' && tool.name !== 'thaliris_observe').map(tool => tool.name),
                      ...role.tools,
                    ])].map(name => {
                      const tool = native.tools.find(item => item.name === name)
                      const reserved = name.startsWith('thaliris_task_') || name === 'thaliris_reconcile' || name === 'thaliris_workstream' || name === 'thaliris_observe'
                      return <Checkbox key={name} checked={role.tools.includes(name)} disabled={reserved && !role.tools.includes(name)}
                        label={`${name}${tool?.description ? ` — ${tool.description}` : ` — ${t('toolUnavailable')}`}`} onChange={checked => {
                          const tools = role.tools.filter(value => value !== name)
                          if (checked) tools.push(name)
                          editRole(index, { tools })
                        }} />
                    })}</div>}
                </div>
                <div className={css.inlineActions}>
                  <Button onClick={() => {
                    const duplicate = duplicateRole(role, draft.roles)
                    edit('roles', [...draft.roles.slice(0, index + 1), duplicate, ...draft.roles.slice(index + 1)])
                  }}>{t('duplicateRole')}</Button>
                  <Button onClick={() => edit('roles', draft.roles.filter((_, i) => i !== index))}>{t('deleteRole')}</Button>
                </div>
                <RoleGrantControls role={role} index={index} providers={native.providers} t={tfn}
                  onRole={editRole} />
              </article>
            })}
          </section>
        ) : null}

        {tab === 'memory' && draft ? (
          <MemoryFields draft={draft} native={native} t={tfn} editMemory={editMemory}
            openPlugin={props.openPlugin} editRole={editRole} />
        ) : null}

        {tab === 'context' && draft ? (
          <section className={css.section}>
            <h3>{t('contextTitle')}</h3><p>{t('contextHelp')}</p>
            <div className={css.inline}><select value={workspaceId} onChange={event => setWorkspaceId(event.currentTarget.value)}>
              <option value="">{native.workspaces.phase === 'pending' ? t('workspaceLoading') : t('chooseWorkspace')}</option>
              {native.workspaces.items.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title} — {workspace.path}</option>)}
            </select><Button disabled={!workspaceId || draft.workspaces.some(row => row.workspaceId === workspaceId)} onClick={() => {
              const workspace = native.workspaces.items.find(row => row.workspaceId === workspaceId)
              if (workspace) edit('workspaces', [...draft.workspaces, { workspaceId: workspace.workspaceId, root: workspace.path, enabled: true }])
            }}>{t('bindWorkspace')}</Button></div>
            {!native.workspaces.items.length && native.workspaces.phase === 'ready' ? <p>{t('noWorkspaces')}</p> : null}
            <div className={css.stack}>{draft.workspaces.map((binding, index) => {
              const workspace = native.workspaces.items.find(row => row.workspaceId === binding.workspaceId)
              const autoBoundHere = autoBind?.workspaceId === binding.workspaceId
              return <div className={css.card} key={binding.workspaceId}>
                <div className={css.cardHead}><div><strong>{workspace?.title ?? binding.workspaceId}</strong><code>{binding.root}</code>
                  {autoBoundHere ? <p className={css.notice}>{t('workspaceAutoBound')}{autoBind?.at ? ` — ${t('workspaceAutoBindAt')}: ${autoBind.at}` : ''}</p> : null}
                  {!workspace ? <p className={css.notice}>{t('workspaceMissing')}</p> : null}</div>
                  <Switch checked={binding.enabled} label={`${t('workspaceEnabled')}: ${binding.workspaceId}`} onChange={enabled => {
                    const workspaces = [...draft.workspaces]; workspaces[index] = { ...binding, enabled }; edit('workspaces', workspaces)
                  }} />
                </div><Button onClick={() => edit('workspaces', draft.workspaces.filter((_, i) => i !== index))}>{t('removeWorkspace')}</Button>
              </div>
            })}</div>
            <p><small>{t('workspaceExplicitOnly')}</small></p>
            <div className={css.inline}>
              <Button disabled={!recentWorkspace || draft.workspaces.some(row => row.workspaceId === recentWorkspace.workspaceId)}
                onClick={() => {
                  if (recentWorkspace) edit('workspaces', [...draft.workspaces, { workspaceId: recentWorkspace.workspaceId, root: recentWorkspace.path, enabled: true }])
                }}>{t('workspaceBindRecent')}</Button>
              {recentWorkspace
                ? <span>{recentWorkspace.title} — {recentWorkspace.path}</span>
                : <span>{t('workspaceRecentMissing')}</span>}
            </div>
            <p><small>{t('workspaceBindRecentHint')}</small></p>
            {autoBind ? <div className={css.card}>
              <div className={css.cardHead}><div><strong>{t('workspaceAutoBoundTitle')}</strong><code>{autoBind.root}</code></div>
                <Tag tone="info">{t('workspaceAutoBound')}</Tag></div>
              {autoBind.at ? <p>{t('workspaceAutoBindAt')}: {autoBind.at}</p> : null}
              {draft.workspaces.some(row => row.workspaceId === autoBind.workspaceId) ? null : <p className={css.notice}>{t('workspaceAutoBindStale')}</p>}
            </div> : null}
            <p><small>{t('workspaceAutoBindHelp')}</small></p>
            <h3>{t('roleHandoff')}</h3>
            {draft.roles.map((role, index) => <div className={css.permissionRow} key={role.id || index}>
              <strong>{role.name || role.id || `Role ${index + 1}`}</strong>
              <Checkbox checked={role.context.handoff} label={t('roleHandoff')} onChange={checked => editRole(index, { context: { ...role.context, handoff: checked } })} />
              <Checkbox checked={role.context.memory} label={t('roleMemoryContext')} onChange={checked => editRole(index, { context: { ...role.context, memory: checked } })} />
            </div>)}
          </section>
        ) : null}
        </fieldset>

        {tab === 'diagnostics' ? <Diagnostics native={native} selectedSession={sessionId} setSelectedSession={value => {
          setSessionId(value)
          setTaskId('')
        }}
          selectedTask={taskId} setSelectedTask={setTaskId}
          copied={copied} setCopied={setCopied} t={tfn} loadDiagnostics={() => sessionId && taskId && props.loadDiagnostics(sessionId, taskId)}
          openSession={props.openSession} approveMemory={props.approveMemory} /> : null}
      </SettingsForm>
    </div>
  )
}

function RoleGrantControls({ role, index, providers, t, onRole }: {
  role: RoleRecord; index: number; providers: readonly { id: string; name: string }[];
  t: (key: LocaleKey) => string; onRole: (index: number, patch: Partial<RoleRecord>) => void
}) {
  const providerIds = [...new Set([...providers.map(provider => provider.id), ...role.memory.read, ...role.memory.write])]
  return <div className={css.subsection}><h4>{t('roleMemory')}: {role.name || role.id} ({role.id})</h4>
    {providerIds.map(id => {
      const provider = providers.find(value => value.id === id)
      const name = provider?.name ?? id
      return <div className={css.permissionRow} key={id}><strong>{name} ({id})</strong>
      <Checkbox checked={role.memory.read.includes(id)} label={`${t('roleRead')}: ${name}`} onChange={checked => {
        const read = role.memory.read.filter(value => value !== id); if (checked) read.push(id)
        onRole(index, { memory: { ...role.memory, read } })
      }} />
      <Checkbox checked={role.memory.write.includes(id)} label={`${t('roleWrite')}: ${name}`} onChange={checked => {
        const write = role.memory.write.filter(value => value !== id); if (checked) write.push(id)
        onRole(index, { memory: { ...role.memory, write } })
      }} />
      {provider ? null : <p className={css.notice}>{t('providerMissing')}: {id}</p>}
    </div>})}
  </div>
}

function MemoryFields({ draft, native, t, editMemory, openPlugin, editRole }: {
  draft: UserPolicy; native: NativeProjectionState; t: (key: LocaleKey) => string;
  editMemory: (patch: Partial<UserPolicy['memory']>) => void;
  openPlugin: (packageName: string) => void;
  editRole: (index: number, patch: Partial<RoleRecord>) => void
}) {
  const memory = draft.memory
  const toggle = (field: 'providers' | 'controllerRead' | 'controllerWrite', id: string, checked: boolean): void => {
    const values = memory[field].filter(value => value !== id)
    if (checked) values.push(id)
    editMemory({ [field]: values })
  }
  return <section className={css.section}>
    <h3>{t('memoryTitle')}</h3><p>{t('memoryHelp')}</p>
    <label className={css.field}><span>{t('memoryMode')}</span>
      <select value={memory.mode} onChange={event => editMemory({ mode: event.currentTarget.value as UserPolicy['memory']['mode'] })}>
        <option value="disabled">{t('modeDisabled')}</option><option value="manual">{t('modeManual')}</option>
        <option value="suggest-review">{t('modeSuggest')}</option><option value="auto">{t('modeAuto')}</option>
      </select></label>
    <div className={css.permissionRow}><Checkbox checked={memory.autoAuthorized} label={t('autoAuthorized')}
      onChange={autoAuthorized => editMemory({ autoAuthorized })} /><small>{t('autoAuthorizedHelp')}</small></div>
    <h4>{t('providers')}</h4>
    {native.providers.length === 0 ? <p>{t('noProviders')}</p> : null}
    {[...new Set([...native.providers.map(provider => provider.id), ...memory.providers, ...memory.controllerRead, ...memory.controllerWrite])]
      .map(id => {
        const provider = native.providers.find(value => value.id === id)
        const name = provider?.name ?? id
        return <div className={css.permissionRow} key={id}>
          <Checkbox checked={memory.providers.includes(id)} label={`${name} (${id}) — ${t('providerEnabled')}`}
            onChange={checked => toggle('providers', id, checked)} />
          <Checkbox checked={memory.controllerRead.includes(id)} label={`${t('controllerRead')}: ${name}`}
            onChange={checked => toggle('controllerRead', id, checked)} />
          <Checkbox checked={memory.controllerWrite.includes(id)} label={`${t('controllerWrite')}: ${name}`}
            onChange={checked => toggle('controllerWrite', id, checked)} />
          {provider ? null : <p className={css.notice}>{t('providerMissing')}: {id}</p>}
        </div>
      })}
    <div className={css.inlineActions}>
      <Button onClick={() => openPlugin('@thaliris/dsh-memory')}>{t('openMemoryPlugin')}</Button>
      <Button onClick={() => openPlugin('@thaliris/dsh-memory-local')}>{t('openLocalPlugin')}</Button>
    </div>
    {draft.roles.map((role, index) => <RoleGrantControls key={`${role.id || 'draft'}-${index}`} role={role} index={index}
      providers={native.providers} t={t} onRole={editRole} />)}
  </section>
}

function Diagnostics({ native, selectedSession, setSelectedSession, selectedTask, setSelectedTask, copied, setCopied, t, loadDiagnostics, openSession, approveMemory }: {
  native: NativeProjectionState; selectedSession: string; setSelectedSession: (value: string) => void;
  selectedTask: string; setSelectedTask: (value: string) => void;
  copied: boolean; setCopied: (value: boolean) => void; t: (key: LocaleKey) => string;
  loadDiagnostics: () => void; openSession: (sessionId: string) => void; approveMemory: (sessionId: string, taskId: string, proposalId: string) => void
}) {
  const roots = native.sessions.ids.map(id => native.sessions.byId[id])
    .filter(row => row && row.parentId === undefined && row.origin !== 'subagent')
  const data = record(native.diagnostics)
  const task = record(data?.task)
  const taskState = record(task?.state)
  const taskMatches = taskState?.task_id === selectedTask
  const pendingResults = (taskState?.pending_results ?? []).flatMap((item: unknown) => {
    try { return [typeof item === 'string' ? JSON.parse(item) : item] } catch { return [] }
  }).map(record).filter((item: Record<string, any> | undefined) => item) as Record<string, any>[]
  const proposals = pendingResults.filter(item => typeof item.proposal_id === 'string' && typeof item.approval_id !== 'string'
    && typeof item.provider === 'string' && typeof item.key === 'string' && typeof item.text === 'string' && item.provenance !== undefined)
  // Receipts are `dsh-memory-approval` adapter records; tasks written before
  // that may still carry them in pending results until their next write.
  const recordedReceipts = (Array.isArray(taskState?.records) ? taskState.records : []).map(record)
    .filter((item: Record<string, any> | undefined) => item?.kind === 'dsh-memory-approval' && item.producer === 'dsh:adapter' && typeof item.text === 'string')
    .flatMap((item: Record<string, any>) => { try { return [record(JSON.parse(item.text))?.receipt] } catch { return [] } })
    .map(record).filter((item: Record<string, any> | undefined) => item) as Record<string, any>[]
  const approvalReceipts = [...pendingResults, ...recordedReceipts].filter(item => typeof item.approval_id === 'string' && typeof item.proposal_id === 'string')
  const reservations = Array.isArray(data?.reservations) ? data.reservations : []
  const approved = new Set(approvalReceipts.map(value => value.proposal_id))
  return <section className={css.section}>
    <h3>{t('diagnosticsTitle')}</h3><p>{t('diagnosticsHelp')}</p>
    <div className={css.inline}><select value={selectedSession} onChange={event => setSelectedSession(event.currentTarget.value)}>
      <option value="">{t('selectSession')}</option>{roots.map(row => <option key={row.id} value={row.id}>{row.displayTitle} — {row.id}</option>)}
    </select><Input aria-label={t('selectTaskId')} placeholder={t('selectTaskId')} value={selectedTask} onChange={event => setSelectedTask(event.currentTarget.value)} />
    <Button disabled={!selectedSession || !selectedTask.trim() || native.diagnosticStatus === 'loading'} onClick={loadDiagnostics}>
      {native.diagnosticStatus === 'loading' ? t('diagnosticsLoading') : native.diagnosticStatus === 'ready' ? t('refreshDiagnostics') : t('loadDiagnostics')}
    </Button></div>
    {roots.length === 0 ? <p>{t('noRootSessions')}</p> : null}
    {native.diagnosticStatus === 'error' ? <p className={css.error}>{native.diagnosticError ?? t('diagnosticsUnavailable')}</p> : null}
    {data && !taskMatches ? <p className={css.notice}>{t('diagnosticsTaskChanged')}: {String(taskState?.task_id ?? '')}</p> : null}
    {data && taskMatches ? <>
      <div className={css.grid}>
        <InfoCard title={t('taskEvidence')} value={task} />
        <InfoCard title={t('workspaceEvidence')} value={data.workspace} />
        <InfoCard title={t('permissionsEvidence')} value={{ permissions: data.permissions, providers: data.providers }} />
      </div>
      <h4>{t('reservationEvidence')}</h4>
      {reservations.length === 0 ? <p>{t('noReservations')}</p> : reservations.map((item: unknown, index: number) => {
        const row = record(item) ?? {}
        const reservation = record(row.reservation) ?? {}
        const observation = record(row.native) ?? {}
        const outcome = observation.outcome
        const terminal = ['completed', 'aborted', 'error', 'max-tokens', 'blocked', 'interrupted'].includes(String(outcome))
        const resident = typeof observation.reason === 'string' && observation.reason.includes('resident')
        const action = terminal ? 'reconcile' : resident ? 'cancel-reconcile' : 'check'
        const args = { task_id: taskState?.task_id, base_revision: taskState?.revision, action }
        const copy = async (): Promise<void> => {
          try { await navigator.clipboard.writeText(json(args)); setCopied(true) } catch { setCopied(false) }
        }
        return <article className={css.card} key={`${reservation.workstream ?? 'reservation'}-${index}`}>
          <strong>{reservation.workstream ?? reservation.correlation ?? t('reservationEvidence')}</strong>
          <p>{t('outcome')}: {String(outcome ?? 'UNKNOWN')}</p>
          {!terminal ? <p className={css.notice}>{t('unknownOutcome')}</p> : null}
          {observation.child_id ? <div className={css.inline}>
            <code>{String(observation.child_id)}</code><Button onClick={() => openSession(String(observation.child_id))}>{t('openChildSession')}</Button>
          </div> : null}
          <p>{t('reconcileGuide')}</p><details><summary>{t('reconcileCommand')}</summary><pre>{json(args)}</pre></details>
          <Button onClick={() => { void copy() }}>{copied ? t('commandCopied') : t('copyCommand')}</Button>
        </article>
      })}
      <h4>{t('proposals')}</h4>
      {proposals.length === 0 ? <p>{t('noProposals')}</p> : proposals.map(proposal => {
        const memory = record(data.permissions)?.memory
        const canApprove = memory && memory.mode !== 'disabled' && memory.providers?.includes(proposal.provider)
          && memory.controllerWrite?.includes(proposal.provider)
        return <article className={css.card} key={proposal.proposal_id}>
          <strong>{proposal.proposal_id}</strong>
          <p>{t('proposalProvider')}: {proposal.provider}</p><p>{t('proposalKey')}: {proposal.key}</p>
          <p>{t('proposalText')}</p><pre>{String(proposal.text ?? '')}</pre>
          <p>{t('proposalProvenance')}: {json(proposal.provenance)}</p>
          {approved.has(proposal.proposal_id) ? <p>{t('alreadyApproved')}</p> : canApprove ?
            <Button variant="primary" disabled={!taskMatches || native.approvalStatus === 'saving'} onClick={() => approveMemory(selectedSession, selectedTask, proposal.proposal_id)}>{t('approveProposal')}</Button> :
            <p className={css.notice}>{t('noApprovalGrant')}</p>}
        </article>
      })}
      {approvalReceipts.length > 0 ? <InfoCard title={t('approvalReceipts')} value={approvalReceipts} /> : null}
      {native.approvalStatus === 'ready' ? <InfoCard title={t('proposalApproved')} value={native.approvalReceipt} /> : null}
      {native.approvalStatus === 'error' ? <>
        <p className={css.error}>{native.approvalError ?? t('approvalUncertain')}</p>
        {native.approvalError ? <p className={css.notice}>{t('approvalUncertain')}</p> : null}
      </> : null}
    </> : null}
  </section>
}

function InfoCard({ title, value }: { title: string; value: unknown }) {
  return <article className={css.card}><strong>{title}</strong><pre>{json(value)}</pre></article>
}

function SetupSection({ setup, runtime, runtimeInvalid, writable, editRuntime, t, onPrepare, onRecheck, onRefresh }: {
  setup: SetupControllerState; runtime: RuntimeDraft | undefined; runtimeInvalid: readonly RuntimeField[]
  writable: boolean; editRuntime: (field: RuntimeField, value: string) => void
  t: (key: LocaleKey) => string; onPrepare: () => void; onRecheck: () => void; onRefresh: () => void
}) {
  const data = setup.setup
  const runtimeInfo = data?.runtime
  const pin = data?.pin
  const busy = setup.action !== 'idle'
  const progress = data?.progress
  const progressStep = setupStepLabel(progress?.step, t)
  const prepareLabel = data?.state === 'failed' ? t('setupRetry')
    : data?.state === 'ready' ? t('setupPrepareAgain') : t('setupPrepare')
  const source = setupSourceLabel(runtimeInfo?.source, t)
  const pinLabel = pin?.version
    ? `${pin.version}${pin.commit ? ` @ ${pin.commit.slice(0, 12)}` : ''}`
    : pin?.error ? t('setupPinError') : undefined
  return <section className={css.section}>
    <div className={css.sectionHead}>
      <div><h3>{t('setupTitle')}</h3><p>{t('setupHelp')}</p></div>
      <div className={css.inlineActions}>
        <Button variant="primary" disabled={busy} onClick={onPrepare}>
          {busy && setup.action === 'preparing' ? t('setupPreparing') : prepareLabel}
        </Button>
        <Button disabled={busy} onClick={onRecheck}>
          {busy && setup.action === 'rechecking' ? t('setupRechecking') : t('setupRecheck')}
        </Button>
        <Button disabled={busy} onClick={onRefresh}>{t('setupRefresh')}</Button>
      </div>
    </div>
    <p>{t('setupFirstUse')}</p>
    {data ? <div className={css.inline}>
      <Tag tone={setupStateTone(data.state)}>{setupStateLabel(data.state, t)}</Tag>
      <Tag tone={data.verified ? 'success' : 'neutral'}>{data.verified ? t('setupVerified') : t('setupUnverified')}</Tag>
      {data.manual_override ? <Tag tone="info">{t('setupManualOverride')}</Tag> : null}
    </div> : null}
    {busy ? <p className={css.notice} role="status">
      {setup.action === 'preparing' ? t('setupPreparing') : t('setupRechecking')}
      {progressStep ? ` — ${progressStep}` : ''}
      {typeof progress?.elapsed_ms === 'number' ? ` (${Math.round(progress.elapsed_ms / 1000)}s)` : ''}
    </p> : null}
    {setup.actionError ? <p className={css.error} role="alert">{t('setupActionFailed')}: {setup.actionError}</p> : null}
    {setup.status === 'error'
      ? <p className={css.error} role="alert">{setup.error ? `${t('setupUnavailable')} ${setup.error}` : t('setupUnavailable')}</p>
      : null}
    {setup.status === 'loading' && !data ? <p>{t('setupStatusLoading')}</p> : null}
    {data ? <dl className={css.keyValues}>
      <dt>{t('setupAuthority')}</dt><dd>{data.authorityDirectory ?? t('setupNotConfigured')}</dd>
      <dt>{t('setupPython')}</dt><dd>{runtimeInfo?.pythonExecutable ?? t('setupNotConfigured')}</dd>
      <dt>{t('setupPythonVersion')}</dt><dd>{runtimeInfo?.python ?? '—'}</dd>
      <dt>{t('setupCoreVersion')}</dt><dd>{runtimeInfo?.version ?? '—'}</dd>
      <dt>{t('setupCorePath')}</dt><dd>{runtimeInfo?.corePath ?? '—'}</dd>
      <dt>{t('setupSource')}</dt><dd>{source ?? '—'}</dd>
      <dt>{t('setupVerifiedAt')}</dt><dd>{runtimeInfo?.verified_at ?? '—'}</dd>
      <dt>{t('setupPin')}</dt><dd>{pinLabel ?? '—'}</dd>
    </dl> : null}
    {data && data.state === 'failed' ? <div className={css.card}>
      <strong>{t('setupErrorLabel')}</strong>
      {data.code ? <p>{t('setupCodeLabel')}: <code>{data.code}</code></p> : null}
      {data.recovery ? <p>{t('setupRecoveryLabel')}: {data.recovery}</p> : null}
      {data.detail ? <p>{t('setupDetailLabel')}: {data.detail}</p> : null}
    </div> : null}
    <h4>{t('setupOverridesTitle')}</h4>
    <p>{t('setupOverridesHelp')}</p>
    <div className={css.grid}>
      {RUNTIME_FIELDS.map(field => <label className={css.field} key={field}>
        <span>{runtimeFieldLabel(field, t)}</span>
        <Input aria-label={runtimeFieldLabel(field, t)} value={runtime?.[field] ?? ''} disabled={!writable}
          aria-invalid={runtimeInvalid.includes(field) ? true : undefined}
          onChange={event => editRuntime(field, event.currentTarget.value)} />
        {runtimeInvalid.includes(field) ? <small className={css.error}>{t('setupInvalidLocation')}</small> : null}
      </label>)}
    </div>
    <p><small>{t('setupOverridesSaveHint')}</small></p>
  </section>
}

function ModeSection({ mode, t, onSet, onRestore }: {
  mode: ModeControllerState; t: (key: LocaleKey) => string; onSet: () => void; onRestore: () => void
}) {
  const row = thalirisRow(mode)
  const healthy = thalirisHealthy(mode)
  const isDefault = isThalirisDefault(mode)
  const dangling = danglingDefault(mode)
  const effective = effectiveDefaultId(mode)
  return <section className={css.section}>
    <h3>{t('modeTitle')}</h3><p>{t('modeHelp')}</p>
    {mode.status === 'loading' ? <p>{t('modeRosterLoading')}</p> : null}
    {mode.status === 'unavailable' ? <p className={css.notice}>{t('modeRegistryUnavailable')}</p> : null}
    {mode.status === 'error'
      ? <p className={css.error} role="alert">{t('modeRegistryError')}{mode.error ? `: ${mode.error}` : ''}</p>
      : null}
    {mode.status === 'ready' ? <>
      <div className={css.inline}>
        <span>{t('modePresetHealth')}:</span>
        <Tag tone={row ? (healthy ? 'success' : 'danger') : 'outline'}>
          {row ? (healthy ? t('modeHealthy') : t('modeBroken')) : t('modeMissing')}
        </Tag>
        <span>{t('modeDefaultLabel')}:</span>
        <Tag tone={dangling ? 'danger' : isDefault ? 'warning' : 'neutral'}>
          {dangling ? t('modeNoDefault') : isDefault ? t('modeIsDefault') : t('modeIsOtherDefault')}
        </Tag>
      </div>
      {row?.broken ? <p className={css.error}>{t('modeBrokenDetail')} <code>{row.broken}</code></p> : null}
      {mode.registryAvailable ? null : <p className={css.notice}>{t('modeSettingsUnavailable')}</p>}
      {mode.presets.length === 0 ? <p>{t('modeRosterEmpty')}</p> : null}
      <dl className={css.keyValues}>
        <dt>{t('modeNativeDefault')}</dt><dd>{mode.nativeDefault ?? '—'}</dd>
        <dt>{t('modeSelectedDefault')}</dt><dd>{mode.selectedDefault ?? '—'}</dd>
        <dt>{t('modeDefaultLabel')}</dt><dd>{effective ?? '—'}</dd>
      </dl>
      {dangling ? <p className={css.error} role="alert">{t('modeDanglingResolve')}</p> : null}
      {isDefault ? <p className={css.notice}>{t('modeDanglingWarning')}</p> : null}
      <div className={css.inlineActions}>
        <Button variant="primary" disabled={!canSetThalirisDefault(mode)} onClick={onSet}>
          {t('modeSetDefault')}
        </Button>
        {restoreNeeded(mode)
          ? <Button disabled={!canRestoreNativeDefault(mode)} onClick={onRestore}>{t('modeRestoreDefault')}</Button>
          : null}
      </div>
      {mode.saving ? <p className={css.notice} role="status">{t('modeSavingDefault')}</p> : null}
      {mode.saveError ? <p className={css.error} role="alert">{t('modeWriteFailed')}: {mode.saveError}</p> : null}
      <p><small>{t('modeNoAutoWrite')}</small></p>
    </> : null}
  </section>
}

function RecommendedPermissions({ draft, native, t, disabled, onApply, onLoadTemplates }: {
  draft: UserPolicy; native: NativeProjectionState; t: (key: LocaleKey) => string
  disabled: boolean; onApply: (templates: readonly RoleRecord[]) => void; onLoadTemplates: () => void
}) {
  const templates = native.templates as RoleRecord[]
  const recommendations = roleRecommendations(draft.roles, templates)
  const catalog = new Set(native.tools.map(tool => tool.name))
  const applicable = recommendations.some(recommendation => recommendation.tools.length > 0)
  return <section className={css.section}>
    <h3>{t('recommendedTitle')}</h3><p>{t('recommendedHelp')}</p>
    {native.templateStatus !== 'ready' && recommendations.length > 0 ? <div className={css.inline}>
      <p>{t('templateUnavailable')}</p>
      <Button onClick={onLoadTemplates}>{t('loadTemplates')}</Button>
    </div> : null}
    {recommendations.length === 0 ? <p>{t('recommendedNone')}</p> : <div className={css.stack}>
      {recommendations.map(recommendation => <article className={css.card} key={recommendation.role.id || recommendation.index}>
        <div className={css.cardHead}>
          <div><strong>{recommendation.role.name || recommendation.role.id}</strong><code>{recommendation.role.id}</code></div>
          <Tag tone={recommendation.tools.length > 0 ? 'warning' : 'outline'}>
            {t('recommendedCurrent')}: {recommendation.role.tools.length}
          </Tag>
        </div>
        {recommendation.template ? <div className={css.subsection}>
          <h4>{t('recommendedTools')}</h4>
          <div className={css.checkGrid}>{recommendation.tools.map(name => <div className={css.stack} key={name}>
            <code>{name}</code>
            <small>{native.toolStatus === 'ready'
              ? (catalog.has(name) ? t('recommendedInCatalog') : t('recommendedNotInCatalog'))
              : t('recommendedCatalogMissing')}</small>
          </div>)}</div>
        </div> : native.templateStatus === 'ready'
          ? <p className={css.notice}>{t('recommendedNoTemplate')}</p>
          : <p className={css.notice}>{t('recommendedTemplatesPending')}</p>}
      </article>)}
      <div className={css.inlineActions}>
        <Button variant="primary" disabled={disabled || !applicable} onClick={() => onApply(templates)}>
          {t('recommendedApply')}
        </Button>
      </div>
      <p><small>{t('recommendedHint')}</small></p>
    </div>}
  </section>
}
