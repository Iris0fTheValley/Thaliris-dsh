import { writeFileSync } from 'node:fs'
import { roleTemplates } from './role-templates.mjs'
// Shipped rows are ENABLED with tolerant config (design §6): a fresh install must be
// usable without hand-editing a profile patch. Role templates are stored records; an
// explicit [] remains empty and existing user rows are never rewritten by the plugin.
// Runtime paths are intentionally absent: they are optional schema fields resolved at
// use time, so this row activates on any host, including headless without a runtime.
writeFileSync(new URL('./cordis.patch.yml', import.meta.url), JSON.stringify([{ insert: [
  { id: 'thaliris', name: '@thaliris/dsh-plugin', config: { policy: { roles: roleTemplates } } },
  { id: 'thaliris-api', name: '@thaliris/dsh-plugin/api' },
] }], null, 2) + '\n')
