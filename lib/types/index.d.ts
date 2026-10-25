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
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
import type { FilterSnapshot } from './filter.ts';
export type { Config, FilterMode, ServerRule, Settings } from './config.ts';
export { MODES, SERVER_NAME, defaults, normalizeConfig } from './config.ts';
export type { IdleLeaf, Counters, Coverage, FilterLog, FilterSnapshot } from './filter.ts';
export { DROP_LIST_LIMIT, SEEN_LIMIT, ToolFilter } from './filter.ts';
export type { ServerMatch } from './detect.ts';
export { MCP_PREFIX, SERVER_SEPARATOR, isMcpName, matchServer } from './detect.ts';
/** Stable Loader identity. */
export declare const name = "mcp-tool-filter";
/** The capability whose `register` this plugin shadows. */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        mcpToolFilter: McpToolFilterService;
    }
}
/** The service this plugin provides: the state of the filter, and its own reset. */
export interface McpToolFilterService {
    /** Counters, the names kept out, and what the configuration did not cover, as of now. */
    snapshot(): FilterSnapshot;
    /** Zero the counters and the observed sets. The shadow and the configuration stay. */
    reset(): void;
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
export declare function apply(ctx: Context, config?: Config): void;
/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it carries a `Config`. This one
 * carries none — the defaults reach a mount through `apply(ctx, config = {})` —
 * because a `Config` here would have to be a real schema, and a plain defaults
 * object is the defect this family has shipped repeatedly.
 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map