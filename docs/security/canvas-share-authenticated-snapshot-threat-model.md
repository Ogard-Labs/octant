# Canvas authenticated snapshot threat model

- Date: 2026-08-04
- Threat model id: `canvas-share-authenticated-snapshot-v1`
- Scope: authenticated browser snapshots, owner-visible audience, expiry,
  revocation, and privacy-preserving access logs

## Assets

- Authenticated snapshot envelope bound to Canvas, version, sequence, host, and Project
- Sanitized offline document payload reused from static export
- Owner-visible audience labels and principal membership
- Privacy-preserving access-log outcomes and coarse browser family

## Explicit non-goals

- Public or anonymous share links
- Live host credentials, Keychain material, or cross-host authority
- Raw user-agent, request body, cookie, path, or authorization retention
- Implicit refresh of snapshot content without owner reissue

## Trust boundaries

1. Snapshot create/revoke is owner-authenticated and consent-gated.
2. Snapshot access evaluates principal membership, expiry, and revocation at the
   request time, never from renderer flags alone.
3. Access-log producers may omit `audienceLabel` for privacy, but lifecycle
   validation still requires authenticated principal context for audience
   outcomes.
4. Historical access-log replay evaluates lifecycle at `occurredAt`, so a later
   revocation does not rewrite earlier allowed events.
5. Contract decoding rejects secret-bearing labels, host paths, active+revoked
   inconsistencies, and document/envelope identity mismatches.

## Threats and mitigations

| ID  | Threat                                                             | Mitigation                                                                                                    |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A1  | Credential or path leakage in audience/export labels               | Privacy-safe label/text filters at contract decode and receipt note sanitize                                  |
| A2  | Revoked share remains usable via malformed active+revokedAt record | Lifecycle variants require `revokedAt` only for `status: "revoked"`                                           |
| A3  | Wrong document bound under authorized envelope                     | Snapshot record filter binds export/canvas/version/sequence/host/project/source manifest to embedded document |
| A4  | Access log records wrong denial reason                             | Policy maps access evaluation denial codes to exact outcomes                                                  |
| A5  | Privacy-preserving logs cannot validate audience outcomes          | Authenticated `principalId` is accepted separately from optional `audienceLabel`                              |
| A6  | Later revocation invalidates historical allowed events             | Validate lifecycle at `occurredAt` vs `revokedAt`/`expiresAt`                                                 |
| A7  | Deleted source still appears allowed                               | Dedicated `denied-deleted-source` outcome independent of audience membership                                  |
| A8  | Targeted scope probing of a valid snapshot id stays invisible      | Scope-mismatched reads journal a `denied-scope-mismatch` event on the snapshot's own scope before refusing    |

## Runtime surface

The policy is owned by `CanvasShareService` (`apps/server/src/canvas/`) and
reached through `/api/canvas/share`, `/api/canvas/share-revoke`, and
`/api/canvas/share-access` on the loopback Canvas API.

- Create and revoke require the same server-owned Canvas authority as any other
  Canvas mutation, then the snapshot policy's own consent, scope, and expiry
  checks against the authoritative current version.
- Reading a snapshot is authorized by the snapshot alone — audience membership,
  expiry, and revocation evaluated at request time against the host-authenticated
  principal — and serves only the sanitized document admitted at create time.
- Every evaluated read is journaled as an access-log event before its outcome is
  returned; an access that cannot be recorded is refused rather than served
  unaudited. The raw user-agent stops at the route and is reduced to a coarse
  browser family. A request that names a Canvas, host, or Project the snapshot
  was never shared from is journaled as `denied-scope-mismatch` against the
  snapshot's own scope — the owner sees the probe, and the caller still receives
  the same scope-free refusal, learning nothing about the share it guessed at.
- A host that restarts with sharing disabled still holds the snapshots it minted.
  A read that names one of them is journaled as `denied-sharing-disabled` before
  the refusal is returned, so turning sharing off does not blind the owner's log.
  An unknown snapshot id is journaled for nobody — a row for a guessed id would
  make the log an oracle — and both callers receive exactly the same refusal, so
  only the owner's view distinguishes them.
- Snapshot create, revoke, and access-log frames are journaled, so revocation and
  the access log are rebuilt by replay and survive restart.
- Sharing is local-only: a snapshot is served over loopback to a principal this
  host authenticates. There is no link, upload, or relay, and the UI says so.

## Residual risk

- The only principal this host can currently authenticate for a snapshot is the
  local user, so an owner-visible audience is in practice this device. Paired
  devices are already accepted by the contract and policy; publishing them as
  selectable audience members waits on device pairing.
- Static export (`canvas-share-static-export-v1`) has no runtime owner: it
  produces an irrevocable offline copy, which the revocable snapshot surface
  deliberately does not ship.
- Browser UX packaging and native Electron presentation remain outside this
  slice.
