import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import { SettingRow, SettingsSection } from "../settings/primitives";
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
    <div className="min-w-0">
      <SettingsSection title="Diagnostics">
        <div className="setgroup">
          <SettingRow
            description="Saves a file about this computer for you to read and send yourself; nothing is uploaded."
            more="It lists versions, provider status, recent log lines, and activity names, never messages or keys."
            label="Save diagnostics"
            scope="host"
            settingId="save-diagnostics"
          >
            <SupportBundleControl client={props.client} />
          </SettingRow>
          <SettingRow
            description="Saves a redacted report about one failed action, found by the ID shown with the error."
            more="Check it before sharing."
            label="Failure report"
            scope="host"
            settingId="export-diagnostics"
          >
            <DiagnosticsExportControl client={props.client} />
          </SettingRow>
          <SettingRow
            description="Events per kind over the last 14 days, counts only."
            more="Read when this section opens."
            label="Journal growth"
            scope="host"
            settingId="journal-growth"
          >
            <JournalGrowthTable client={props.client} />
          </SettingRow>
        </div>
      </SettingsSection>
    </div>
  );
}
