# Example: a Canvas export destination plugin (docs-md-style page host)

A minimal third-party export destination for Octant Canvases, implemented **only**
through the published port `@octant/plugin-api/canvas-export`
(`CanvasExportTarget`). It shares a Canvas as an unlisted page on an external
REST host (docs-md, BrewPage, or any service with a post-a-document-get-a-link
API). The in-tree `sharehtml.org` destination
(`apps/server/src/canvas/sharehtmlExportTarget.ts`) is the same pattern with a
concrete service.

## What the plugin does

- `contribution` — declares `targetId`, `label`, and the `formats` it accepts
  (`markdown`, `html`, `share-document`; the host renders them).
- `describeDestination(output)` — synchronous; returns the note the approval
  card shows (audience, who can read it). A remote destination may also name the
  account (`account`) and audience (`visibility`).
- `exportDocument(output, confirmed)` — called **only after the person approves
  the card** that showed the exact rendered payload and this destination. Returns
  a receipt (`{ kind: "link", href, remoteId }`) or a typed refusal
  (`{ kind: "refused", code, message }`; codes: `approval-required`,
  `not-offered`, `not-connected`, `refused`, `unsupported-format`, `malformed`,
  `too-large`, `unauthorized`, `unavailable`, `expired`).

The host owns rendering, the share filter (no paths, no secret-shaped values
leave), the approval card, and the `canvas.export@1` journal event. The plugin
receives an opaque credential reference and a host-authorized fetch port, never
a key. It never decides when it is called.

## Activation ladder

A destination is offered only when its package is **installed → trusted →
enabled → effective** (`admitCanvasExportContribution` in
`@octant/plugin-host/canvas-export-contributions`). Installation never implies
trust; a disabled or uninstalled target is omitted from the offer list, and a
connected-but-refusing target reports `refused` honestly.

## Files

- `index.mjs` — `createPageHostExportTarget(config)` factory + the `canvasExport`
  entry a host loads from the plugin package.
- `index.test.mjs` — vitest, so it runs with the package suite:
  `bun run --filter @octant/plugin-api test` (12 tests in this file).
- `apps/server/src/canvas/canvasExportService.test.ts` — the host registers this
  actual factory through the production export service, checks each activation
  gate, denies one card, approves the exact rendered payload, replays its
  journaled receipt, and refuses a held card after the target is disabled.

## Credentials

The host supplies `fetch` from `IntegrationHostPort` and the opaque
`credentialRef` it authorized for this destination. The request carries
`x-octant-credential-ref`; the host port validates the destination and attaches
the credential, so the plugin never receives the raw key. Without that port, a
credential reference is refused before any request. Anonymous hosts can omit
both. The example's default export has no credential and reads only an optional
`DOCS_MD_API_BASE` address from the environment.

## Host registration

This example is a callable `CanvasExportTarget` factory for a host to register,
as the in-tree destinations are registered. The host owns package resolution and
the installed/trusted/enabled/effective facts; the factory cannot supply those
facts or approve itself. There is no Settings installer for arbitrary JavaScript
export modules, and this example is not a claim that selecting its folder loads
code into the server. The integration test proves the supported host
registration and approval path without importing untrusted code into the
authority process.

A refused or unreadable response after upload does not prove the remote host
created nothing. The example does not retry uploads automatically.
