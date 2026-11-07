---
description: How a third-party plugin adds a Canvas export destination through the published CanvasExportTarget seam — contribution, approval card, receipt or typed refusal.
---

# Build an export destination plugin

A Canvas export destination is a plugin that implements one published port:
`CanvasExportTarget` from `@octant/plugin-api/canvas-export`. The host owns
rendering, the share filter, the approval card, and the journal; the plugin is
called only after the person approves the exact payload and the destination, and
returns a receipt or a typed refusal. Nothing about the seam reaches host
internals — the in-tree destinations (folder, GitHub Gist, sharehtml.org, public
link) use this same port.

A complete, runnable example lives at
[`packages/plugin-api/examples/docs-md-export`](https://github.com/Ogard-Labs/octant/tree/main/packages/plugin-api/examples/docs-md-export)
(share a Canvas as an unlisted page on an external REST host).

## The contract

```ts
interface CanvasExportTarget {
  readonly contribution: CanvasExportContribution;
  readonly describeDestination?: (output) => CanvasExportDestination | undefined;
  readonly exportDocument: (output, confirmed?) => Promise<CanvasExportDelivery>;
}
```

1. **`contribution`** — `targetId`, `label`, and `formats` the destination accepts
   (`markdown`, `html`, `share-document` are rendered by the host; `png`/`pdf`
   are drawn in the host's browser and reach only a target that declared them).
   The host offers the destination only when the package is installed, trusted,
   enabled, and effective — installation never implies trust.
2. **`describeDestination(output)`** — synchronous, called while the approval
   card is built. Return the `note` the card shows (who can read the result, what
   the service can read), and for an account-based destination the `account` and
   `visibility` (`secret` = unlisted, `public` = visible to anyone). Every string
   is shown verbatim and must be bounded and free of paths and secrets.
3. **`exportDocument(output, confirmed)`** — called only after approval.
   `output.body` is the rendered document in `output.format`; `output.title` names
   it. Return `{ kind: "receipt", receipt: { kind: "link", href, remoteId } }` (or
   `kind: "path"` for a local write) or `{ kind: "refused", code, message }`.
   Refusal codes: `approval-required`, `not-offered`, `not-connected`, `refused`,
   `unsupported-format`, `malformed`, `too-large`, `unauthorized`, `unavailable`,
   `expired`.

Before the payload reaches the plugin it has passed the share filter every
export goes through: no absolute file paths, no secret-shaped values, no
credential-bearing URLs. A plugin that still sees one must refuse, never ship it.

## Credentials

Take API keys through the host credential broker, not the plugin's environment:
name the credential reference and let the host attach it with the
`x-octant-credential-ref` header (see `@octant/plugin-api/integration`). The raw
key never enters the plugin process.

## Status reporting

While the offer list is built the host reads activation facts for the
destination: `not-connected`, `ready`, or `refused` (with a standing refusal
reason, e.g. an insecure credential store). Report honestly — a destination that
cannot act must say so rather than fail at export time.

## Journal and recovery

Every completed export is a `canvas.export@1` journal event, rebuilt by replay.
If the destination was called but the journal could not take the record, the host
answers `unrecorded` with the destination's outcome — never a silent failure.

## Related

- [Export a Canvas or artifact](/guide/export)
- [Plugins and Skills](/advanced/plugins-and-skills)
- [Build a Provider Driver](/advanced/provider-drivers)
