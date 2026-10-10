/**
 * Per-server tool filtering for MCP servers, at registration.
 *
 * ## The gap
 *
 * `mcp-client` registers the whole discovered tool list of every connected
 * server, unconditionally
 * (`packages/mcp/mcp-client/src/tools.ts`, the swap loop at the end of
 * `syncTools()`):
 *
 * ```
 * for (const [publicName, definition] of definitions) {
 *   disposers.set(publicName, ctx.tools.register(definition))
 * }
 * ```
 *
 * `registrationFailure` decides what a *namespace collision* does — roll the
 * generation back, or throw. Nothing decides what a tool the deployment does not
 * want does. A server advertising 161 tools therefore puts 161 tools, and their
 * full JSON schemas, into every request that assembles the tool surface, whether
 * or not the deployment uses five of them.
 *
 * ## Why this cannot be done with `restrict()`
 *
 * `ctx.tools.restrict()` (`packages/core/tools/src/index.ts`) is the neighbouring
 * API, and it is not the same thing three ways over. It requires a **scoped**
 * context — called on a global one it throws, by design, because a global
 * restriction would mask every agent. It **throws on unknown names**, which is
 * exactly the composition drift a `tools/list` that changes between boots
 * produces. And it is a **mask over** the global layer: the definition stays
 * registered, stays in the registry, and stays visible to introspection. The
 * reporter's first semantic — the tool is never registered — is not reachable
 * from there.
 *
 * ## Where it attaches
 *
 * The tool registry is a cordis service, one instance per context, and the
 * traceable view other callers hold forwards its reads to that instance
 * (`ctx.get('tools')[Symbol.for('cordis.original')]`). A write to the
 * **instance** is therefore seen by every reader — including `mcp-client`, which
 * calls `ctx.tools.register(...)` by name lookup at call time — while a write to
 * the view would be visible only to the writer. The shadow is installed on the
 * instance and never on the prototype: a prototype belongs to whichever copy of
 * the package happened to be imported, and patching the wrong copy is a failure
 * this ecosystem has shipped more than once.
 *
 * ## Mount it before the `mcp-client` rows
 *
 * A loader mounts entries in the order a profile lists them, and `mcp-client`
 * registers its first generation while it starts. A filter mounted after those
 * rows has missed that generation, and a plugin cannot unregister another
 * plugin's tools. The snapshot records the MCP names it found already
 * registered ({@link Coverage.preExisting}) precisely so this is visible instead
 * of mysterious; the profile should list the filter first.
 *
 * ## What it deliberately does not do
 *
 * It never talks to a server, so it never changes what a server *lists* — only
 * what this process registers. It reads only public names, so a raw tool name
 * that `publicToolName()` normalized or hashed is seen in its public spelling.
 * It never throws into a registration: a name it cannot judge is forwarded
 * unchanged.
 *
 * @module @argszero/dsh-mcp-tool-filter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { normalizeConfig } from './config.ts'
import type { Config } from './config.ts'
import { ToolFilter } from './filter.ts'
import type { FilterSnapshot } from './filter.ts'

export type { Config, FilterMode, ServerRule, Settings } from './config.ts'
export { MODES, SERVER_NAME, defaults, normalizeConfig } from './config.ts'
export type { IdleLeaf, Counters, Coverage, FilterLog, FilterSnapshot } from './filter.ts'
export { DROP_LIST_LIMIT, SEEN_LIMIT, ToolFilter } from './filter.ts'
export type { ServerMatch } from './detect.ts'
export { MCP_PREFIX, SERVER_SEPARATOR, isMcpName, matchServer } from './detect.ts'

/** Stable Loader identity. */
export const name = 'mcp-tool-filter'

/** The capability whose `register` this plugin shadows. */
export const inject = ['tools']

/**
 * The key the vendored traceable proxy stores its target under
 * (`vendor/cordis/src/utils.ts`: `original: Symbol.for('cordis.original')`).
 *
 * Read through `Reflect` rather than declared as an interface member: the value
 * is a foreign object's private protocol, and a `[key: symbol]` index signature
 * would claim a type for something this plugin cannot verify.
 */
