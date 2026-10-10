/**
 * Defect injection: mutate the source, rebuild, run the affected suite, and
 * require that the mutation is caught. An arm whose mutation leaves the suite
 * green is SILENT — it proves nothing about the test that was supposed to hold
 * the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`)
 * in the tree would be worse than no injector.
 *
 * Every mutation here is a defect this plugin could plausibly ship — an inverted
 * test, a guard made unreachable, a bound moved, a bookkeeping map replaced, the
 * seam installed on the wrong object. None is engineered to be caught: each
 * names the shape of mistake the arm exists for.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'a bare prefix with no leaf is attributed to its server, so a malformed name becomes filterable',
    file: 'src/detect.ts',
    arms: 'detect.spec.mjs',
    edits: [['  if (leaf.length === 0) continue', '  if (leaf.length === -1) continue']],
  },
  {
    name: 'the first matching prefix wins instead of the most specific one, so a nested server key steals its parent',
    file: 'src/detect.ts',
    arms: 'detect.spec.mjs',
    edits: [[
      '    if (best !== undefined && prefix.length <= name.length - best.leaf.length) continue',
      '    if (best !== undefined && prefix.length >= name.length - best.leaf.length) continue',
    ]],
  },
  {
    name: 'every name counts as an MCP name, so core tools are attributed to servers',
    file: 'src/detect.ts',
    arms: 'detect.spec.mjs',
    edits: [['  return name.startsWith(MCP_PREFIX)', '  return true']],
  },
  {
    name: 'the namespace test is inverted, so a filter with a server rule stops judging the namespace',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['    if (!isMcpName(raw)) {', '    if (isMcpName(raw)) {']],
  },
  {
    name: 'the allowlist membership test is inverted, so the server keeps exactly the tools it was not allowed',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [[
      "    if (rule?.admitted.has(match.leaf) === true) return { kind: 'admit' }",
      "    if (rule?.admitted.has(match.leaf) === false) return { kind: 'admit' }",
    ]],
  },
  {
    name: 'the modes are swapped, so observe removes tools and filter only counts them',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [["    if (this.mode === 'observe') {", "    if (this.mode === 'filter') {"]],
  },
  {
    name: 'a name that cannot be judged is not counted, so the snapshot claims every registration was judgeable',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['      this.counters.unjudgeable += 1', '      this.counters.unjudgeable += 0']],
  },
  {
    name: 'non-MCP registrations stop being counted, so the snapshot cannot say the filter left them alone',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['      this.counters.nonMcp += 1', '      this.counters.nonMcp += 0']],
  },
  {
    name: 'a matched leaf is never recorded, so every allowlist entry reads as an unused one',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [[
      '    if (leaves.size < SEEN_LIMIT || leaves.has(match.leaf)) leaves.add(match.leaf)',
      '    if (leaves.size < -1 || leaves.has(match.leaf)) leaves.add(match.leaf)',
    ]],
  },
  {
    name: 'the drop list grows one past its limit and never reports truncation',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['    if (this.drops.length < DROP_LIST_LIMIT) this.drops.push(verdict.name)', '    if (this.drops.length <= DROP_LIST_LIMIT) this.drops.push(verdict.name)']],
  },
  {
    name: 'every pre-existing name is reported as an MCP name, so the catch-up warning names core tools',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['    this.preExisting = names.filter(isMcpName)', '    this.preExisting = [...names]']],
  },
  {
    name: 'the idle list reports the servers that were covered, not the ones that were not',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [[
      '        idle: this.settings.servers.map(rule => rule.name).filter(name => !this.covered.has(name)),',
      '        idle: this.settings.servers.map(rule => rule.name).filter(name => this.covered.has(name)),',
    ]],
  },
  {
    name: 'the once-per-server announcement becomes once per tool, so a 161-tool server writes 161 lines',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['    if (this.announced.has(match.server)) return', '    if (this.announced.has(match.server) && false) return']],
  },
  {
    name: 'the covered set records leaves instead of servers, so the coverage report names the wrong owner',
    file: 'src/filter.ts',
    arms: 'filter.spec.mjs',
    edits: [['    this.covered.add(match.server)', '    this.covered.add(match.leaf)']],
  },
  {
    name: 'off mode still installs the shadow, so a deployment that asked for nothing gets a filter',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [["  if (settings.mode === 'off') return", "  if ((settings.mode as string) === 'never') return"]],
  },
  {
    name: 'the shadow lands on the view instead of the service instance, so a caller reaching the registry by name never meets it',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      '    const underlying = (Reflect.get(view as object, ORIGINAL) as ToolRuntime | undefined) ?? view',
      '    const underlying = view',
    ]],
  },
  {
    name: 'unmount deletes the property instead of restoring what was underneath, so the registration path is left on the prototype',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      "        if (ownRegister) Reflect.set(underlying, 'register', original)\n        else Reflect.deleteProperty(underlying, 'register')",
      "        Reflect.deleteProperty(underlying, 'register')",
    ]],
  },
  {
    name: 'the registration name is never read, so every tool is admitted and the filter removes nothing',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [['          () => (definition as { name?: unknown } | null | undefined)?.name,', '          () => undefined,']],
  },
  {
    name: 'an unknown mode is accepted instead of failing the mount, so a typo runs as something else',
    file: 'src/config.ts',
    arms: 'config.spec.mjs',
    edits: [['  if (!MODES.includes(mode)) {', '  if (!MODES.includes(mode) && false) {']],
  },
  {
    name: 'a non-array allowlist is silently skipped instead of failing the mount, so a written rule removes nothing',
    file: 'src/config.ts',
    arms: 'config.spec.mjs',
    edits: [[
      '      throw new TypeError(`mcp-tool-filter: servers.${name} must be an array of tool names, got ${describe(value)}`)',
      '      continue',
    ]],
  },
  {
    name: 'an empty allowlist entry is accepted, so a rule can admit a name no tool can carry',
    file: 'src/config.ts',
    arms: 'config.spec.mjs',
    edits: [[
      "      if (typeof leaf !== 'string' || leaf.length === 0) {",
      "      if (typeof leaf !== 'string' && leaf.length === 0) {",
    ]],
  },
  {
    name: 'the serverName contract is inverted, so valid keys are marked unmatchable and invalid ones are matched',
    file: 'src/config.ts',
    arms: 'config.spec.mjs',
    edits: [['  if (!SERVER_NAME.test(name)) {', '  if (SERVER_NAME.test(name)) {']],
  },
  {
    name: 'the public-name prefix is assembled in the wrong order, so no registration ever matches it',
    file: 'src/config.ts',
    arms: 'config.spec.mjs',
    edits: [[
      '    const prefix = `${MCP_PREFIX}${name}${SERVER_SEPARATOR}`',
      '    const prefix = `${MCP_PREFIX}${SERVER_SEPARATOR}${name}`',
    ]],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run one suite file; true when it failed, plus its output. */
function runSuite(arms) {
  try {
    execFileSync(process.execPath, ['--test', `test/${arms}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes every
// CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite('*.spec.mjs')
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) continue

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite(mutation.arms)
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a mutation
    // or a stale `lib/` behind is the failure mode this file exists to avoid, and a
    // stale `lib/` is how an arm goes SILENT.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught) silent += 1
  console.log(`${caught ? 'CAUGHT' : 'SILENT'}: ${mutation.name} (${mutation.arms})`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}`)
if (silent > 0 || unbuildable > 0) process.exit(1)
