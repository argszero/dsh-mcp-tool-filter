/**
 * Which MCP server a public tool name belongs to, and what is left of it.
 *
 * `mcp-client` registers every tool of a connected server under
 * `mcp__<serverName>__<rawName>` (`packages/mcp/mcp-client/src/tools.ts`,
 * `publicToolName()`). That name is the only thing the registry — and therefore
 * this plugin — ever sees; the raw name lives in a closure on the definition
 * and is never a field.
 *
 * The prefix is at most `mcp__` + 32 + `__` characters, because `mcp-client`
 * validates `serverName` against `[A-Za-z0-9_-]{1,32}` before it connects — and
 * it is never truncated: at 39 characters it is well inside the 51 that
 * `publicToolName()` keeps when it cuts a longer joined name down to the
 * 64-character function-name contract. So a configured server key is matched
 * against the front of a public name, and everything after it is the leaf.
 *
 * Two servers where one key is a `__`-separated extension of another
 * (`github` and `github__enterprise`) both prefix the same name; the **longer**
 * prefix wins, which is the only assignment that keeps each tool with the server
 * that most specifically named it.
 *
 * @module @argszero/dsh-mcp-tool-filter/detect
 */

import type { ServerRule } from './config.ts'

/** The namespace every MCP tool's public name starts with. */
export const MCP_PREFIX = 'mcp__'

/** The separator between the server name and the raw tool name. */
export const SERVER_SEPARATOR = '__'

/** One public name attributed to the server that owns it. */
export interface ServerMatch {
  /** The configured server key, as the operator wrote it. */
  server: string
  /** The public leaf: the public name minus this server's prefix. Always non-empty. */
  leaf: string
}

/** Whether a tool name is in the MCP namespace at all. */
export function isMcpName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

/**
 * Attribute a public tool name to the configured server that owns it.
 *
 * `undefined` means every configured prefix fails to match, which the caller
 * reads as "this server is not filtered" rather than as "keep it out" — a
 * filter's safe direction is to leave a tool it cannot place alone.
 * @param name - the public tool name a registration carried.
 * @param rules - the configured server rules, in any order.
 * @returns the owning server and the leaf, or `undefined`.
 */
export function matchServer(name: string, rules: readonly ServerRule[]): ServerMatch | undefined {
  let best: ServerMatch | undefined
  for (const rule of rules) {
    const prefix = rule.prefix
    if (prefix === undefined) continue
    if (!name.startsWith(prefix)) continue
    const leaf = name.slice(prefix.length)
    // `mcp__github__` with nothing after it is not a tool this server listed;
    // treating it as leaf `''` would let a malformed name be matched by an
    // allowlist that could never have contained it.
    if (leaf.length === 0) continue
    // The name is fixed, so the longest prefix is the one the caller compares
    // against directly rather than by proxy.
    if (best !== undefined && prefix.length <= name.length - best.leaf.length) continue
    best = { server: rule.name, leaf }
  }
  return best
}
