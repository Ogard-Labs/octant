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

A callable reference factory lives at
[`packages/plugin-api/examples/docs-md-export`](https://github.com/Ogard-Labs/octant/tree/main/packages/plugin-api/examples/docs-md-export)
(share a Canvas as an unlisted page on an external REST host).

## Host registration

The host registers the factory's `CanvasExportTarget` alongside its destinations
and supplies the installed, trusted, enabled, effective and connection facts.
Those facts are host-owned; a package cannot assert them. The production export
service applies the same activation policy and approval card to that target as
it does to folder and Gist exports. Its integration test loads the actual example,
proves each activation gate, approves one payload, replays its journaled receipt,
and refuses a held approval after disablement. Preparation and denial upload
nothing.

This is a host registration example. The current Settings installer does not
discover arbitrary JavaScript export modules; selecting this example's folder
does not load it into the server.

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

The host passes `IntegrationHostPort.fetch` as the factory's `fetch` and an
authorized opaque `credentialRef`. The example names that reference with
`x-octant-credential-ref`; the host port checks the destination and attaches the
key (see `@octant/plugin-api/integration`). The raw key never enters the plugin.
A reference without the host port is refused before network access. An anonymous
page host can omit both.

Successful responses are decoded through the public delivery schema. Invalid
JSON or link/id fields return `malformed`; an unreadable response returns
`unavailable`. Neither proves that an upload created nothing remotely. The
example never retries uploads automatically.

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
