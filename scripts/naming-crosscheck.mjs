/**
 * The one function this plugin has to agree with, checked against the shipped
 * one — per release line.
 *
 * `mcp-client` never exports `publicToolName()`, and it is the only thing that
 * decides what a registration's name *is*: the raw tool name lives in a closure
 * and never appears as a field, so `mcp__<server>__<leaf>` is the whole of what
 * this plugin and the registry can see. `test/harness.mjs` carries a replica of
 * that function so the suite can generate the names a real server's tools arrive
 * under; a replica is only worth having while it is known to be the same
 * function, and "known" has to be re-established on every line the peer range
 * claims.
 *
 * So this script takes the published bundle for a line, cuts the function and
 * the three constants it closes over out of it, and runs both implementations
 * over a vector set that reaches all three of the shipped branches — the clean
 * name, the lossy (normalized + hashed) name, and the truncated one. The
 * constants travel with the function on purpose: an extraction that pulled the
 * function alone threw `ReferenceError: INVALID_NAME_CHARS is not defined`, and
 * a bundle whose constant set moved is exactly what this check is for.
 *
 * ```sh
 * node scripts/naming-crosscheck.mjs              # every line the range claims
 * node scripts/naming-crosscheck.mjs 0.2.0-rc.2   # one line
 * ```
 *
 * @module scripts/naming-crosscheck
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import semver from 'semver'
import { publicToolName as replica } from '../test/harness.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Where the function lives in the packed tarball. */
const BUNDLE = 'package/lib/index.js'

/** The constants the shipped function closes over, in the spelling the bundle uses. */
const CONSTANTS = ['MAX_PUBLIC_NAME_LENGTH', 'INVALID_NAME_CHARS', 'HASH_LENGTH']

/**
 * The vector set both implementations are run over.
 *
 * Deliberately not a cross product of "interesting" names: each row is chosen to
 * land in a known branch of the shipped function, so a mismatch names the branch
 * rather than a statistic. `x`.repeat(32) is the longest legal `serverName`, and
 * the long raw names reach the truncation branch that only a name longer than 64
 * characters can reach.
 */
const SERVERS = ['github', 'gh', 'a_b', 'srv-1', 'x'.repeat(32)]
const RAW = ['lookup', 'a.b', 'a-b', '_', 'x'.repeat(20), 'x'.repeat(50), 'n'.repeat(80), 'über', '']

/** Cut one `const NAME = …;` declaration out of the bundle. */
function constantOf(source, name) {
  const start = source.indexOf(`const ${name} =`)
  if (start === -1) throw new Error(`the bundle no longer declares ${name}`)
  const end = source.indexOf('\n', start)
  const line = source.slice(start, end === -1 ? undefined : end)
  if (!line.endsWith(';')) throw new Error(`the declaration of ${name} is not a single line: ${line}`)
  return line
}

/**
 * Build the shipped `publicToolName()` from a bundle's source.
 * @param source - the published `lib/index.js`.
 * @returns the function, as the bundle defines it.
 */
export function extract(source) {
  const start = source.indexOf('function publicToolName(')
  if (start === -1) throw new Error('the bundle no longer defines publicToolName')
  const end = source.indexOf('\n}\n', start)
  if (end === -1) throw new Error('could not find the end of publicToolName')
  const body = source.slice(start, end + 3)
  const constants = CONSTANTS.map(name => constantOf(source, name)).join('\n')
  // `createHash` arrives as a parameter because the bundle imports it from
  // `node:crypto`; everything else the function needs is in its own bundle.
  return new Function('createHash', `${constants}\n${body}\nreturn publicToolName`)(createHash)
}

/** Pack one line's bundle, extract the function, and compare it with the replica. */
function check(line) {
  const dir = mkdtempSync(join(tmpdir(), `mcp-tool-filter-naming-${line}-`))
  try {
    const tarball = execFileSync('npm', ['pack', `@deepseek-ai/dsh-mcp-client@${line}`, '--silent'], { cwd: dir, encoding: 'utf8' })
      .trim().split('\n').pop()
    execFileSync('tar', ['xzf', tarball], { cwd: dir, stdio: 'ignore' })
    const shipped = extract(readFileSync(join(dir, BUNDLE), 'utf8'))
    const examples = []
    let mismatches = 0
    for (const server of SERVERS) {
      for (const raw of RAW) {
        const expected = shipped(server, raw)
        const actual = replica(server, raw)
        if (expected !== actual) {
          mismatches += 1
          if (examples.length < 5) examples.push(`${server}/${raw}: shipped ${expected}, replica ${actual}`)
        }
      }
    }
    const total = SERVERS.length * RAW.length
    process.stdout.write(`    mcp-client@${line}: ${total - mismatches}/${total} vectors agree${mismatches === 0 ? '' : ` — ${examples.join('; ')}`}\n`)
    return mismatches === 0
  } catch (error) {
    process.stdout.write(`    mcp-client@${line}: could not be checked — ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const requested = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
const versions = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh-mcp-client', 'versions', '--json'], { encoding: 'utf8' }))
/** The newest published build of each `||` segment of the range — one representative per line. */
const lines = requested.length > 0
  ? requested
  : range.split('||').map(segment => semver.maxSatisfying(versions, segment.trim())).filter(Boolean)

process.stdout.write(`peer range: ${range}\n`)
const seen = new Set()
const failed = lines.filter(line => {
  if (seen.has(line)) return false
  seen.add(line)
  return !check(line)
})
process.stdout.write(`checked ${seen.size} line(s); disagreeing: ${failed.length === 0 ? 'none' : failed.join(', ')}\n`)
if (failed.length > 0) process.exitCode = 1
