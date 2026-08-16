# Canvas static export threat model

- Date: 2026-08-04
- Threat model id: `canvas-share-static-export-v1`
- Scope: optional offline static export only

## Assets

- Canvas title and first-party blocks
- Redacted provenance labels
- Opaque source references
- Explicit operator consent receipt

## Explicit non-goals

- Authenticated browser snapshots
- Access-log privacy QA
- Public/anonymous links
- Live host credentials, Keychain material, or cross-host authority

## Threats and mitigations

| ID  | Threat                                | Mitigation                                                        |
| --- | ------------------------------------- | ----------------------------------------------------------------- |
| T1  | Credential leakage in export payload  | Dual consent + secret key/value sanitization                      |
| T2  | Path or root disclosure               | Export opaque references only; strip live source ids from blocks  |
| T3  | Silent export without operator intent | Require offline-snapshot and no-credential acknowledgements       |
| T4  | Stale or cross-project export         | Bind canvas, version, sequence, host, and Project                 |
| T5  | Sharing disabled bypass               | Fail closed when sharing is disabled; local Canvas remains usable |

## Residual risk

Authenticated snapshot audience, expiry, revocation, and access-log privacy remain out of scope for this export path.
