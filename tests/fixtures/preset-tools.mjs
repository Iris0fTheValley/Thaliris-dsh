// Native-test stand-in for the tool rows a real Agent preset mounts (for example
// the file and shell tools of DSH's `standard` preset). Import-free on purpose:
// the Loader resolves preset rows through Node's ESM resolver.
export const name = 'thaliris-test-preset-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: `Preset fixture tool ${tool}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: tool }] },
      execute: async () => ({ tool }),
    }))
  }
}
