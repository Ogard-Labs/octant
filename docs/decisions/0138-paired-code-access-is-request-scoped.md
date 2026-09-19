# 0138. Paired Code access is request-scoped

**Status:** Accepted

## Context

Code services still accept an opaque window-shaped scope identifier. Local
windows use their selected Project as an authority boundary. Paired devices
have no desktop workspace: applying that local rule to their device scope
refused checkout preparation and hid Code threads despite authenticated
admission to the remote product API.

## Decision

- Carry the verified principal context from authenticated product dispatch to
  the existing Code Project access seam using server-owned async request scope.
  A remote device can reach existing active Code Projects on its paired host.
  The server rechecks active Project state on every access; Code services still
  resolve thread, checkout, root binding, provider, posture, and approval policy.
- The service scope must match the authenticated context. Request cancellation
  and dispatch completion remove this admission, including from asynchronous
  descendants. No persistent grant, selected device workspace, or local-window
  registration is created. Already admitted host operations retain their own
  ordinary operation lifecycle and authority checks.
- Local windows retain their selected-Project restriction. No remote route can
  bind or relink a filesystem root, change desktop navigation, or mint native
  authority. The remote operation initiator remains subject to approval policy.
- The authentication layer honors the classified route's declared request media
  types. This includes the bounded plain-text Code evidence upload; unclassified
  callers retain the conservative default media types. Device proofs still bind
  the exact body, method, and target, and ordinary CSRF and replay checks apply.

## Consequences

Mobile and paired browsers can create and read Code threads without emulating a
local window or sharing mutable navigation state between concurrent requests.
Tests must cover request isolation, cancelled and completed dispatch, inactive
Projects, local-window restrictions, and signed evidence uploads. This completes
the principal boundary described in 0013; it does not authorize remote shell
administration or any new distribution channel.

## Related

- 0013 Remote access: single host, paired devices, and mobile
- 0017 Code Projects bind arbitrary directories
