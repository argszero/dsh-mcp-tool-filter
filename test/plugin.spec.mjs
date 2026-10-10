/**
 * The plugin against a live registry: does a kept-out tool actually stay out?
 *
 * Every assertion below reads the registry's own projection (`ctx.tools.schemas()`)
 * or a recorder installed underneath the shadow, never the plugin's counters —
 * a counter that agrees with itself proves nothing about what the registry holds.
 *
 * @module test/plugin
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { definition, instance, propose, publicToolName, registeredNames, service, shadowInstalled, world } from './harness.mjs'

/** A 161-tool server, the shape the report was made about. */
function crowded(server, count) {
  return Array.from({ length: count }, (_, index) => publicToolName(server, `tool_${index}`))
}

describe('filter mode against a live registry', () => {
  it('keeps an unlisted tool out of the registry and lets the listed one through', async () => {
    const harness = await world({ config: { servers: { alpha: ['lookup'] } } })
    try {
      propose(harness.ctx, publicToolName('alpha', 'lookup'))
      propose(harness.ctx, publicToolName('alpha', 'delete_everything'))
      assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__lookup'])
      assert.deepEqual(harness.recorder.seen, ['mcp__alpha__lookup'])
      assert.equal(harness.ctx.tools.get('mcp__alpha__delete_everything'), undefined)
      assert.notEqual(harness.ctx.tools.get('mcp__alpha__lookup'), undefined)
    } finally {
      await harness.dispose()
    }
  })

  it('sees the registration a caller makes through the view, not a captured service', async () => {
    // `syncTools()` does `ctx.tools.register(definition)` at call time. The
    // shadow has to be on the instance for that to reach it — a shadow on the
    // view would leave exactly this call untouched, and the test would pass
    // while the product did nothing.
    const harness = await world({ config: { servers: { alpha: [] } } })
    try {
      const lookup = harness.ctx.tools // read before the call, as a captured service would be
      lookup.register(definition('mcp__alpha__x'))
      assert.deepEqual(registeredNames(harness.ctx), [])
      assert.deepEqual(harness.recorder.seen, [])
    } finally {
      await harness.dispose()
    }
  })

  it('leaves every non-MCP tool alone', async () => {
    const harness = await world({ config: { servers: { alpha: [] } } })
    try {
      for (const name of ['bash', 'read', 'edit', 'write', 'todo_write']) propose(harness.ctx, name)
      assert.deepEqual(harness.recorder.seen, ['bash', 'read', 'edit', 'write', 'todo_write'])
      assert.equal(service(harness).snapshot().counters.nonMcp, 5)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves a server no key names completely alone', async () => {
    const harness = await world({ config: { servers: { alpha: [] } } })
    try {
      const names = crowded('beta', 4)
      for (const name of names) propose(harness.ctx, name)
      assert.deepEqual(harness.recorder.seen, names)
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a 161-tool server down to the allowlist', async () => {
    const harness = await world({ config: { servers: { huge: ['tool_3', 'tool_40'] } } })
    try {
      for (const name of crowded('huge', 161)) propose(harness.ctx, name)
      assert.deepEqual(registeredNames(harness.ctx).sort(), ['mcp__huge__tool_3', 'mcp__huge__tool_40'])
      const { counters } = service(harness).snapshot()
      assert.equal(counters.considered, 161)
      assert.equal(counters.admitted, 2)
      assert.equal(counters.dropped, 159)
    } finally {
      await harness.dispose()
    }
  })

  it('returns a disposer that a re-sync can call', async () => {
    // `syncTools()` keeps every returned disposer and calls them on the next
    // generation. A kept-out tool returns a no-op, and calling it must be safe.
    const harness = await world({ config: { servers: { alpha: [] } } })
    try {
      const dispose = propose(harness.ctx, 'mcp__alpha__x')
      assert.equal(typeof dispose, 'function')
      assert.equal(dispose(), undefined)
      assert.deepEqual(registeredNames(harness.ctx), [])
    } finally {
      await harness.dispose()
    }
  })

  it('matches a hashed leaf, which is the only spelling the registry has', async () => {
    const hashed = publicToolName('alpha', 'a.b')
    const leaf = hashed.slice('mcp__alpha__'.length)
    const harness = await world({ config: { servers: { alpha: [leaf] } } })
    try {
      propose(harness.ctx, hashed)
      propose(harness.ctx, publicToolName('alpha', 'a-b'))
      assert.deepEqual(registeredNames(harness.ctx), [hashed])
      // The raw names differ; only the public leaf is visible, and only it can
      // be configured.
      assert.notEqual(publicToolName('alpha', 'a.b'), publicToolName('alpha', 'a-b'))
    } finally {
      await harness.dispose()
    }
  })
})

describe('observe mode against a live registry', () => {
  it('changes nothing and reports what filter mode would have', async () => {
    const harness = await world({ config: { mode: 'observe', servers: { alpha: ['lookup'] } } })
    try {
      const names = crowded('alpha', 10).concat([publicToolName('alpha', 'lookup')])
      for (const name of names) propose(harness.ctx, name)
      assert.deepEqual(harness.recorder.seen, names)
      const { counters, mode } = service(harness).snapshot()
      assert.equal(mode, 'observe')
      assert.equal(counters.dropped, 0)
      assert.equal(counters.wouldDrop, 10)
    } finally {
      await harness.dispose()
    }
  })
})

describe('off mode', () => {
  it('installs no shadow and provides no service', async () => {
    const harness = await world({ config: { mode: 'off' } })
    try {
      assert.equal(shadowInstalled(harness), false)
      assert.equal(service(harness), undefined)
      propose(harness.ctx, 'mcp__alpha__anything')
      assert.deepEqual(harness.recorder.seen, ['mcp__alpha__anything'])
    } finally {
      await harness.dispose()
    }
  })
})

describe('mounting after the tools are already registered', () => {
  it('records the names it was too late for, and says so', async () => {
    const harness = await world({ plugin: false })
    try {
      propose(harness.ctx, publicToolName('alpha', 'lookup'))
      propose(harness.ctx, 'bash')
      await harness.mount()
      const snapshot = service(harness).snapshot()
      assert.deepEqual(snapshot.coverage.preExisting, ['mcp__alpha__lookup'])
      assert.equal(snapshot.patched, true)
      // A plugin cannot unregister another plugin's tools, so the tool that
      // arrived early stays; what the plugin owes the operator is the fact.
      assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__lookup', 'bash'])
    } finally {
      await harness.dispose()
    }
  })
})

describe('the shadow itself', () => {
  it('is installed on the instance, and removed on dispose', async () => {
    const harness = await world({ config: { servers: { alpha: [] } } })
    const inst = instance(harness.ctx, 'tools')
    const shadowed = inst.register
    assert.equal(shadowInstalled(harness), true)
    assert.equal(service(harness).snapshot().patched, true)
    await harness.dispose()
    assert.equal(shadowInstalled(harness), false)
    assert.equal(inst.register, harness.recorder.fn)
    // After disposal the registry is the registry again.
    propose(harness.ctx, 'mcp__alpha__x')
    assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__x'])
    harness.recorder.restore()
  })

  it('does not swallow a registration the registry rejects', async () => {
    const harness = await world({ config: { servers: { alpha: ['x'] } } })
    try {
      propose(harness.ctx, 'mcp__alpha__x')
      assert.throws(() => propose(harness.ctx, 'mcp__alpha__x'), /already|duplicate|registered/i)
    } finally {
      await harness.dispose()
    }
  })

  it('does not shadow anything else on the service', async () => {
    const harness = await world({ config: { servers: { alpha: [] } } })
    const inst = instance(harness.ctx, 'tools')
    try {
      assert.equal(typeof inst.schemas, 'function')
      assert.equal(typeof inst.restrict, 'function')
      assert.equal(Object.hasOwn(inst, 'schemas'), false)
      assert.equal(Object.hasOwn(inst, 'restrict'), false)
    } finally {
      await harness.dispose()
    }
  })
})
