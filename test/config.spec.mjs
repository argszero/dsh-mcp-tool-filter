/**
 * The configuration surface: what a loader entry may say, what the plugin
 * refuses to guess, and what it deliberately accepts without acting on.
 *
 * @module test/config
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaults, MODES, normalizeConfig, SERVER_NAME } from '../lib/config.js'

describe('normalizeConfig', () => {
  it('resolves the default posture: filter, report, no server rules', () => {
    const settings = normalizeConfig()
    assert.equal(settings.mode, 'filter')
    assert.equal(settings.report, true)
    assert.deepEqual(settings.servers, [])
    assert.deepEqual(MODES, ['filter', 'observe', 'off'])
    assert.equal(defaults.mode, 'filter')
    assert.equal(defaults.report, true)
    assert.deepEqual(defaults.servers, [])
  })

  it('accepts an explicit empty argument list as the same defaults', () => {
    assert.deepEqual(normalizeConfig({}), normalizeConfig())
  })

  it('keeps "absent" and "empty allowlist" apart', () => {
    const settings = normalizeConfig({ servers: { github: [], gh: ['a'] } })
    assert.deepEqual(settings.servers.map(rule => rule.name), ['github', 'gh'])
    const byName = settings.byName
    assert.deepEqual([...byName.get('github').allow], [])
    assert.deepEqual([...byName.get('gh').allow], ['a'])
    assert.equal(byName.has('gitlab'), false)
  })

  it('builds the public-name prefix from the key verbatim', () => {
    const { servers } = normalizeConfig({ servers: { 'srv_1': ['x'] } })
    assert.equal(servers[0].prefix, 'mcp__srv_1__')
    assert.equal(servers[0].unmatchableReason, undefined)
  })

  it('marks a key that cannot name a live server, and keeps it', () => {
    const { servers } = normalizeConfig({ servers: { 'my.server': ['x'], ['y'.repeat(33)]: ['x'] } })
    assert.equal(servers[0].prefix, undefined)
    assert.match(servers[0].unmatchableReason, /not a valid mcp-client serverName/)
    assert.equal(servers[1].prefix, undefined)
    // Accepted, not thrown: a configuration may be carried across lines, and the
    // coverage report is what tells the operator it will never match.
    assert.equal(servers.length, 2)
    assert.equal(SERVER_NAME.test('srv_1'), true)
    assert.equal(SERVER_NAME.test('my.server'), false)
  })

  it('accepts a 32-character server name, which is the documented maximum', () => {
    const key = 'x'.repeat(32)
    const { servers } = normalizeConfig({ servers: { [key]: ['t'] } })
    assert.equal(servers[0].prefix, `mcp__${key}__`)
    // mcp__ + 32 + __ = 39, inside the 51 characters publicToolName() keeps.
    assert.ok(servers[0].prefix.length <= 51)
  })

  it('rejects a mode outside the list rather than defaulting it', () => {
    assert.throws(() => normalizeConfig({ mode: 'fliter' }), /mode must be one of filter, observe, off, got fliter/)
    assert.throws(() => normalizeConfig({ mode: true }), RangeError)
  })

  it('rejects a non-object config', () => {
    assert.throws(() => normalizeConfig(null), /config must be an object/)
    assert.throws(() => normalizeConfig([]), /config must be an object/)
    assert.throws(() => normalizeConfig('filter'), /config must be an object/)
  })

  it('rejects a servers entry that is not an array of non-empty strings', () => {
    assert.throws(() => normalizeConfig({ servers: { github: 'lookup' } }), /servers\.github must be an array/)
    assert.throws(() => normalizeConfig({ servers: { github: [''] } }), /non-empty strings/)
    assert.throws(() => normalizeConfig({ servers: { github: [7] } }), /non-empty strings/)
    assert.throws(() => normalizeConfig({ servers: ['github'] }), /servers must be an object/)
    assert.throws(() => normalizeConfig({ servers: null }), /servers must be an object/)
  })

  it('rejects a non-boolean report rather than guessing', () => {
    assert.throws(() => normalizeConfig({ report: 'yes' }), /report must be a boolean/)
  })
})
