# 0113. Computer use is a bundled plugin with a managed driver

**Status:** Accepted

## Context

The computer-use policy and lifecycle backend exists, but agents cannot invoke
it and Settings cannot configure it. Its basic macOS adapter uses JXA. The
maintainer requests a Computer use plugin, addressed as `@Computer`, with
bundled CuaDriver and automatic upgrades.

## Decision

- Octant bundles a first-party **Computer use** plugin. Its composer name is
  **Computer**. A structured selection exposes its tools for that task across
  supported providers; text that happens to mention a computer grants nothing.
  The plugin uses the public plugin API and the host's computer-use capability.
- The first supported destination is the local macOS desktop. Chat remains
  virtual: computer use grants no implicit shell, filesystem, or Project-root
  access. Plan mode refuses control. Remote clients cannot acquire local
  computer-use authority through a mention.
- The desktop process owns an embedded CuaDriver child and a private endpoint.
  It never attaches to a user's standalone driver or launches through another
  application identity. macOS permissions belong to Octant. Driver lifetime,
  cancellation, target identity, and session cleanup remain host-owned.
- Settings exposes plugin enablement, permission status and setup, driver
  version, manual update checking, and automatic updates. Bundling establishes
  the reviewed first-party package, not permission to control applications.
  Application grants are explicit, bounded to the requesting task and host
  process, expire, and are revoked on stop or disable.
- Provider tools expose bounded observations and structured actions. Every
  action uses an observed application and window, validates its observation
  revision, and is followed by a new observation. Page and application content
  stays untrusted; protected fields, approval, and origin rules still apply.
- CuaDriver ships as a pinned MIT-licensed dependency outside ASAR. The build
  verifies its release hash and macOS signature before packaging it. License
  attribution ships with the app.
- Automatic driver updates are enabled by default and can be disabled. This
  explicitly extends 0034 for the replaceable driver only; the app's own
  relaunch policy is unchanged. Checks request stable CuaDriver releases from
  its upstream repository, send no task content or identifiers, and run daily.
- A downloaded candidate must match its published hash, the pinned upstream
  Developer ID identity, the host architecture, and the supported driver
  contract. HTTPS and an upstream checksum alone do not authorize execution.
  A failed check keeps the current version and reports the reason.
- Updates stage into a private version directory and activate only after all
  computer-use work is idle. A failed startup restores the previous verified
  version. Neither an update nor a plugin invocation expands permissions, and
  the updater never executes an upstream installer or modifies a standalone
  CuaDriver installation.

## Consequences

Computer-use setup, runtime, guidance, and updates form one deliverable.
Unavailable permissions or an incompatible driver are visible states, not an
invitation for a provider to bypass Octant through shell commands. The bundled
version remains the offline fallback. Linux and Windows destinations require
separate confinement and update verification before being advertised.

## Related

- 0001 Plugin architecture
- 0005 Provider SDK and honest capabilities
- 0009 Sandbox confinement and approvals
- 0011 Extension activation
- 0034 Signed updates
- 0053 Computer-use destinations
