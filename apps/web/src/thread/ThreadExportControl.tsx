import type { ThreadExportClient } from "@octant/client-runtime/thread-export-client";
import { createThreadExportClient } from "@octant/client-runtime/thread-export-client";
import type { OctantMode } from "@octant/contracts/modes";
import { serializeThreadExportBundle } from "@octant/domain";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ThreadExportControlProps {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly title: string;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly client?: ThreadExportClient;
}

/**
 * The export client for a surface's props: an injected client wins, otherwise
 * one is built from the window's own server URL and capability. Shared with
 * the chat thread-actions menu so both surfaces resolve export availability
 * the same way.
 */
export function resolveThreadExportClient(input: {
  readonly client?: ThreadExportClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}): ThreadExportClient | undefined {
  if (input.client !== undefined) return input.client;
  if (input.serverUrl === undefined || input.windowCapability === undefined) return undefined;
  return createThreadExportClient({
    baseUrl: input.serverUrl,
    fetch: globalThis.fetch,
    windowCapability: input.windowCapability,
  });
}

/**
 * Asks the host for its portable cut of the thread and downloads it. Returns
 * the user-facing outcome message so any surface (button, menu item) can show
 * the same receipt.
 *
 * The file is whatever the server assembled — transcript, evidence,
 * provenance, and a stated cut time. The renderer never invents the bundle
 * from a local cache.
 */
export async function exportThreadBundle(
  client: ThreadExportClient,
  input: { readonly mode: OctantMode; readonly threadId: string; readonly title: string },
): Promise<string> {
  try {
    const outcome = await client.exportThread({ mode: input.mode, threadId: input.threadId });
    if (outcome.kind !== "exported") return "This thread could not be exported.";
    const fileName = `${exportFileSlug(input.title)}.octant-thread.json`;
    const saved = saveJson(serializeThreadExportBundle(outcome.bundle), fileName);
    return saved ? `Saved ${fileName}.` : "The thread could not be saved from this window.";
  } catch {
    return "This thread could not be exported.";
  }
}

/** Downloads the host's portable cut of this thread. */
export function ThreadExportControl(props: ThreadExportControlProps) {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const client = useMemo(
    () =>
      resolveThreadExportClient({
        ...(props.client === undefined ? {} : { client: props.client }),
        ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
        ...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability }),
      }),
    [props.client, props.serverUrl, props.windowCapability],
  );

  if (client === undefined) return null;

  return (
    <div aria-label="Export thread" className="chat-workspace__export" role="group">
      <OctantButton
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setStatus(undefined);
          void (async () => {
            try {
              setStatus(
                await exportThreadBundle(client, {
                  mode: props.mode,
                  threadId: props.threadId,
                  title: props.title,
                }),
              );
            } finally {
              setBusy(false);
            }
          })();
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Download aria-hidden="true" size={14} strokeWidth={1.7} />
        {busy ? "Exporting…" : "Export thread"}
      </OctantButton>
      {status === undefined ? null : (
        <p aria-live="polite" className="chat-workspace__export-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function saveJson(text: string, fileName: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function exportFileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length === 0 ? "octant-thread" : slug;
}
