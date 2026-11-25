import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import { DiagnosticsExportControl } from "../support/DiagnosticsExportControl";
import { JournalGrowthTable } from "../support/JournalGrowthTable";
import { SupportBundleControl } from "../support/SupportBundleControl";

/**
 * The diagnostics a local window's Maintenance section offers, for a browser
 * the host's own person paired at Full. The bundle comes back as JSON files
 * and this browser zips and downloads them itself, so no file travels as a
 * binary body over the session and the host is told only that it went to a
 * browser download. Loaded when the section is opened.
 */
export default function RemoteDiagnostics(props: { readonly client: DiagnosticsExportClient }) {
  return (
    <div className="flex flex-col gap-3">
      <SupportBundleControl client={props.client} />
      <DiagnosticsExportControl client={props.client} />
      <JournalGrowthTable client={props.client} />
    </div>
  );
}
