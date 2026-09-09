# 0097. OpenCode 2 uses HTTP discovery and ACP turns

**Status:** Accepted

## Context

The beta `opencode2` executable exposes a v2 loopback HTTP API and an ACP
stdio entrypoint. Its HTTP API reports provider and model catalogs, while the
ACP transport carries interactive permissions and session updates. The ACP
entrypoint starts a same-binary `serve --stdio` child before speaking ACP.

Octant's existing OpenCode driver uses the HTTP session API, and the shared ACP
driver already enforces project confinement, provider permission replies,
resume identity, cancellation, and bounded event mapping. Treating the beta as
the legacy HTTP runtime would either lose those permission semantics or make
the provider appear configured while no turn could start.

## Decision

- The binary named `opencode2` (and `opencode2.exe`) uses a hybrid driver.
  Provider probes use the beta HTTP catalog so model discovery does not require
  starting an ACP turn session.
- Code and Work turns use the shared ACP driver with an OpenCode 2 profile.
  The profile selects the model and mode through ACP config options and keeps
  structured user questions unavailable until the provider exposes that ACP
  interaction.
- The profile provides an explicit permissions configuration, disables runtime
  update/plugin downloads, suppresses custom plugins and skill discovery, and
  routes cache, config, state, and temporary files into the managed home. It
  reads the existing user OpenCode config file and provider-owned
  authentication directory, while only the authentication directory remains
  writable for provider refresh. No other host configuration path is exposed to
  the child server.
- Chat and Plan do not receive a process-spawn exception. Because their
  ordinary confinement rules deny the beta entrypoint's child server, those
  modes fail closed with a clear incompatibility state.
- The beta ACP path does not claim Octant's app-managed Browser capability.
  That capability requires an explicit ACP MCP transport and remains separate
  from provider-owned permission requests.

## Consequences

- OpenCode 2 can populate the model picker from its real configured catalog and
  run approval-aware Code and Work sessions through the provider-neutral ACP
  stack.
- Missing provider authentication or an empty catalog remains a truthful
  readiness failure; no dummy model or legacy fallback is synthesized.
- Code and Work inherit the existing child-server launch rules: process
  execution stays restricted to the attested OpenCode binary and its launch
  interpreter, while file, network, and approval policy continue to come from
  Octant.
- A future OpenCode 2 release that speaks ACP without the nested server can
  remove the profile's child-server requirement after a new conformance check.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0009 Sandbox confinement and approvals
- 0093 App-owned tools use managed runtime transports
