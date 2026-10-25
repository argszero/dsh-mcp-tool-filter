/**
 * What a loader entry may ask for, and what the plugin refuses to guess.
 *
 * Every field is optional and every default lives in {@link normalizeConfig}.
 * The defaults are *not* exported as a `Config` on the plugin's default export:
 * cordis calls `Config['~standard'].validate` on a plugin's `Config`, a plain
 * defaults object has no such property, and naming one there makes every mount
 * of the installed package throw `reading 'validate'` before `apply` runs — the
 * defect this ecosystem has shipped more than once. A `Config` therefore has to
 * be a real schema or absent, and this plugin chooses absent.
 *
 * @module @argszero/dsh-mcp-tool-filter/config
 */
/** What the plugin does with an MCP tool that is not on its server's allowlist. */
export type FilterMode = 
/**
 * Answer the registration with a no-op disposer instead of forwarding it, so
 * the tool never enters the registry. The default: the gap is that a server's
 * whole tool list is registered unconditionally, and a mitigation an operator
 * has to arm twice is a mitigation that is off in the deployments that need it.
 */
'filter'
/**
 * Register everything and count what `filter` would have removed — the
 * posture to mount first, because it answers "how many of *this* deployment's
 * tools would survive?" with the deployment's own numbers rather than the
 * README's. Nothing is removed, so it is also the posture to leave running
 * when an operator wants the numbers without the change.
 */
 | 'observe'
/** Mount nothing at all: no shadow, no service, no counters. */
 | 'off';
/** The configuration a loader entry may pass. Every field is optional. */
export interface Config {
    /** What to do with a rejected tool; see {@link FilterMode}. */
    mode?: FilterMode;
    /**
     * The per-server allowlists, keyed by the `serverName` the operator wrote in
     * that server's `mcp-client` entry.
     *
     * A key that is **absent** means "this server is not filtered": every tool it
     * lists is registered exactly as before. A key mapped to an **empty array**
     * means "register nothing from this server" — the two are different answers
     * and the plugin keeps them apart.
     *
     * Entries are matched against the **public leaf name** —
     * `mcp__<serverName>__<rawName>` minus the prefix — because that is what the
     * registry sees. For a raw name that already satisfies the DeepSeek
     * function-name contract the two are identical; for one that does not, the
     * leaf is the normalized (and possibly hashed) spelling, and the raw name is
     * not recoverable from it.
     */
    servers?: Record<string, readonly string[]>;
    /** Whether the mount, first-rejection and unmount summaries are logged. Default true. */
    report?: boolean;
}
/** One server's allowlist, with the prefix it is matched by. */
export interface ServerRule {
    /** The key exactly as the operator wrote it. */
    readonly name: string;
    /**
     * The public-name prefix this rule matches, or `undefined` when no public
     * name can ever carry it — see {@link unmatchableReason}.
     */
    readonly prefix: string | undefined;
    /** Why {@link prefix} is `undefined`; present only when it is. */
    readonly unmatchableReason?: string;
    /** The leaf names admitted. Empty means "register nothing from this server". */
    readonly allow: readonly string[];
    /** The allowlist as a set, for the membership test on the registration path. */
    readonly admitted: ReadonlySet<string>;
}
/** The validated configuration, with every default resolved. */
export interface Settings {
    readonly mode: FilterMode;
    /** The rules, in the order the operator wrote them. */
    readonly servers: readonly ServerRule[];
    /** The rules by server key. */
    readonly byName: ReadonlyMap<string, ServerRule>;
    readonly report: boolean;
}
/** The modes, as a runtime list so validation and documentation cannot drift. */
export declare const MODES: readonly FilterMode[];
/** The configuration the plugin runs with when a loader entry passes nothing. */
export declare const defaults: Settings;
/** The `serverName` contract `mcp-client` validates before it connects (`[A-Za-z0-9_-]{1,32}`). */
export declare const SERVER_NAME: RegExp;
/**
 * Turn a loader entry's configuration into validated settings.
 *
 * Invalid values throw, which fails the mount: a filter whose configuration was
 * silently replaced by a default is a filter that reports success while doing
 * something else, and the operator who wrote the typo is the one person who
 * cannot see it.
 *
 * What is *not* an error is a well-formed key that matches nothing. Server names
 * and tool names are discovered at run time from a server this plugin never
 * talks to, so "configured but never seen" is a fact only the registration path
 * can establish; it is reported through the coverage snapshot rather than
 * guessed at mount.
 * @param config - whatever the loader entry passed, or `undefined` for nothing.
 * @returns the settings, with defaults resolved.
 */
export declare function normalizeConfig(config?: Config): Settings;
//# sourceMappingURL=config.d.ts.map