// Mirror of the bridge's dispose reason rule (core_bridge.py dispose): the bridge stays authoritative.
// Checked before any child is cancelled so a request the bridge would refuse has no side effect.
export const DISPOSE_REASON_MAX = 3500
export function validDisposeReason(reason) {
  return typeof reason === 'string' && reason.trim() !== '' && reason.length <= DISPOSE_REASON_MAX
}
