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
never sees credentials unless the person gave it one, and never decides when it
is called.

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
  `bun run --filter @octant/plugin-api test` (6 tests in this file).

## Credentials

The example reads `DOCS_MD_API_KEY` from the environment for simplicity. A
production plugin should take its key through the host credential broker and let
the host attach it via the `x-octant-credential-ref` header (see
`@octant/plugin-api/integration`), so the raw key never sits in the plugin's
environment.

## Manifest note

The `canvas-export-target` manifest component kind (so a host knows to load the
`canvasExport` export from the plugin entry) is the remaining host-side wiring;
until it lands, this example documents the port contract. Tracked in OCT-810.
