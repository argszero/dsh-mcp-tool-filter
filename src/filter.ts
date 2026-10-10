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

import { isMcpName, matchServer } from './detect.ts'
import type { ServerMatch } from './detect.ts'
import type { FilterMode, ServerRule, Settings } from './config.ts'

/** How many dropped names the snapshot remembers before it starts counting only. */
export const DROP_LIST_LIMIT = 256

/** How many observed leaves one server's coverage keeps before it stops growing. */
export const SEEN_LIMIT = 512

/** Where the filter's own lines go. Structural, so a test can pass a collector. */
export interface FilterLog {
  info(message: string): void
  warn(message: string): void
}

/** Running totals over every registration the shadow saw. */
export interface Counters {
  /** Every `register()` call, whatever the name was. */
  considered: number
  /** Calls forwarded to the real registry. */
  admitted: number
  /** Calls answered with a no-op disposer instead of a registration. */
  dropped: number
  /** Names `filter` mode would have dropped while `observe` mode admitted them. */
  wouldDrop: number
  /** String names outside the MCP namespace — every core and plugin tool. */
  nonMcp: number
  /** MCP registrations whose server no configured key names. */
  unlistedServer: number
  /** Registrations carrying no string name, which no allowlist can judge. */
  unjudgeable: number
}

/** An allowlist entry that never matched a registration of its own server. */
export interface IdleLeaf {
  server: string
  leaf: string
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
  configured: readonly string[]
  /** Keys that cannot name a live server, with the reason each will never match. */
  unmatchable: readonly { server: string; reason: string }[]
  /** Keys a registration's public name matched. */
  covered: readonly string[]
  /** Keys no registration ever matched. */
  idle: readonly string[]
  /** Allowlist entries never seen among their own server's registrations. */
  unusedLeaves: readonly IdleLeaf[]
  /** Whether a per-server observed-leaf set stopped growing at {@link SEEN_LIMIT}. */
  seenTruncated: boolean
  /**
   * MCP tool names already in the registry when the shadow was installed.
   *
   * A cordis loader mounts entries in the order a profile lists them, so a row
   * placed after the `mcp-client` rows starts too late for that server's first
   * generation — and a plugin cannot unregister another plugin's tools. These
   * are the names that reached the registry before the filter could see them,
   * recorded so "mount it first" is a diagnostic rather than a README footnote.
   */
  preExisting: readonly string[]
}

/** The full state of one mount, as of the moment it is asked. */
export interface FilterSnapshot {
  mode: FilterMode
  /** Whether the registry shadow is installed right now. */
  patched: boolean
  counters: Counters
  /** The dropped public names, oldest first, up to {@link DROP_LIST_LIMIT}. */
  drops: readonly string[]
  /** Whether more names were dropped than {@link DROP_LIST_LIMIT} records. */
  dropsTruncated: boolean
  coverage: Coverage
}

/** The outcome of judging one name, before the mode decides what to do with it. */
type Verdict =
  | { kind: 'admit' }
  /** The name as it arrived, so the report quotes the registry's own spelling. */
  | { kind: 'reject'; match: ServerMatch; name: string }

/**
 * The filter, as a value a shadow can call.
 *
 * Stateful by design: the counters and the coverage are what a mount is
 * configured *to know*, and a stateless filter could not answer "which of my
 * allowlist entries is dead?" at all.
 */
export class ToolFilter {
  /** Whether the registry shadow is installed. Set by the plugin, read by the snapshot. */
  patched = false

  private readonly counters: Counters = {
    considered: 0, admitted: 0, dropped: 0, wouldDrop: 0, nonMcp: 0, unlistedServer: 0, unjudgeable: 0,
  }

  private readonly drops: string[] = []
  private dropsTruncated = false
  private readonly seen = new Map<string, Set<string>>()
  private seenTruncated = false
  private readonly covered = new Set<string>()
  private readonly announced = new Set<string>()
  private preExisting: string[] = []

  constructor(
    private readonly settings: Settings,
    private readonly mode: FilterMode,
    private readonly log: FilterLog,
  ) {}

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
  handle(readName: () => unknown, register: () => () => void): () => void {
    this.counters.considered += 1
    let verdict: Verdict
    try {
      verdict = this.judge(readName())
    } catch (error: unknown) {
      this.log.warn(`mcp-tool-filter: could not judge a registration, forwarding it unchanged: ${String(error)}`)
      verdict = { kind: 'admit' }
    }
    if (verdict.kind === 'admit') {
      this.counters.admitted += 1
      return register()
    }
    if (this.mode === 'observe') {
      this.counters.wouldDrop += 1
      this.announce(verdict.match, verdict.name, true)
      this.counters.admitted += 1
      return register()
    }
    this.counters.dropped += 1
    if (this.drops.length < DROP_LIST_LIMIT) this.drops.push(verdict.name)
    else this.dropsTruncated = true
    this.announce(verdict.match, verdict.name, false)
    // The registry's callers keep this disposer in a map and call it on the next
    // synchronization, so it has to exist and has to be harmless: there is
    // nothing to undo, and throwing here would take down a re-sync.
    return () => {}
  }

