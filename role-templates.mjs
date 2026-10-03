// Native profile defaults are visible records; the user may replace or delete them.
export const roleTemplates = [
  ['investigator', 'Investigator', 'Gather and verify facts within the selected scope. Return concise findings with locations, unknowns and contradictions.'],
  ['implementer', 'Implementer', 'Execute the accepted direction for this bounded slice. Verify changed behavior and synchronize assigned documentation.'],
  ['focused-implementer', 'Focused Implementer', 'Implement a coherent candidate across the assigned coupled invariants. Return decision-changing unknowns to the Controller.'],
  ['reviewer', 'Reviewer', 'Independently challenge the selected candidate with evidence; do not implement or decide acceptance.'],
  ['curator', 'Curator', 'Propose selected memory changes for user review. Do not change memory policy or task authority.'],
].map(([id, name, prompt]) => ({ id, name, description: `${name} initial template`, prompt, enabled: true,
  tools: [], modelPolicy: { mode: 'inherit', routes: [] }, memory: { read: [], write: [] }, context: { handoff: true, memory: false } }))
