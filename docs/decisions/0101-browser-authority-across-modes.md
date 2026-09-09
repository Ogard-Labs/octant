# 0101. Browser authority follows the thread across modes

**Status:** Accepted

## Context

Browser is host-owned, but the previous resolver accepted only Work and Code and
only Code composed the app-owned browser tool independently of the native
harness. Chat's virtual context must not be promoted into filesystem authority
merely to read or operate a page. Unfiled Chat threads have no Project.

## Decision

- The same provider-neutral Browser capability is available on demand in Chat,
  Work, and Code when the host and selected runtime/model support it. Every
  adapter receives the app-owned catalogue through the provider SDK seam.
- Chat browser authority names the real host, window, thread, and provider.
  It may carry its actual Chat Project; unfiled Chat has no Project field.
  It never contains a root or worktree. Work/Code keep their current required
  Project identity and existing root/worktree validation. No sentinel Project,
  invented checkout, or synthetic Code thread is permitted.
- A browser grant is bound to the host process, window, thread, mode, provider,
  model, context, and approved origins. The first effect asks through a bounded
  inline request. Denial, expiry, stop, changed ownership, cancellation, and
  late or duplicate answers cannot start or resume an effect.
- Browser grants do not change Full access, shell, filesystem, provider
  authentication, or general network policy. Existing Plan restrictions remain.
  Chat's research preference controls its search behavior; it does not silently
  grant a browser context. Explicit Browser use requests its own origin grant.
- The visible Browser is the same isolated context the agent controls. Chat
  opens it only on demand and does not regain a generic utility launcher or
  unrelated tool panels. Requests from background threads remain owned by those
  threads and cannot attach to the active thread's composer or page.
- Approval requests/results use shared normalized request lifecycle seams,
  not another provider's native-harness session state. Profile allowlists,
  untrusted page provenance, credential-field protection, and origin checks
  still apply on the host before every effect.

## Consequences

This is a scoped extension of 0003's Chat network capability and 0093's
Code-specific browser-grant presentation. It does not weaken their remaining
mode, provider, or confinement rules. It extends 0099 only for an explicitly
opened Browser in Chat, without reintroducing generic tools chrome.

Conformance must prove real threaded ownership, approval/cancellation, and
unfiled Chat behavior without adding filesystem authority. Provider/runtime
limitations and unavailable real-account evidence remain explicit.
