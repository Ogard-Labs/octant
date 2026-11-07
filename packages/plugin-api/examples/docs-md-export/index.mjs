/**
 * Example Canvas export destination plugin: share a Canvas as a page on an
 * external REST host (docs-md, BrewPage, or any service with a
 * POST-a-document-get-a-link API).
 *
 * This file implements only the published port from `@octant/plugin-api/canvas-export`
 * (`CanvasExportTarget`): it declares a contribution, describes the destination
 * on the approval card, and is called by the host only after the person approves
 * the rendered payload. It reaches no host internals.
 *
 * The host renders the Canvas (markdown/html/share-document), applies the share
 * filter, and journals the completed export; the plugin only ships what it was
 * given and returns a receipt or a typed refusal.
 */

/** docs-md-style API. Confirm the provider's current API before shipping. */
export const DEFAULT_API_BASE = "https://docs-md.com/api/v1";

/**
 * Build a `CanvasExportTarget` for an HTTP page host.
 *
 * config.apiBase  — the host's API root (see DEFAULT_API_BASE).
 * config.apiKey   — the person's own key for the host. In a production plugin,
 *                   take this through the host credential broker and the
 *                   `x-octant-credential-ref` header instead of reading env.
 * config.targetId / label — how the destination is named in the export panel.
 */
export function createPageHostExportTarget(config) {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const targetId = config.targetId ?? "example-page-host";
  const label = config.label ?? "Page host (example)";
  const formats = config.formats ?? ["markdown"];
  const note =
    config.note ??
    "Unlisted page on the external host: anyone with the link can open it, and the host can read it. Nothing is sent until you approve the card.";

  return {
    /** What the host offers. Declared formats are rendered by the host. */
    contribution: {
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId,
      label,
      formats,
    },

    /** Shown on the approval card, synchronously, so the person approves this. */
    describeDestination() {
      return { note };
    },

    /**
     * Called only after approval. `output.body` is the rendered document in
     * `output.format`; `confirmed` is the destination the card named.
     */
    async exportDocument(output, _confirmed) {
      const refuse = (code, message) => ({ kind: "refused", code, message });
      if (!formats.includes(output.format)) {
        return refuse("unsupported-format", `This destination accepts ${formats.join(", ")} only.`);
      }
      if (output.body.length === 0) {
        return refuse("malformed", "The rendered document is empty.");
      }
      let response;
      try {
        response = await fetch(`${apiBase}/pages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
          },
          body: JSON.stringify({
            title: output.title,
            format: output.format,
            body: output.body,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return refuse("unavailable", "The page host could not be reached.");
      }
      if (response.status === 201 || response.status === 200) {
        const page = await response.json();
        return {
          kind: "receipt",
          receipt: { kind: "link", href: page.url, remoteId: page.id },
        };
      }
      if (response.status === 401 || response.status === 403) {
        return refuse("unauthorized", "The page host refused the API key.");
      }
      if (response.status === 413) {
        return refuse("too-large", "The page host rejected the document as too large.");
      }
      if (response.status === 429) {
        return refuse("unavailable", "The page host is rate limiting; try again later.");
      }
      return refuse("refused", `The page host answered ${String(response.status)}.`);
    },
  };
}

/** The plugin entry: a host loads this export and offers it through the seam. */
export const canvasExport = createPageHostExportTarget({
  targetId: "docs-md-example",
  label: "docs-md (example)",
  formats: ["markdown", "html"],
  apiBase: process.env.DOCS_MD_API_BASE,
  apiKey: process.env.DOCS_MD_API_KEY,
});
