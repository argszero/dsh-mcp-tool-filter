/**
 * The filter as a value: what it admits, what it keeps out, and what it says
 * about the configuration it was given.
 *
 * These tests drive `handle()` directly — no cordis, no registry — so a failure
 * names the decision rather than a mount. `test/plugin.spec.mjs` then proves the
 * same decisions are what a live registry sees.
 *
 * @module test/filter
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { DROP_LIST_LIMIT, SEEN_LIMIT, ToolFilter } from '../lib/filter.js'

/** A filter over `config`, with its log lines collected. */
function build(config) {
  const settings = normalizeConfig(config)
  const lines = { info: [], warn: [] }
  const filter = new ToolFilter(settings, settings.mode, {
    info: message => lines.info.push(message),
    warn: message => lines.warn.push(message),
  })
  return { filter, lines, settings }
}

/** Register `name` through the filter, returning whether the registry saw it. */
function register(filter, name) {
  const registry = []
  const dispose = filter.handle(
    () => name,
    () => { registry.push(name); return () => { registry.length = 0 } },
  )
  assert.equal(typeof dispose, 'function')
  return registry.includes(name)
}

describe('ToolFilter decisions', () => {
  it('admits an allowlisted leaf and keeps out the rest of that server', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    assert.equal(register(filter, 'mcp__github__lookup'), true)
    assert.equal(register(filter, 'mcp__github__delete_repo'), false)
    const { counters } = filter.snapshot()
    assert.equal(counters.considered, 2)
    assert.equal(counters.admitted, 1)
    assert.equal(counters.dropped, 1)
  })

  it('admits everything from a server no key names', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    assert.equal(register(filter, 'mcp__gitlab__anything'), true)
    assert.equal(filter.snapshot().counters.unlistedServer, 1)
  })

  it('admits every non-MCP tool', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    for (const name of ['bash', 'read', 'edit', 'mcp_like', 'run_code']) {
      assert.equal(register(filter, name), true, name)
    }
    assert.equal(filter.snapshot().counters.nonMcp, 5)
    assert.equal(filter.snapshot().counters.dropped, 0)
  })

  it('registers nothing from a server configured with an empty allowlist', () => {
    const { filter } = build({ servers: { noisy: [] } })
    assert.equal(register(filter, 'mcp__noisy__a'), false)
    assert.equal(register(filter, 'mcp__noisy__b'), false)
    assert.equal(filter.snapshot().counters.dropped, 2)
  })

  it('counts a name it cannot judge and forwards it, rather than guessing', () => {
    const { filter } = build({ servers: { github: [] } })
    for (const weird of [undefined, null, 7, { name: 'mcp__github__x' }, Symbol('mcp__github__x')]) {
      const registry = []
      filter.handle(() => weird, () => { registry.push('x'); return () => {} })
      assert.equal(registry.length, 1, String(weird))
    }
    const { counters } = filter.snapshot()
    assert.equal(counters.unjudgeable, 5)
    assert.equal(counters.dropped, 0)
  })

  it('forwards the registration unchanged when reading the name throws', () => {
    const { filter, lines } = build({ servers: { github: [] } })
    const registry = []
    filter.handle(
      () => { throw new Error('hostile getter') },
      () => { registry.push('x'); return () => {} },
    )
    assert.deepEqual(registry, ['x'])
    assert.equal(lines.warn.length, 1)
    assert.match(lines.warn[0], /could not judge a registration, forwarding it unchanged: Error: hostile getter/)
  })

  it('never swallows what the registry itself reports', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    assert.throws(
      () => filter.handle(() => 'mcp__github__lookup', () => { throw new TypeError('duplicate name') }),
      /duplicate name/,
    )
  })

  it('returns a harmless disposer for a kept-out tool', () => {
    const { filter } = build({ servers: { github: [] } })
    const dispose = filter.handle(() => 'mcp__github__x', () => { throw new Error('must not be called') })
    assert.equal(dispose(), undefined)
    assert.equal(dispose(), undefined)
  })
})

describe('ToolFilter modes', () => {
  it('observe registers everything and counts what filter would have kept out', () => {
    const { filter } = build({ mode: 'observe', servers: { github: ['lookup'] } })
    assert.equal(register(filter, 'mcp__github__lookup'), true)
    assert.equal(register(filter, 'mcp__github__drop'), true)
    const { counters } = filter.snapshot()
    assert.equal(counters.dropped, 0)
    assert.equal(counters.wouldDrop, 1)
    assert.equal(counters.admitted, 2)
    assert.equal(filter.snapshot().mode, 'observe')
  })

  it('off is not a filter at all: nothing is counted because nothing is mounted', () => {
    const settings = normalizeConfig({ mode: 'off', servers: { github: [] } })
    // The plugin returns before constructing one; this asserts the mode reaches
    // the settings unchanged so that early return is the only thing standing
    // between `off` and a shadow.
    assert.equal(settings.mode, 'off')
  })
})

