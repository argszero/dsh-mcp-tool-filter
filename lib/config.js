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
import { MCP_PREFIX, SERVER_SEPARATOR } from "./detect.js";
/** The modes, as a runtime list so validation and documentation cannot drift. */
export const MODES = ['filter', 'observe', 'off'];
/** The configuration the plugin runs with when a loader entry passes nothing. */
export const defaults = build('filter', [], true);
/** The `serverName` contract `mcp-client` validates before it connects (`[A-Za-z0-9_-]{1,32}`). */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** The per-server allowlist, as the operator wrote it, after shape validation. */
function readServers(servers) {
    if (servers === undefined)
        return [];
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        throw new TypeError(`mcp-tool-filter: servers must be an object of serverName -> string[], got ${describe(servers)}`);
    }
    const out = [];
    for (const [name, value] of Object.entries(servers)) {
        if (!Array.isArray(value)) {
            // A bare string is the mistake this catches: `servers: { github: foo }`
            // reads like a one-tool allowlist and would otherwise be an array of
            // characters, i.e. a rule that admits nothing and says nothing.
            throw new TypeError(`mcp-tool-filter: servers.${name} must be an array of tool names, got ${describe(value)}`);
        }
        const allow = [];
        for (const leaf of value) {
            if (typeof leaf !== 'string' || leaf.length === 0) {
                throw new TypeError(`mcp-tool-filter: servers.${name} must contain non-empty strings, got ${describe(leaf)}`);
            }
            allow.push(leaf);
        }
        out.push({ name, allow });
    }
    return out;
}
/** A value's shape, for an error message that has to be actionable without a debugger. */
function describe(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `an array of ${value.length}`;
    return typeof value;
}
/**
 * Assemble settings from already-validated parts.
 *
 * Kept separate from {@link normalizeConfig} so {@link defaults} can be built
 * through the same code path a mount takes — a default that is assembled
 * differently from a configured value is a default nobody tests.
 * @param mode - the resolved mode.
 * @param servers - the validated allowlists.
 * @param report - the resolved report flag.
 * @returns the settings.
 */
function build(mode, servers, report) {
    const rules = [];
    const byName = new Map();
    for (const { name, allow } of servers) {
        const prefix = `${MCP_PREFIX}${name}${SERVER_SEPARATOR}`;
        const reason = unmatchableReason(name);
        const rule = {
            name,
            ...(reason === undefined ? { prefix } : { prefix: undefined, unmatchableReason: reason }),
            allow,
            admitted: new Set(allow),
        };
        rules.push(rule);
        byName.set(name, rule);
    }
    return { mode, servers: rules, byName, report };
}
/**
 * Why a configured key can never match, or `undefined` when it can.
 *
 * `mcp-client` validates `serverName` against `[A-Za-z0-9_-]{1,32}` before it
 * connects, so a key outside that shape cannot name a live server on the line
 * this plugin targets. It is still accepted — a configuration may be carried
 * across lines — but it will never match, and the coverage report says so rather
 * than leaving it as a rule that quietly removes nothing.
 *
 * There is deliberately no second check for a prefix `publicToolName()` would
 * truncate. It cannot happen: the longest valid key is 32 characters, so the
 * longest prefix is `mcp__` + 32 + `__` = 39, and truncation to the 64-character
 * function-name contract keeps 51 characters and cuts from the end. A branch for
 * a case the contract excludes would be a branch no test could reach.
 * @param name - the configured server key.
 * @returns the reason, or `undefined`.
 */
function unmatchableReason(name) {
    if (!SERVER_NAME.test(name)) {
        return `"${name}" is not a valid mcp-client serverName (${SERVER_NAME.source})`;
    }
    return undefined;
}
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
export function normalizeConfig(config = {}) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError(`mcp-tool-filter: config must be an object, got ${describe(config)}`);
    }
    const mode = config.mode ?? 'filter';
    if (!MODES.includes(mode)) {
        throw new RangeError(`mcp-tool-filter: mode must be one of ${MODES.join(', ')}, got ${String(mode)}`);
    }
    const report = config.report ?? true;
    if (typeof report !== 'boolean') {
        throw new TypeError(`mcp-tool-filter: report must be a boolean, got ${String(report)}`);
    }
    return build(mode, readServers(config.servers), report);
}
