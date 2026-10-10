/**
 * Attribute a public MCP tool name to the server that owns it.
 *
 * The vectors are the shipped `publicToolName()`'s own output: the replica in
 * `test/harness.mjs` was compared against the function extracted from
 * `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`'s published `lib/index.js` on 45
 * `(server, raw)` pairs with zero mismatches (`scripts/probe-lines.mjs` repeats
 * that comparison per release line). What is asserted here is what the plugin
 * does with the names that function produces.
 *
 * @module test/detect
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isMcpName, matchServer, MCP_PREFIX } from '../lib/detect.js'
import { normalizeConfig } from '../lib/config.js'
import { publicToolName } from './harness.mjs'

/** The rules a config with `servers` produces, without spelling out the whole shape. */
function rules(servers) {
  return normalizeConfig({ servers }).servers
}

describe('isMcpName', () => {
  it('accepts the namespace and nothing else', () => {
    assert.equal(isMcpName('mcp__github__lookup'), true)
    assert.equal(isMcpName('mcp__'), true)
    assert.equal(isMcpName('lookup'), false)
    assert.equal(isMcpName('MCP__github__lookup'), false)
    assert.equal(MCP_PREFIX, 'mcp__')
  })
})

describe('the naming contract this plugin reads', () => {
  it('keeps the prefix verbatim when the raw name is clean', () => {
    assert.equal(publicToolName('github', 'lookup'), 'mcp__github__lookup')
  })

  it('normalizes a lossy raw name and appends an identity hash', () => {
    assert.equal(publicToolName('github', 'a.b'), 'mcp__github__a_b_531a020b8a5f')
    // The hash is over the identity, so two raw names that normalize to the
    // same characters stay distinct.
    assert.notEqual(publicToolName('github', 'a.b'), publicToolName('github', 'a-b'))
  })

  it('truncates a too-long name but keeps the prefix', () => {
    const long = publicToolName('github', 'n'.repeat(80))
    assert.equal(long.length, 64)
    assert.ok(long.startsWith('mcp__github__'))
  })
})

describe('matchServer', () => {
  it('returns the leaf for a configured server', () => {
    assert.deepEqual(
      matchServer('mcp__github__lookup', rules({ github: ['lookup'] })),
      { server: 'github', leaf: 'lookup' },
    )
  })

  it('returns undefined for a server no key names', () => {
    assert.equal(matchServer('mcp__gitlab__lookup', rules({ github: ['lookup'] })), undefined)
    assert.equal(matchServer('bash', rules({ github: ['lookup'] })), undefined)
  })

  it('prefers the longest matching prefix', () => {
    const both = rules({ github: ['a'], github__enterprise: ['b'] })
    assert.deepEqual(matchServer('mcp__github__enterprise__b', both), { server: 'github__enterprise', leaf: 'b' })
    assert.deepEqual(matchServer('mcp__github__a', both), { server: 'github', leaf: 'a' })
    // Order of the configuration must not decide it.
    const reversed = rules({ github__enterprise: ['b'], github: ['a'] })
    assert.deepEqual(matchServer('mcp__github__enterprise__b', reversed), { server: 'github__enterprise', leaf: 'b' })
  })

  it('does not match a bare prefix with no leaf', () => {
    assert.equal(matchServer('mcp__github__', rules({ github: [] })), undefined)
  })

  it('matches a leaf that is itself hashed', () => {
    const name = publicToolName('github', 'a.b')
    assert.deepEqual(matchServer(name, rules({ github: [] })), { server: 'github', leaf: 'a_b_531a020b8a5f' })
  })

  it('leaves a key that cannot name a live server unmatched', () => {
    // `.` is outside mcp-client's serverName contract, so this key can never be
    // the server of a live tool — strict matching keeps it from capturing the
    // tools of a differently-named one.
    assert.equal(matchServer('mcp__my_server__lookup', rules({ 'my.server': ['lookup'] })), undefined)
    assert.equal(matchServer('mcp__' + 'x'.repeat(33) + '__t', rules({ ['x'.repeat(33)]: ['t'] })), undefined)
  })

  it('never needs to guard the truncation boundary, because the contract excludes it', () => {
    // 39 = `mcp__` + 32 + `__`, the longest prefix a valid serverName can make;
    // publicToolName() keeps 51 characters when it truncates (64 - 12 - 1), so a
    // prefix always survives verbatim. A guard for the other case would be
    // unreachable — this assertion is what keeps that reasoning honest if the
    // serverName contract ever widens.
    const longest = rules({ ['x'.repeat(32)]: ['t'] })[0].prefix
    assert.equal(longest.length, 39)
    assert.ok(longest.length <= 64 - 12 - 1)
  })
})