describe('ToolFilter coverage', () => {
  it('reports the servers a registration matched and the ones it never did', () => {
    const { filter } = build({ servers: { github: ['lookup'], gitlab: ['x'] } })
    register(filter, 'mcp__github__lookup')
    const { coverage } = filter.snapshot()
    assert.deepEqual(coverage.configured, ['github', 'gitlab'])
    assert.deepEqual(coverage.covered, ['github'])
    assert.deepEqual(coverage.idle, ['gitlab'])
  })

  it('reports an allowlist entry that never matched anything', () => {
    const { filter } = build({ servers: { github: ['lookup', 'typo_here'] } })
    register(filter, 'mcp__github__lookup')
    register(filter, 'mcp__github__other')
    assert.deepEqual(filter.snapshot().coverage.unusedLeaves, [{ server: 'github', leaf: 'typo_here' }])
  })

  it('reports a key that can never match, with the reason', () => {
    const { filter } = build({ servers: { 'my.server': ['x'] } })
    const { coverage } = filter.snapshot()
    assert.equal(coverage.unmatchable.length, 1)
    assert.equal(coverage.unmatchable[0].server, 'my.server')
    assert.match(coverage.unmatchable[0].reason, /not a valid mcp-client serverName/)
    assert.deepEqual(coverage.idle, ['my.server'])
    assert.deepEqual(coverage.unusedLeaves, [{ server: 'my.server', leaf: 'x' }])
  })

  it('survives a re-sync that drops and re-registers the same names', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    for (let round = 0; round < 3; round += 1) {
      register(filter, 'mcp__github__lookup')
      register(filter, 'mcp__github__drop')
    }
    assert.equal(filter.snapshot().coverage.unusedLeaves.length, 0)
    assert.equal(filter.snapshot().counters.considered, 6)
  })
})

describe('ToolFilter bookkeeping bounds', () => {
  it('stops recording dropped names at the limit and says so', () => {
    const { filter } = build({ servers: { noisy: [] } })
    for (let index = 0; index < DROP_LIST_LIMIT + 20; index += 1) register(filter, `mcp__noisy__t${index}`)
    const snapshot = filter.snapshot()
    assert.equal(snapshot.drops.length, DROP_LIST_LIMIT)
    assert.equal(snapshot.dropsTruncated, true)
    assert.equal(snapshot.counters.dropped, DROP_LIST_LIMIT + 20)
    // The first name is the first one, not the last one to survive a rotation.
    assert.equal(snapshot.drops[0], 'mcp__noisy__t0')
  })

  it('stops growing one server’s observed-leaf set at the limit', () => {
    const { filter } = build({ servers: { noisy: ['never'] } })
    for (let index = 0; index < SEEN_LIMIT + 20; index += 1) register(filter, `mcp__noisy__t${index}`)
    assert.equal(filter.snapshot().coverage.seenTruncated, true)
  })

  it('announces a server once, not once per kept-out tool', () => {
    const { filter, lines } = build({ servers: { noisy: ['keep'] } })
    for (let index = 0; index < 50; index += 1) register(filter, `mcp__noisy__t${index}`)
    const announcements = lines.info.filter(line => line.includes('not registering'))
    assert.equal(announcements.length, 1)
    assert.match(announcements[0], /server "noisy": not registering "mcp__noisy__t0" \(not on its allowlist; 1 name\(s\) are\)/)
  })

  it('says "would not register" in observe mode', () => {
    const { filter, lines } = build({ mode: 'observe', servers: { noisy: [] } })
    register(filter, 'mcp__noisy__t0')
    assert.equal(lines.info.filter(line => line.includes('would not register')).length, 1)
  })

  it('describes the mount in the operator’s own terms', () => {
    const { filter } = build({ servers: { github: ['a', 'b'], 'my.server': ['c'] } })
    assert.equal(
      filter.describeMount(),
      '2 server rule(s), 3 allowlisted tool name(s); 1 key(s) can never match: my.server',
    )
  })

  it('summarises the unmount with the gaps named', () => {
    const { filter } = build({ servers: { github: ['a', 'typo'], gitlab: ['x'] } })
    register(filter, 'mcp__github__a')
    register(filter, 'mcp__github__b')
    const summary = filter.describeUnmount()
    assert.match(summary, /admitted 1\/2/)
    assert.match(summary, /kept out 1/)
    assert.match(summary, /idle server key\(s\): gitlab/)
    assert.match(summary, /allowlist entries never seen: github\/typo, gitlab\/x/)
  })

  it('reports pre-existing MCP names, and only MCP ones', () => {
    const { filter } = build({ servers: {} })
    filter.notePreExisting(['bash', 'mcp__github__lookup', 'mcp__gitlab__x'])
    assert.deepEqual(filter.snapshot().coverage.preExisting, ['mcp__github__lookup', 'mcp__gitlab__x'])
  })

  it('reset clears the counters and the coverage but not the configuration', () => {
    const { filter } = build({ servers: { github: ['lookup'] } })
    register(filter, 'mcp__github__lookup')
    filter.notePreExisting(['mcp__github__lookup'])
    filter.reset()
    const snapshot = filter.snapshot()
    assert.equal(snapshot.counters.considered, 0)
    assert.deepEqual(snapshot.coverage.covered, [])
    assert.deepEqual(snapshot.coverage.preExisting, [])
    assert.deepEqual(snapshot.drops, [])
    assert.deepEqual(snapshot.coverage.configured, ['github'])
    // Idle again: the observed set is gone, so the allowlist entry is unused.
    assert.deepEqual(snapshot.coverage.unusedLeaves, [{ server: 'github', leaf: 'lookup' }])
  })
})