const ORIGINAL = Symbol.for('cordis.original')

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpToolFilter: McpToolFilterService
  }
}

/** The service this plugin provides: the state of the filter, and its own reset. */
export interface McpToolFilterService {
  /** Counters, the names kept out, and what the configuration did not cover, as of now. */
  snapshot(): FilterSnapshot
  /** Zero the counters and the observed sets. The shadow and the configuration stay. */
  reset(): void
}

/** The names currently registered, or an empty list when the registry cannot be read. */
function liveNames(view: ToolRuntime): string[] {
  try {
    return view.schemas().map(schema => schema.name)
  } catch {
    // A registry that cannot enumerate its own surface is not this plugin's
    // failure to report, and the catch-up warning is worth more than a throw
    // during a mount.
    return []
  }
}

/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the defaults live in `apply(ctx, config = {})` and not in an
 * exported `Config`: cordis calls `Config['~standard'].validate` on a plugin's
 * `Config`, and a plain defaults object has no such property, so naming one
 * there makes every mount of the installed package throw before this function
 * runs.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  const filter = new ToolFilter(settings, settings.mode, {
    info: message => { ctx.logger.info(message) },
    warn: message => { ctx.logger.warn(message) },
  })
  ctx.effect(() => {
    const view = ctx.get('tools')
    if (view === undefined) {
      // `inject` should have held the plugin until the service exists; reaching
      // here means it does not, and a filter that cannot be installed must say so
      // rather than report coverage it never observed.
      ctx.logger.warn('mcp-tool-filter: the tools service is not available; no tool was filtered')
      return () => {}
    }
    // The traceable view forwards reads to the instance behind it, and the
    // instance is where a write has to land for every other reader to see it.
    const underlying = (Reflect.get(view as object, ORIGINAL) as ToolRuntime | undefined) ?? view
    const original = underlying.register
    const ownRegister = Object.hasOwn(underlying, 'register')
    let installed = false
    try {
      Reflect.set(underlying, 'register', function (this: ToolRuntime, definition: ToolDefinition): () => void {
        return filter.handle(
          () => (definition as { name?: unknown } | null | undefined)?.name,
          () => original.call(this, definition),
        )
      })
      installed = true
      filter.patched = true
    } catch (error: unknown) {
      // A frozen or sealed provider. Reported, and reported as *not patched*:
      // `patched` is the difference between "nothing needed filtering" and
      // "nothing could be filtered".
      filter.patched = false
      ctx.logger.warn(`mcp-tool-filter: could not shadow register on the tools service: ${String(error)}`)
    }
    if (installed) {
      filter.notePreExisting(liveNames(view))
      const late = filter.snapshot().coverage.preExisting
      if (late.length > 0) {
        ctx.logger.warn(
          `mcp-tool-filter: ${late.length} MCP tool(s) are already registered (${late.slice(0, 5).join(', ')}`
          + `${late.length > 5 ? ', …' : ''}); this row is mounted after the mcp-client row that registered them,`
          + ' and a plugin cannot unregister another plugin\'s tools — list the filter first to cover them',
        )
      }
      if (settings.report) ctx.logger.info(`mcp-tool-filter: mounted in ${settings.mode} mode — ${filter.describeMount()}`)
    }
    return () => {
      if (!installed) return
      try {
        if (ownRegister) Reflect.set(underlying, 'register', original)
        else Reflect.deleteProperty(underlying, 'register')
      } catch (error: unknown) {
        ctx.logger.warn(`mcp-tool-filter: could not restore the tools service: ${String(error)}`)
      }
      filter.patched = false
      if (settings.report) ctx.logger.info(`mcp-tool-filter: unmounted — ${filter.describeUnmount()}`)
    }
  }, 'mcp-tool-filter: filter MCP tool registrations by their server')
  ctx.provide('mcpToolFilter', {
    snapshot: () => filter.snapshot(),
    reset: () => { filter.reset() },
  } satisfies McpToolFilterService)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it carries a `Config`. This one
 * carries none — the defaults reach a mount through `apply(ctx, config = {})` —
 * because a `Config` here would have to be a real schema, and a plain defaults
 * object is the defect this family has shipped repeatedly.
 */
export default { name, inject, apply }
