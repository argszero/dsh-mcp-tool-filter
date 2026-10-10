# @argszero/dsh-mcp-tool-filter

Keeps the tools a deployment does not want out of the tool registry, per MCP
server, at registration time.

`dsh-mcp-client` registers **every** tool a connected server lists, unconditionally.
A server advertising 161 tools therefore puts 161 tools — and their full JSON
schemas — into every request that assembles the tool surface, whether the
deployment uses five of them or none
([#9385](https://github.com/deepseek-ai/deepseek-harness/discussions/9385)).

This plugin shadows `register` on the tools service and forwards a registration
only when the tool's server is one the deployment named **and** the tool is on
that server's allowlist.

It is an **allowlist over public tool names**, and it says so on every report it
serves.

## The gap, measured

`syncTools()` in `packages/mcp/mcp-client/src/tools.ts` builds a definition for
every entry of `tools/list` and then registers the whole generation:

```ts
for (const [publicName, definition] of definitions) {
  disposers.set(publicName, ctx.tools.register(definition))
}
```

`registrationFailure` decides what a *namespace collision* does — roll the
generation back, or throw. Nothing decides what a tool the deployment does not
want does.

The neighbouring API is `ctx.tools.restrict()` (`packages/core/tools/src/index.ts`),
and it is not the same thing three ways over:

| | `restrict()` | this plugin |
|---|---|---|
| context | requires a **scoped** context; on a global one it throws by design | any context |
| unknown names | **throws**, which is exactly what a `tools/list` that changed between boots produces | unmatched names are simply not filtered |
| effect | masks a definition that **stays registered and introspectable** | the definition never enters the registry |

## Install

```sh
npm install @argszero/dsh-mcp-tool-filter
```

The bundle patch inserts one row. **List it before the `mcp-client` rows** — see
[Mount before the servers](#mount-before-the-servers) below.

```yaml
# cordis.patch.yml
- insert:
    - id: mcp-tool-filter
      name: '@argszero/dsh-mcp-tool-filter'
      config:
        servers:
          github:
            - list_issues
            - create_issue
            - get_issue
          filesystem: []
          playwright:
            - browser_navigate
            - browser_take_screenshot
```

## Configuration

| key | default | meaning |
|-----|---------|---------|
| `mode` | `filter` | `filter` keeps unlisted tools out; `observe` registers everything and counts what `filter` would have kept out; `off` mounts nothing |
| `servers` | `{}` | per-server allowlists, keyed by the `serverName` in that server's `mcp-client` entry |
| `report` | `true` | whether the mount, first-rejection and unmount summaries are logged |

Every field is optional. An invalid **value** fails the mount —
`mode: fliter` is an error, not a silent default, because the operator who wrote
the typo is the one person who cannot see it. A well-formed key that turns out to
match nothing is not an error; it is reported (see [Coverage](#coverage)).

### `servers`

| the key | what happens |
|---------|--------------|
| **absent** | the server is not filtered — every tool it lists is registered exactly as before |
| mapped to `[]` | **nothing** from that server is registered |
| mapped to a list | only those leaves are registered |

The two extremes are different answers and the plugin keeps them apart: a key you
did not write is a server you have not thought about, and a key mapped to an empty
list is one you have decided about.

Entries are matched against the **public leaf name** — `mcp__<serverName>__<rawName>`
minus the prefix. For a raw name that already satisfies the DeepSeek function-name
contract (`[A-Za-z0-9_-]{1,64}`) the two are identical:

```yaml
servers:
  github:
    - list_issues            # mcp__github__list_issues
```

For one that does not, the leaf is the normalized spelling and carries a 12-hex
identity hash, because `publicToolName()` appends one so that two raw names cannot
collapse into the same public name:

```yaml
servers:
  github:
    # mcp__github__a.b  →  mcp__github__a_b_531a020b8a5f
    - a_b_531a020b8a5f
```

Set `mode: observe` and read the service to find the spelling of a tool you are
unsure about, rather than guessing.

### Mount before the servers

```yaml
- insert:
    - id: mcp-tool-filter          # ← first
      name: '@argszero/dsh-mcp-tool-filter'

    - id: mcp-github               # ← then the servers
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        # …
```

A cordis loader mounts entries in the order a profile lists them, and `mcp-client`
registers its first generation while it starts. A filter mounted after those rows
has missed that generation — and a plugin cannot unregister another plugin's
tools. When that happens the mount says so, and the snapshot names the tools it
was too late for:

```json
{ "coverage": { "preExisting": ["mcp__github__list_issues", "…"] } }
```

Everything registered after the shadow is installed is filtered normally, so this
is a startup-ordering fact rather than a permanent hole.

## The report

```ts
ctx.mcpToolFilter.snapshot()
// {
//   mode: 'filter',
//   patched: true,
//   counters: { considered: 167, admitted: 6, dropped: 161,
//               wouldDrop: 0, nonMcp: 4, unlistedServer: 0, unjudgeable: 0 },
//   drops: ['mcp__github__delete_repo', …],
//   dropsTruncated: false,
//   coverage: { … }
// }
```

`ctx.mcpToolFilter.reset()` zeroes the counters and the observed sets; the
configuration and the shadow stay as they are.

The log gets one line per mount, **one line per server the first time a tool is
kept out of it** (not one per tool — a 161-tool server would otherwise write 161
lines), and one line on unmount:

```
mcp-tool-filter: mounted in filter mode — 3 server rule(s), 6 allowlisted tool name(s)
mcp-tool-filter: server "github": not registering "mcp__github__delete_repo" (not on its allowlist; 3 name(s) are)
mcp-tool-filter: unmounted — admitted 6/167; kept out 161; idle server key(s): playwright
```

## Coverage

A filter that removes tools silently is indistinguishable from a broken
deployment: the tools are simply not there, and nothing says whether that was the
allowlist, a typo in a server key, or a server that never connected. The snapshot
carries the answers:

| field | the question it answers |
|-------|------------------------|
| `coverage.configured` | which server keys you wrote |
| `coverage.covered` | which of them a registration actually matched |
| `coverage.idle` | which of them matched nothing — usually a typo, or a server that did not connect |
| `coverage.unusedLeaves` | which allowlist entries never matched anything — a tool that was renamed, or a misspelling |
| `coverage.unmatchable` | which keys **can never** match, and why |
| `coverage.preExisting` | which MCP tools were already registered when the shadow went in |
| `coverage.seenTruncated` | whether a server's observed-leaf set hit its bound |

None of these is an error. A configured name that never matched is neither a
violation nor a pass, and the plugin reports it as neither.

## What it does not do

- **It reads public names, not raw ones.** The raw tool name lives in a closure
  on the definition and is never a field, so a name that `publicToolName()`
  normalized or hashed is seen in its public spelling.
- **It narrows what the client registers, not what the server lists.** The
  `tools/list` round trip is unchanged; the server is never told. A deployment
  that needs the server to stop advertising the tools needs the server's own
  configuration.
- **It does not remove a tool that is already registered.** Nothing can: there is
  no unregister-another-plugin's-tool seam. That case is reported instead.
- **It does not replace `restrict()`.** A per-agent restriction over registered
  tools is still `restrict()`'s job, and this plugin changes nothing about it.
- **It does not inspect a tool's schema or arguments.** The decision is over the
  name, at registration, once.

## The real fix

This plugin exists because the seam is reachable and the change is small, not
because a plugin is the right place for it. The product change is a per-server
`allowedTools` on the `mcp-client` entry itself — it is the plugin's own
configuration, applied one layer earlier, where the `rawName` is still in hand and
nothing has to be inferred from a public name — and the report asks for exactly
that. Until then this is a working answer that needs no upstream change and can be
removed the day the entry grows the field.

## Development

```sh
npm install
npm test                 # tsc, then the suites (unit + a live dsh-tools registry)
npm run test:inject      # mutate the source, rebuild, require the suite to catch it
npm run probe:lines      # install each published release line, run the suite there
npm run probe:naming     # re-derive publicToolName() from that line's own mcp-client
```

The integration suite mounts the real `@deepseek-ai/dsh-tools` registry and asks
the registry's own projection what it holds; it never re-implements the registry,
because the whole point of the package is what the registry does with someone
else's call.

## License

MIT
