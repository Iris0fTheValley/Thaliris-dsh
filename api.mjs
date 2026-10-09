import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const initializers = []
/** Native Gateway binding. User policy writes remain on remote.settings. */
export default class ThalirisController extends TypertRemoteService {
  static inject = ['thaliris']
  constructor(ctx) {
    super(ctx, 'thalirisController', { namespace: 'thaliris' })
    for (const initialize of initializers) initialize.call(this)
  }
  templates() { return this.ctx.thaliris.templates() }
  providers() { return this.ctx.thaliris.providers() }
  toolCatalog() { return this.ctx.thaliris.toolCatalog() }
  diagnostics(sessionId, taskId, signal) {
    identity(sessionId); identity(taskId)
    return this.ctx.thaliris.diagnostics(sessionId, taskId, signal)
  }
  /** Human-client approval endpoint, deliberately absent from model tools. */
  approveMemory(sessionId, taskId, proposalId, signal) {
    identity(sessionId); identity(taskId); identity(proposalId)
    return this.ctx.thaliris.approveMemory(sessionId, taskId, proposalId, signal)
  }
}
function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('THALIRIS_NATIVE_ID_REQUIRED')
}
// Native standard-decorator API used from JavaScript without a custom wire schema.
for (const name of ['templates', 'providers', 'toolCatalog', 'diagnostics', 'approveMemory']) {
  Remote(ThalirisController.prototype[name], { kind: 'method', name, static: false, private: false,
    addInitializer(initialize) { initializers.push(initialize) } })
}
