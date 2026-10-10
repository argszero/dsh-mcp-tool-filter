/**
 * The object a profile entry mounts, mounted.
 *
 * `vendor/loader` normalises a plugin module with `exports.default ?? exports`
 * and hands that object to `ctx.plugin`, which reads `Config['~standard'].validate`
 * off it whenever it carries a `Config`. Most of this suite mounts the
 * *namespace* (`import * as plugin`), which has no `Config` of its own — so the
 * two mounts are one object apart, and only this file mounts the one a profile
 * entry reaches.
 *
 * That difference is not academic. Published packages in this ecosystem have
 * exported `Config: defaults` where the defaults were a plain object, and every
 * mount of the installed package died with
 * `TypeError: Cannot read properties of undefined (reading 'validate')` before a
 * line of `apply` ran, while their suites stayed green because the namespace
 * import never carried that key.
 *
 * Both arms are kept: the invariant that a `Config` may only be a schema, and
 * the mount itself.
 *
 * @module test/mount
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import plugin from '../lib/index.js'
import { propose, registeredNames, service, shadowInstalled, world } from './harness.mjs'

describe('the default export', () => {
  it('carries a Config only if it is a schema cordis can validate with', () => {
    const Config = plugin.Config
    if (Config === undefined) return
    assert.equal(
      typeof Config['~standard']?.validate,
      'function',
      'cordis calls Config["~standard"].validate at mount; a plain defaults object throws there',
    )
  })

  it('exposes exactly the keys a loader entry needs', () => {
    assert.equal(typeof plugin.apply, 'function', 'the default export is the plugin a loader resolves')
    assert.equal(plugin.name, 'mcp-tool-filter')
    assert.deepEqual(plugin.inject, ['tools'])
    assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject', 'name'])
  })

  it('mounts the way a loader entry mounts it — shadow and service included', async () => {
    const harness = await world({ plugin: false, record: true })
    try {
      await harness.mountDefault({ servers: { alpha: ['lookup'] } })
      assert.equal(shadowInstalled(harness), true, 'the mount a profile reaches installs the shadow')
      assert.equal(service(harness).snapshot().patched, true)
      propose(harness.ctx, 'mcp__alpha__lookup')
      propose(harness.ctx, 'mcp__alpha__secret')
      assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__lookup'])
    } finally {
      await harness.dispose()
    }
  })

  it('mounts with no configuration at all, which is what an entry with no config does', async () => {
    const harness = await world({ plugin: false })
    try {
      await harness.mountDefault()
      assert.equal(shadowInstalled(harness), true)
      // No rules: nothing is filtered, and nothing is claimed to be.
      const snapshot = service(harness).snapshot()
      assert.deepEqual(snapshot.coverage.configured, [])
      propose(harness.ctx, 'mcp__alpha__anything')
      assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__anything'])
    } finally {
      await harness.dispose()
    }
  })

  it('fails the mount loudly rather than running with a configuration it did not understand', async () => {
    const harness = await world({ plugin: false })
    try {
      await assert.rejects(async () => { await harness.ctx.plugin(plugin, { mode: 'fliter' }) }, /mode must be one of/)
      assert.equal(shadowInstalled(harness), false, 'a mount that threw installed nothing')
    } finally {
      await harness.dispose()
    }
  })
})

describe('the plugin as a namespace', () => {
  it('mounts too — the plugin object is the same shape either way', async () => {
    const harness = await world({ plugin: false })
    try {
      await harness.mount()
      assert.equal(shadowInstalled(harness), true)
      assert.equal(typeof service(harness).snapshot, 'function')
      assert.equal(typeof service(harness).reset, 'function')
      service(harness).reset()
      assert.equal(service(harness).snapshot().counters.considered, 0)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves the register signature alone: a definition still round-trips', async () => {
    const harness = await world({ config: { servers: {} } })
    try {
      const dispose = propose(harness.ctx, 'mcp__alpha__x')
      assert.equal(typeof dispose, 'function')
      assert.deepEqual(registeredNames(harness.ctx), ['mcp__alpha__x'])
      dispose()
      assert.deepEqual(registeredNames(harness.ctx), [])
    } finally {
      await harness.dispose()
    }
  })
})
