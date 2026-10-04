import { useState } from "react";
import type { HostExportClientResult } from "@octant/client-runtime/host-control-client";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsPanel, SettingsState } from "../settings/primitives";

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "saved" }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

const REFUSAL: Record<Extract<HostExportClientResult, { kind: "refused" }>["reason"], string> = {
  "local-owner-only": "Only the person at this computer can export this host's data.",
  unrepresentable:
    "The export was refused because it would have included something that cannot be represented.",
  incomplete: "The export stopped before every page was written. Nothing was saved.",
};

/**
 * Saves the host-export bundle the server already assembles. The web app
 * downloads the file. A native save dialog is not wired yet.
 */
export function HostPrivacyExport({
  exportHost,
}: {
  readonly exportHost: () => Promise<HostExportClientResult>;
}) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  const run = () => {
    setState({ kind: "pending" });
    void exportHost()
      .then((result) => {
        if (result.kind === "refused") {
          setState({ kind: "refused", text: REFUSAL[result.reason] });
          return;
        }
        const blob = new Blob([JSON.stringify(result.bundle, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "octant-host-export.json";
        link.click();
        URL.revokeObjectURL(url);
        setState({ kind: "saved" });
      })
      .catch(() => {
        setState({
          kind: "error",
          text: "The export could not be completed. Nothing was saved.",
        });
      });
  };

  return (
    <SettingsPanel
      title="Export my data"
      description="Save everything this host holds about you, as a file you can read."
    >
      <div className="settings-panel__stack" id="settings-host-export">
        <div className="host-settings__controls">
          <OctantButton
            disabled={state.kind === "pending"}
            onClick={run}
            type="button"
            variant="secondary"
          >
            {state.kind === "pending" ? "Exporting…" : "Export my data"}
          </OctantButton>
        </div>
        {state.kind === "saved" ? (
          <SettingsState kind="success">Saved octant-host-export.json.</SettingsState>
        ) : null}
        {state.kind === "refused" || state.kind === "error" ? (
          <SettingsState kind="error">{state.text}</SettingsState>
        ) : null}
      </div>
    </SettingsPanel>
  );
}
