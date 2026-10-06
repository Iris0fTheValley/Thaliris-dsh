import z from '@deepseek-ai/schemastery'
import { roleTemplates } from './role-templates.mjs'
export { roleTemplates }

export const controllerTemplate = `Thaliris Controller contract:
Own task direction, scope, hard invariants, acceptance, context selection and next routing; implementation methods belong to executor. Thaliris records selected intent and mechanical observations, not semantic acceptance. Use the configured execution mode and user-owned model/tool/context policy. Select minimum suitable fresh roles by Workstream work shape, not mandatory stages or thresholds. Send a decision-complete bounded handoff: goal/acceptance, confirmed facts, hard invariants/decided boundaries, authoritative source and derived relationships, affected surfaces, usable verification entry and decision-changing unknowns. Include covered/uncovered scope from selected discovery; children reuse established inventory. Ordinary Implementer owns stable direction and deterministic convergence; Focused Implementer owns full reasoning/implementation/runtime-feedback/revision until core semantic convergence, then remaining ordinary closure goes to a fresh ordinary Implementer. Shared guidance cannot extend that endpoint.
Use a stable narrative base language and preserve precision-bearing original terms, quotations, distinctions and user formulations when translation would materially blur, broaden, narrow or expand meaning. Avoid forced monolingual translation, random language switching and bilingual repetition. Output language requirements still govern. Compression and handoff retain this precision-bearing representation. For operational artifact or installation acceptance, select the authoritative artifact, source, revision and provenance before delegation, or explicitly assign that selection to a later Workstream before its operational acceptance.
Installation closure means project/package build or install, fixtures, isolated smoke, packed artifacts and project-local verification. Effective live Host install/upgrade/uninstall, global instructions, profiles, hooks and trust require separate Host maintenance authority.
Classify remaining work as independently deterministic only when the accepted contract uniquely determines the behavior to preserve. Compatibility authority ambiguity remains semantic: when production behavior and historical fixtures leave authority undecided, Focused must supply representative evidence or return the dependency to Controller; this does not mandate full regression. Controller may reroute the same semantic closure to a fresh ordinary session when explicit inputs and independent acceptance suffice and accumulated debugging state adds no benefit. Carry distilled invariants, exact candidate, green evidence, provenance, remaining acceptance and blockers, not raw history. FINAL still ends the prior child session.
Reviewer is fresh independent and non-writing; critical acceptance needs supported evidence. Reopen direction/architecture/contract/invariant/scope/acceptance changes yourself; route bounded design-preserving defects to ordinary correction. Native completion is an observation, not acceptance.`
const route = z.object({ provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string() })
export const roleSchema = z.object({
  id: z.string().required(), name: z.string().required(), description: z.string().default(''), prompt: z.string().default(''),
  enabled: z.boolean().default(true), tools: z.array(z.string()).default([]),
  modelPolicy: z.object({ mode: z.union(['inherit', 'fixed', 'allowed'].map(z.const)).default('inherit'), routes: z.array(route).default([]) }).default({ mode: 'inherit', routes: [] }),
  memory: z.object({ read: z.array(z.string()).default([]), write: z.array(z.string()).default([]) }).default({ read: [], write: [] }),
  context: z.object({ handoff: z.boolean().default(true), memory: z.boolean().default(false) }).default({ handoff: true, memory: false }),
})
export const Config = z.object({
  pythonExecutable: z.string().required(), corePath: z.string().required(), authorityDirectory: z.string().required(),
  subagentProvider: z.string().default('spawn'), bridgeTimeoutMs: z.number().min(1).max(300000).default(30000),
  policy: z.object({
    controllerPrompt: z.string().default(controllerTemplate),
    workspaces: z.array(z.object({ workspaceId: z.string().required(), root: z.string().required(), enabled: z.boolean().default(true) })).default([]),
    roles: z.array(roleSchema).default([]),
    memory: z.object({ mode: z.union(['disabled', 'manual', 'suggest-review', 'auto'].map(z.const)).default('disabled'),
      autoAuthorized: z.boolean().default(false), providers: z.array(z.string()).default([]),
      controllerRead: z.array(z.string()).default([]), controllerWrite: z.array(z.string()).default([]),
    }).default({ mode: 'disabled', autoAuthorized: false, providers: [], controllerRead: [], controllerWrite: [] }),
  }).default({}).volatile(),
})

export function readPolicy(config) {
  return structuredClone(config.policy.get())
}

/** Validate only the role selected for execution; unrelated stored roles do not gate lifecycle reads. */
export function selectedRole(policy, id) {
  const matches = policy.roles.filter(role => role.id === id)
  if (matches.length !== 1 || !matches[0].enabled) throw new Error('THALIRIS_ROLE_NOT_CONFIGURED')
  const role = matches[0]
  if (!role.id.trim() || role.tools.some(tool => tool.startsWith('thaliris_task_') || tool === 'thaliris_workstream' || tool === 'thaliris_reconcile')) throw new Error('THALIRIS_INVALID_ROLE_POLICY')
  if (role.modelPolicy.mode === 'fixed' && role.modelPolicy.routes.length !== 1) throw new Error('THALIRIS_FIXED_ROUTE_REQUIRED')
  return role
}
