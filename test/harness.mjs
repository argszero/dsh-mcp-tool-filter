/**
 * The integration harness: a REAL cordis context carrying the REAL
 * `@deepseek-ai/dsh-tools` registry.
 *
 * Nothing about the seam is simulated. The plugin's whole claim is that a shadow
 * on the live registry instance is seen by a caller that reaches the registry
 * through `ctx.tools` — and the caller that matters, `mcp-client`, calls
 * `ctx.tools.register(...)` by name lookup at call time, never having captured
 * the service. So the harness issues its registrations through `ctx.tools` (the
 * view), exactly as `syncTools()` does, and then reads the registry back through
 * the registry's own projection (`schemas()`) to ask the only question that
 * counts: is the tool there, or is it not?
 *
 * Ordering is load-bearing twice over, and both are the plugin's real
 * preconditions rather than test conveniences:
 *
 * - `@deepseek-ai/dsh-system-prompt` is mounted **before** `dsh-tools`, which
 *   injects it. Without it the tools fiber stays PENDING (`state 0`) and the
 *   mount silently does nothing.
 * - the {@link recorder} goes in **before** the plugin, so it sits underneath
 *   the shadow and records what the plugin let through. A recorder installed
 *   afterwards would see nothing but its own wrapper.
 *
 * @module test/harness
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import systemPrompt from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/** The key the vendored traceable proxy stores its target under. */
export const ORIGINAL = Symbol.for('cordis.original')

/** Let a mount's effects settle. Cordis applies effects asynchronously. */
export async function settle(milliseconds = 25) {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * A context with a live registry, an optional recorder, and an optional mount.
 *
 * `plugin: false` defers the mount to the caller, which is how a test puts tools
 * in the registry *before* the shadow exists — the ordering a profile gets when
 * it lists the filter after the `mcp-client` rows. `plugin: 'default'` mounts
 * the object a loader entry reaches rather than this module's namespace; the two
 * differ by the `Config` key (see `test/mount.spec.mjs`).
 * @param spec - `plugin`, `config`, and whether to install a recorder first.
 * @returns the context, the captured log, the recorder, and the mount/dispose pair.
 */
export async function world(spec = {}) {
  const ctx = new Context()
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  await ctx.plugin(systemPrompt)
  await ctx.plugin(toolsPlugin)
  await settle()
  const harness = {
    ctx,
    logged,
    recorder: spec.record === false ? undefined : recorder(ctx),
    /** The mounted fork, once `mount()` has run. */
    fork: undefined,
    mount: async () => {
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      await settle()
      return harness
    },
    /** Mount the object a loader entry reaches. */
    mountDefault: async (config = spec.config ?? {}) => {
      harness.fork = await ctx.plugin(plugin.default, config)
      await settle()
      return harness
    },
    dispose: async () => {
      await harness.fork?.dispose()
      harness.fork = undefined
      await settle()
    },
  }
  if (spec.plugin !== false) await harness.mount()
  return harness
}

/** The service this plugin provides, or `undefined` when it did not mount one. */
export function service(harness) {
  return harness.ctx.get('mcpToolFilter')
}

/** Whether the plugin's shadow is currently installed on the registry instance. */
export function shadowInstalled(harness) {
  const inst = instance(harness.ctx, 'tools')
  if (!Object.hasOwn(inst, 'register')) return false
  // The recorder is itself an own property on the same instance, so "is there
  // an own property here?" answers a different question than "is the plugin's
  // shadow installed?". The recorder's own function is the floor: anything
  // above it is somebody else's wrapper.
  return inst.register !== harness.recorder?.fn
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}

/** The service instance behind the traceable view, which is where a write has to land. */
export function instance(ctx, name) {
  const view = ctx.get(name)
  return Reflect.get(view, ORIGINAL) ?? view
}

/**
 * Wrap the *real* `register` with a recorder.
 *
 * `seen` is "what reached the registry", which is a different list from "what
 * was proposed" — the difference is the plugin's whole subject.
 * @param ctx - the context from {@link world}.
 * @returns the recorded names, and a restore.
 */
export function recorder(ctx) {
  const inst = instance(ctx, 'tools')
  const seen = []
  const original = inst.register
  const wrapper = function (tool) {
    seen.push(tool.name)
    return original.call(this, tool)
  }
  inst.register = wrapper
  return {
    seen,
    /** The wrapper, so a caller can tell the plugin's shadow from this one. */
    fn: wrapper,
    restore() { inst.register = original },
  }
}

/**
 * Register a name the way `mcp-client` does: through `ctx.tools`, which is the
 * view, and by name lookup at call time.
 * @param ctx - the context.
 * @param name - the public tool name.
 * @returns the disposer the registry returned.
 */
export function propose(ctx, name) {
  return ctx.tools.register(definition(name))
}

/** The names the registry currently exposes, from its own projection. */
export function registeredNames(ctx) {
  return ctx.tools.schemas().map(schema => schema.name)
}

/** A registry-ready definition, through the harness's own fixture helper. */
export function definition(name) {
  return defineContentToolFixture({
    name,
    description: 'fixture',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  })
}

/**
 * `publicToolName()` from `packages/mcp/mcp-client/src/tools.ts`, reproduced.
 *
 * The published package does not export it (its entry exports `apply`, `Config`,
 * `createMcpToolDefinition`, `inject` and `name`), so the suite carries its own
 * copy to generate the names a real MCP server's tools arrive under. The copy is
 * pinned by `test/detect.spec.mjs` against the vectors the shipped function
 * produces, and `scripts/probe-lines.mjs` re-derives it from the published
 * bundle on every release line.
 * @param serverName - the configured server namespace.
 * @param rawName - the server's own tool name.
 * @returns the public name the registry would see.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`
}