  /**
   * Record the MCP tools that were already registered when the shadow went in.
   * @param names - the live tool names the plugin could see at install time.
   */
  notePreExisting(names: readonly string[]): void {
    this.preExisting = names.filter(isMcpName)
  }

  /** The counters, the removed names, and what the configuration did not cover. */
  snapshot(): FilterSnapshot {
    const considered: IdleLeaf[] = []
    for (const rule of this.settings.servers) {
      const leaves = this.seen.get(rule.name)
      for (const leaf of rule.allow) {
        if (leaves?.has(leaf) !== true) considered.push({ server: rule.name, leaf })
      }
    }
    const unmatchable = this.settings.servers
      .filter(rule => rule.prefix === undefined)
      .map(rule => ({ server: rule.name, reason: rule.unmatchableReason ?? 'unmatchable' }))
    return {
      mode: this.mode,
      patched: this.patched,
      counters: { ...this.counters },
      drops: [...this.drops],
      dropsTruncated: this.dropsTruncated,
      coverage: {
        configured: this.settings.servers.map(rule => rule.name),
        unmatchable,
        covered: [...this.covered],
        idle: this.settings.servers.map(rule => rule.name).filter(name => !this.covered.has(name)),
        unusedLeaves: considered,
        seenTruncated: this.seenTruncated,
        preExisting: [...this.preExisting],
      },
    }
  }

  /** Zero the counters and the observed sets. The configuration and shadow stay as they are. */
  reset(): void {
    for (const key of Object.keys(this.counters) as (keyof Counters)[]) this.counters[key] = 0
    this.drops.length = 0
    this.dropsTruncated = false
    this.seen.clear()
    this.seenTruncated = false
    this.covered.clear()
    this.announced.clear()
    this.preExisting = []
  }

  /**
   * Name the mount, in the terms an operator compares against their own file.
   *
   * Logged from `apply`, which is the only place that knows the shadow went in,
   * so the line is emitted once per mount and not once per registration.
   */
  describeMount(): string {
    const rules = this.settings.servers
    const admitted = rules.reduce((total, rule) => total + rule.allow.length, 0)
    const unmatchable = rules.filter(rule => rule.prefix === undefined)
    const tail = unmatchable.length === 0
      ? ''
      : `; ${unmatchable.length} key(s) can never match: ${unmatchable.map(rule => rule.name).join(', ')}`
    return `${rules.length} server rule(s), ${admitted} allowlisted tool name(s)${tail}`
  }

  /** The unmount line: what the mount actually did, in numbers the next reader can check. */
  describeUnmount(): string {
    const { counters, coverage } = this.snapshot()
    const parts = [
      `admitted ${counters.admitted}/${counters.considered}`,
      `kept out ${counters.dropped}`,
    ]
    if (counters.wouldDrop > 0) parts.push(`would have kept out ${counters.wouldDrop}`)
    if (coverage.idle.length > 0) parts.push(`idle server key(s): ${coverage.idle.join(', ')}`)
    if (coverage.unusedLeaves.length > 0) {
      const named = coverage.unusedLeaves.slice(0, 5).map(leaf => `${leaf.server}/${leaf.leaf}`).join(', ')
      const more = coverage.unusedLeaves.length > 5 ? ` and ${coverage.unusedLeaves.length - 5} more` : ''
      parts.push(`allowlist entries never seen: ${named}${more}`)
    }
    return parts.join('; ')
  }

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
  private judge(raw: unknown): Verdict {
    if (typeof raw !== 'string') {
      this.counters.unjudgeable += 1
      return { kind: 'admit' }
    }
    if (!isMcpName(raw)) {
      this.counters.nonMcp += 1
      return { kind: 'admit' }
    }
    const match = matchServer(raw, this.settings.servers)
    if (match === undefined) {
      this.counters.unlistedServer += 1
      return { kind: 'admit' }
    }
    this.remember(match)
    const rule: ServerRule | undefined = this.settings.byName.get(match.server)
    if (rule?.admitted.has(match.leaf) === true) return { kind: 'admit' }
    return { kind: 'reject', match, name: raw }
  }

  /** Record that a server's prefix matched, and which leaf it carried. */
  private remember(match: ServerMatch): void {
    this.covered.add(match.server)
    let leaves = this.seen.get(match.server)
    if (leaves === undefined) {
      leaves = new Set()
      this.seen.set(match.server, leaves)
    }
    if (leaves.size < SEEN_LIMIT || leaves.has(match.leaf)) leaves.add(match.leaf)
    else this.seenTruncated = true
  }

  /**
   * Say once per server that a tool is being kept out.
   *
   * Once, because a 161-tool server would otherwise write 161 lines, and the
   * fact an operator needs at the top of a boot log is that the rule is live —
   * the full list is in the snapshot, which is where a list belongs.
   */
  private announce(match: ServerMatch, name: string, would: boolean): void {
    if (this.announced.has(match.server)) return
    this.announced.add(match.server)
    const verb = would ? 'would not register' : 'not registering'
    this.log.info(
      `mcp-tool-filter: server "${match.server}": ${verb} "${name}" (not on its allowlist;`
      + ` ${this.settings.byName.get(match.server)?.allow.length ?? 0} name(s) are)`,
    )
  }
}
