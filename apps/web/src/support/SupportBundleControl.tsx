import { useId, useState } from "react";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { SupportBundleFile, SupportBundlePreview } from "@octant/contracts";
import { buildSupportBundleZip, supportBundleEntriesLabel } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsState } from "../settings/primitives";
import type { SupportBundleSaveResult } from "../shell/hostBridge";

/**
 * Save diagnostics: a file about this host that the person reads and sends
 * themselves. Choosing the button lists what a bundle holds and never holds
 * and saves nothing; only Save file asks the host to build it. The desktop app
 * opens its native save dialog and the host writes the file where the person
 * chose, journaling only that the person chose it. A browser or a paired device
 * cannot see where a download lands, so the host is told only that it went to a
 * browser download. Nothing is uploaded.
 */

type BundleState =
  | { readonly kind: "idle" }
  | { readonly kind: "listing" }
  | { readonly kind: "review"; readonly preview: SupportBundlePreview }
  | { readonly kind: "saving"; readonly preview: SupportBundlePreview }
  | { readonly kind: "saved"; readonly fileName: string }
  | { readonly kind: "error"; readonly message: string };

export function SupportBundleControl({
  client,
  saveNatively,
}: {
  readonly client: DiagnosticsExportClient;
  /** The desktop app's native save dialog; absent in a browser, which downloads. */
  readonly saveNatively?: () => Promise<SupportBundleSaveResult>;
}) {
  const [state, setState] = useState<BundleState>({ kind: "idle" });
  const headingId = useId();

  const review = async () => {
    setState({ kind: "listing" });
    try {
      setState({ kind: "review", preview: await client.readSupportBundlePreview() });
    } catch {
      setState({ kind: "error", message: "The host could not list what a bundle holds." });
    }
  };

  const save = async (preview: SupportBundlePreview) => {
    setState({ kind: "saving", preview });
    if (saveNatively !== undefined) {
      try {
        const saved = await saveNatively();
        setState(
          saved.kind === "cancelled"
            ? { kind: "review", preview }
            : { kind: "saved", fileName: saved.fileName },
        );
      } catch (error) {
        setState({
          kind: "error",
          message:
            error instanceof Error && error.message.startsWith("Octant could not save")
              ? error.message
              : "The file could not be saved. Nothing was written.",
        });
      }
      return;
    }
    try {
      const outcome = await client.exportSupportBundle({ destinationCategory: "browser-download" });
      if (outcome.kind === "failed") {
        setState({ kind: "error", message: outcome.message });
        return;
      }
      const fileName = `octant-diagnostics-${outcome.receipt.exportedAt
        .slice(0, 19)
        .replace(/[-:]/g, "")
        .replace("T", "-")}.zip`;
      if (!downloadZip(fileName, outcome.files, new Date(outcome.receipt.exportedAt))) {
        setState({ kind: "error", message: "The file could not be saved. Nothing was written." });
        return;
      }
      setState({ kind: "saved", fileName });
    } catch {
      setState({
        kind: "error",
        message: "The host could not build the bundle. Nothing was saved.",
      });
    }
  };

  const open = state.kind === "review" || state.kind === "saving";
  return (
    <div className="support-bundle">
      <div className="support-bundle__actions">
        <OctantButton
          className="settings-view__action"
          disabled={state.kind === "listing" || open}
          onClick={() => {
            void review();
          }}
          type="button"
          variant="secondary"
        >
          {state.kind === "listing" ? "Reading…" : "Save diagnostics…"}
        </OctantButton>
      </div>
      {open ? (
        <section aria-labelledby={headingId} className="support-bundle__review">
          <p className="support-bundle__heading" id={headingId}>
            This file will include
          </p>
          <ul className="support-bundle__list">
            {state.preview.sections.map((section) => (
              <li className="support-bundle__item" key={section.id}>
                <span className="support-bundle__name">{section.title}</span>
                <span className="support-bundle__count">
                  {section.available ? supportBundleEntriesLabel(section.entries) : "Not available"}
                </span>
                <span className="support-bundle__what">{section.includes}</span>
              </li>
            ))}
          </ul>
          <p className="support-bundle__heading">It never includes</p>
          <ul className="support-bundle__list support-bundle__list--plain">
            {state.preview.neverIncluded.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="support-bundle__actions">
            <OctantButton
              disabled={state.kind === "saving"}
              onClick={() => {
                void save(state.preview);
              }}
              type="button"
              variant="secondary"
            >
              {state.kind === "saving" ? "Saving…" : "Save file"}
            </OctantButton>
            <OctantButton
              disabled={state.kind === "saving"}
              onClick={() => setState({ kind: "idle" })}
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
          </div>
        </section>
      ) : null}
      {state.kind === "saved" ? (
        <SettingsState kind="success">
          Saved {state.fileName}. Read it before you share it. Nothing was sent.
        </SettingsState>
      ) : null}
      {state.kind === "error" ? <SettingsState kind="error">{state.message}</SettingsState> : null}
    </div>
  );
}

function downloadZip(
  fileName: string,
  files: ReadonlyArray<SupportBundleFile>,
  modifiedAt: Date,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const bytes = buildSupportBundleZip(files, modifiedAt);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}
