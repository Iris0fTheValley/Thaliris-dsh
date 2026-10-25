// DSH's tool runtime exposes one call per `execute` on the released 0.2.1 line
// and a batch `{ calls, results }` shape on later master revisions of the same
// version. The adapter tests only need "run these calls as this agent", so they
// probe the runtime they were given instead of declaring a version: a batch
// result passes through, and a one-call runtime is driven call by call.
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface ScriptedCall {
  id: string
  name: string
  arguments: string
}

export interface ScriptedBatch {
  calls: ScriptedCall[]
  agent?: Agent
  signal: AbortSignal
}

/** Execute one or more tool calls and normalize to the batch `{ results }` shape. */
export async function executeCalls(ctx: any, input: ScriptedBatch): Promise<{ results: { result: any }[] }> {
  let batch: any
  try { batch = await ctx.tools.execute(input) } catch { batch = undefined }
  if (batch && Array.isArray(batch.results)) return batch
  const results: { result: any }[] = []
  for (const call of input.calls) {
    const result = await ctx.tools.execute({
      callId: ToolCallId(call.id),
      name: call.name,
      arguments: JSON.parse(call.arguments),
      ...(input.agent ? { agent: input.agent } : {}),
      signal: input.signal,
    })
    results.push({ result })
  }
  return { results }
}
