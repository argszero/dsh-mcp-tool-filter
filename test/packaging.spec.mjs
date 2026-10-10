/**
 * What the publish would actually ship.
 *
 * The suite imports `lib/*.js`, which is the build output — but the build output
 * is not the tarball. `npm pack` decides the tarball from `files` in
 * `package.json`, and it omits a file that falls outside those patterns
 * **silently**: the package installs, the entry loads, and the first import of
 * the missing module is where a consumer finds out. So the assertion here is not
 * "the pattern looks right" but the closure itself — every relative import the
 * entry can reach, resolved and checked against the list npm reports.
 *
 * `npm pack --dry-run` is used rather than a re-implementation of glob matching
 * because the thing being checked is npm's own behaviour, and a re-implementation
 * agrees with itself.
 *
 * @module test/packaging
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** npm ships beside node in every layout this repository targets. */
const NPM = join(dirname(process.execPath), 'npm')

/** The file list npm reports for this package. */
function packed() {
  const output = execFileSync(NPM, ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
  const [info] = JSON.parse(output)
  return info.files.map(file => file.path)
}

/** Every relative import specifier reachable from one shipped file. */
function relativeImports(path) {
  const source = readFileSync(join(ROOT, path), 'utf8')
  const found = []
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) found.push(match[1])
  for (const match of source.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) found.push(match[1])
  return found
}

describe('package manifest', () => {
  it('publishes with public access, because a scoped package does not by default', () => {
    // Without this, `npm publish` fails with E402 — a scoped package is private
    // unless told otherwise, and the failure arrives at the registry.
    assert.equal(MANIFEST.publishConfig?.access, 'public')
    assert.equal(MANIFEST.name.startsWith('@'), true)
  })

  it('declares the bundle patch the loader mounts', () => {
    assert.equal(MANIFEST.dsh?.bundle?.patch, './cordis.patch.yml')
  })

  it('declares a peer for every harness capability it touches', () => {
    assert.ok(MANIFEST.peerDependencies['@deepseek-ai/cordis'])
    assert.ok(MANIFEST.peerDependencies['@deepseek-ai/dsh-tools'])
    // Every release line gets its own explicit segment: a range that names only
    // one line admits nothing on the others, and a bare caret silently refuses
    // the prereleases the harness actually publishes.
    const tools = MANIFEST.peerDependencies['@deepseek-ai/dsh-tools']
    for (const line of ['0.1.7-', '0.2.0-', '0.2.1-']) {
      assert.ok(tools.includes(line), `peer range must name the ${line} line: ${tools}`)
    }
    assert.equal(MANIFEST.dependencies, undefined, 'a zero-dependency plugin declares none')
  })
})

describe('the published tarball', () => {
  it('ships the entry, its types and the patch', () => {
    const files = packed()
    for (const required of [
      'package.json',
      'lib/index.js',
      'lib/types/index.d.ts',
      'cordis.patch.yml',
      'README.md',
      'LICENSE',
    ]) {
      assert.ok(files.includes(required), `${required} is missing from npm pack: ${files.join(', ')}`)
    }
  })

  it('ships nothing that was not meant to be published', () => {
    const files = packed()
    assert.equal(files.some(path => path.startsWith('src/')), false)
    assert.equal(files.some(path => path.startsWith('test/')), false)
    assert.equal(files.some(path => path.startsWith('scripts/')), false)
  })

  it('has a relative import closure entirely inside the tarball', () => {
    const files = new Set(packed())
    const seen = new Set()
    const queue = ['lib/index.js']
    const missing = []
    while (queue.length > 0) {
      const path = queue.pop()
      if (seen.has(path)) continue
      seen.add(path)
      if (!files.has(path)) missing.push(path)
      for (const specifier of relativeImports(path)) {
        const target = join(dirname(path), specifier)
        queue.push(target.startsWith('./') ? target.slice(2) : target)
      }
    }
    assert.deepEqual(missing, [], 'these files are imported but not packed')
    // The closure is the whole dist, so the walk is not vacuous.
    assert.ok(seen.size >= 4, `the closure should cover the modules: ${[...seen].join(', ')}`)
  })

  it('points main, types and exports at files that are actually packed', () => {
    const files = new Set(packed())
    assert.ok(files.has(MANIFEST.main), `main: ${MANIFEST.main}`)
    assert.ok(files.has(MANIFEST.types), `types: ${MANIFEST.types}`)
    for (const [key, value] of Object.entries(MANIFEST.exports['.'])) {
      assert.ok(files.has(value.slice(2)), `exports["."].${key}: ${value}`)
    }
  })
})
