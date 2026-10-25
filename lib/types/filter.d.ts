/**
 * The decision one registration gets, and the bookkeeping that makes it
 * checkable afterwards.
 *
 * A filter that removes tools silently is indistinguishable from a broken
 * deployment: the tools simply are not there, and nothing says whether that was
 * the allowlist, a typo in a server key, or a server that never connected. Every
 * path through {@link ToolFilter} therefore lands in the snapshot, including the
 * ones that did nothing — the served leaf set, the allowlist entries that never
 * matched anything, and the servers whose prefix no registration ever carried.
 *
 * @module @argszero/dsh-mcp-tool-filter/filter
 */
import type { FilterMode, Settings } from './config.ts';
/** How many dropped names the snapshot remembers before it starts counting only. */
export declare const DROP_LIST_LIMIT = 256;
/** How many observed leaves one server's coverage keeps before it stops growing. */
export declare const SEEN_LIMIT = 512;
/** Where the filter's own lines go. Structural, so a test can pass a collector. */
export interface FilterLog {
    info(message: string): void;
    warn(message: string): void;
}
/** Running totals over every registration the shadow saw. */
export interface Counters {
    /** Every `register()` call, whatever the name was. */
    considered: number;
    /** Calls forwarded to the real registry. */
    admitted: number;
    /** Calls answered with a no-op disposer instead of a registration. */
    dropped: number;
    /** Names `filter` mode would have dropped while `observe` mode admitted them. */
    wouldDrop: number;
    /** String names outside the MCP namespace — every core and plugin tool. */
    nonMcp: number;
    /** MCP registrations whose server no configured key names. */
    unlistedServer: number;
    /** Registrations carrying no string name, which no allowlist can judge. */
    unjudgeable: number;
}
/** An allowlist entry that never matched a registration of its own server. */
export interface IdleLeaf {
    server: string;
    leaf: string;
}
/**
 * What the configuration did and did not cover.
 *
 * This is the half of the report a counter cannot carry: a count of removed
 * tools says nothing about the operator who wrote `github` where the server is
 * `gh`, and the answer they need is *which* of their keys never matched.
 */
export interface Coverage {
    /** The server keys the operator configured. */
    configured: readonly string[];
    /** Keys that cannot name a live server, with the reason each will never match. */
    unmatchable: readonly {
        server: string;
        reason: string;
    }[];
    /** Keys a registration's public name matched. */
    covered: readonly string[];
    /** Keys no registration ever matched. */
    idle: readonly string[];
    /** Allowlist entries never seen among their own server's registrations. */
    unusedLeaves: readonly IdleLeaf[];
    /** Whether a per-server observed-leaf set stopped growing at {@link SEEN_LIMIT}. */
    seenTruncated: boolean;
    /**
     * MCP tool names already in the registry when the shadow was installed.
     *
     * A cordis loader mounts entries in the order a profile lists them, so a row
     * placed after the `mcp-client` rows starts too late for that server's first
     * generation — and a plugin cannot unregister another plugin's tools. These
     * are the names that reached the registry before the filter could see them,
     * recorded so "mount it first" is a diagnostic rather than a README footnote.
     */
    preExisting: readonly string[];
}
/** The full state of one mount, as of the moment it is asked. */
export interface FilterSnapshot {
    mode: FilterMode;
    /** Whether the registry shadow is installed right now. */
    patched: boolean;
    counters: Counters;
    /** The dropped public names, oldest first, up to {@link DROP_LIST_LIMIT}. */
    drops: readonly string[];
    /** Whether more names were dropped than {@link DROP_LIST_LIMIT} records. */
    dropsTruncated: boolean;
    coverage: Coverage;
}
/**
 * The filter, as a value a shadow can call.
 *
 * Stateful by design: the counters and the coverage are what a mount is
 * configured *to know*, and a stateless filter could not answer "which of my
 * allowlist entries is dead?" at all.
 */
export declare class ToolFilter {
    private readonly settings;
    private readonly mode;
    private readonly log;
    /** Whether the registry shadow is installed. Set by the plugin, read by the snapshot. */
    patched: boolean;
    private readonly counters;
    private readonly drops;
    private dropsTruncated;
    private readonly seen;
    private seenTruncated;
    private readonly covered;
    private readonly announced;
    private preExisting;
    constructor(settings: Settings, mode: FilterMode, log: FilterLog);
    /**
     * Answer one registration.
     *
     * Fail-open on the decision and never fail-open on the registration: reading
     * the name and choosing a verdict are this plugin's own code and a throw there
     * means the tools should still exist, so it is caught and the call is
     * forwarded. The forwarded call itself is deliberately outside the catch — a
     * duplicate-name or reserved-name error from the registry is the registry's to
     * report, and swallowing it would turn a real conflict into a silent no-op.
     * @param readName - reads the definition's name; called inside the catch, because
     *   a definition is foreign and even the property read can throw.
     * @param register - forwards the registration to the real registry.
     * @returns the real registry's disposer, or a no-op when the tool was kept out.
     */
    handle(readName: () => unknown, register: () => () => void): () => void;
    /**
     * Record the MCP tools that were already registered when the shadow went in.
     * @param names - the live tool names the plugin could see at install time.
     */
    notePreExisting(names: readonly string[]): void;
    /** The counters, the removed names, and what the configuration did not cover. */
    snapshot(): FilterSnapshot;
    /** Zero the counters and the observed sets. The configuration and shadow stay as they are. */
    reset(): void;
    /**
     * Name the mount, in the terms an operator compares against their own file.
     *
     * Logged from `apply`, which is the only place that knows the shadow went in,
     * so the line is emitted once per mount and not once per registration.
     */
    describeMount(): string;
    /** The unmount line: what the mount actually did, in numbers the next reader can check. */
    describeUnmount(): string;
    /**
     * Judge one name.
     *
     * The three outcomes the caller distinguishes are all here: a name outside the
     * MCP namespace is counted and admitted, a name whose server no key names is
     * counted and admitted, and a name whose server is configured is admitted only
     * on its allowlist.
     * @param raw - the value read off the definition.
     * @returns whether to admit, and the match when the name was rejected.
     */
    private judge;
    /** Record that a server's prefix matched, and which leaf it carried. */
    private remember;
    /**
     * Say once per server that a tool is being kept out.
     *
     * Once, because a 161-tool server would otherwise write 161 lines, and the
     * fact an operator needs at the top of a boot log is that the rule is live —
     * the full list is in the snapshot, which is where a list belongs.
     */
    private announce;
}
//# sourceMappingURL=filter.d.ts.map