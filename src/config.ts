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

import { MCP_PREFIX, SERVER_SEPARATOR } from './detect.ts'

/** What the plugin does with an MCP tool that is not on its server's allowlist. */
export type FilterMode =
  /**
   * Answer the registration with a no-op disposer instead of forwarding it, so
   * the tool never enters the registry. The default: the gap is that a server's
   * whole tool list is registered unconditionally, and a mitigation an operator
   * has to arm twice is a mitigation that is off in the deployments that need it.
   */
  | 'filter'
  /**
   * Register everything and count what `filter` would have removed — the
   * posture to mount first, because it answers "how many of *this* deployment's
   * tools would survive?" with the deployment's own numbers rather than the
   * README's. Nothing is removed, so it is also the posture to leave running
   * when an operator wants the numbers without the change.
   */
  | 'observe'
  /** Mount nothing at all: no shadow, no service, no counters. */
  | 'off'

/** The configuration a loader entry may pass. Every field is optional. */
export interface Config {
  /** What to do with a rejected tool; see {@link FilterMode}. */
  mode?: FilterMode
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
  servers?: Record<string, readonly string[]>
  /** Whether the mount, first-rejection and unmount summaries are logged. Default true. */
  report?: boolean
}

/** One server's allowlist, with the prefix it is matched by. */
export interface ServerRule {
  /** The key exactly as the operator wrote it. */
  readonly name: string
  /**
   * The public-name prefix this rule matches, or `undefined` when no public
   * name can ever carry it — see {@link unmatchableReason}.
   */
  readonly prefix: string | undefined
  /** Why {@link prefix} is `undefined`; present only when it is. */
  readonly unmatchableReason?: string
  /** The leaf names admitted. Empty means "register nothing from this server". */
  readonly allow: readonly string[]
  /** The allowlist as a set, for the membership test on the registration path. */
  readonly admitted: ReadonlySet<string>
}

/** The validated configuration, with every default resolved. */
export interface Settings {
  readonly mode: FilterMode
  /** The rules, in the order the operator wrote them. */
  readonly servers: readonly ServerRule[]
  /** The rules by server key. */
  readonly byName: ReadonlyMap<string, ServerRule>
  readonly report: boolean
}

/** The modes, as a runtime list so validation and documentation cannot drift. */
export const MODES: readonly FilterMode[] = ['filter', 'observe', 'off']

/** The configuration the plugin runs with when a loader entry passes nothing. */
export const defaults: Settings = build('filter', [], true)

/** The `serverName` contract `mcp-client` validates before it connects (`[A-Za-z0-9_-]{1,32}`). */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** The per-server allowlist, as the operator wrote it, after shape validation. */
function readServers(servers: unknown): { name: string; allow: string[] }[] {
  if (servers === undefined) return []
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new TypeError(`mcp-tool-filter: servers must be an object of serverName -> string[], got ${describe(servers)}`)
  }
  const out: { name: string; allow: string[] }[] = []
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      // A bare string is the mistake this catches: `servers: { github: foo }`
      // reads like a one-tool allowlist and would otherwise be an array of
      // characters, i.e. a rule that admits nothing and says nothing.
      throw new TypeError(`mcp-tool-filter: servers.${name} must be an array of tool names, got ${describe(value)}`)
    }
    const allow: string[] = []
    for (const leaf of value) {
      if (typeof leaf !== 'string' || leaf.length === 0) {
        throw new TypeError(`mcp-tool-filter: servers.${name} must contain non-empty strings, got ${describe(leaf)}`)
      }
      allow.push(leaf)
    }
    out.push({ name, allow })
  }
  return out
}

/** A value's shape, for an error message that has to be actionable without a debugger. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length}`
  return typeof value
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
function build(mode: FilterMode, servers: { name: string; allow: string[] }[], report: boolean): Settings {
  const rules: ServerRule[] = []
  const byName = new Map<string, ServerRule>()
  for (const { name, allow } of servers) {
    const prefix = `${MCP_PREFIX}${name}${SERVER_SEPARATOR}`
    const reason = unmatchableReason(name)
    const rule: ServerRule = {
      name,
      ...(reason === undefined ? { prefix } : { prefix: undefined, unmatchableReason: reason }),
      allow,
      admitted: new Set(allow),
    }
    rules.push(rule)
    byName.set(name, rule)
  }
  return { mode, servers: rules, byName, report }
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
function unmatchableReason(name: string): string | undefined {
  if (!SERVER_NAME.test(name)) {
    return `"${name}" is not a valid mcp-client serverName (${SERVER_NAME.source})`
  }
  return undefined
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
export function normalizeConfig(config: Config = {}): Settings {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`mcp-tool-filter: config must be an object, got ${describe(config)}`)
  }
  const mode = config.mode ?? 'filter'
  if (!MODES.includes(mode)) {
    throw new RangeError(`mcp-tool-filter: mode must be one of ${MODES.join(', ')}, got ${String(mode)}`)
  }
  const report = config.report ?? true
  if (typeof report !== 'boolean') {
    throw new TypeError(`mcp-tool-filter: report must be a boolean, got ${String(report)}`)
  }
  return build(mode, readServers(config.servers), report)
}
