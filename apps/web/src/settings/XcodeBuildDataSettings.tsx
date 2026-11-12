import type { DiskCleanupClient } from "@octant/client-runtime/disk-cleanup-client";
import type { XcodeBuildData, XcodeBuildDataList } from "@octant/contracts/disk-cleanup";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../environment/threadMove/threadMoveSize";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantFieldError } from "../ui/base/OctantField";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface XcodeBuildDataSettingsProps {
  readonly client: DiskCleanupClient | undefined;
  readonly focusedSetting?: string | undefined;
}

export const XCODE_BUILD_DATA_FACT =
  "Build folders in Xcode's DerivedData whose project is gone, or that Xcode has not opened for 30 days. Xcode rebuilds them if a project needs them again.";

function size(entry: XcodeBuildData): string | undefined {
  if (entry.sizeBytes === undefined) return undefined;
  return entry.sizeComplete === false
    ? `more than ${formatBytes(entry.sizeBytes)}`
    : formatBytes(entry.sizeBytes);
}

/**
 * Settings › Code › Xcode build data, on a Mac only: elsewhere the host has no
 * DerivedData and the section is left out. Remove asks first, and the host
 * reads each folder again and keeps one Xcode has opened since.
 */
export function XcodeBuildDataSettings(props: XcodeBuildDataSettingsProps) {
  const { client } = props;
  const [list, setList] = useState<XcodeBuildDataList>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [confirming, setConfirming] = useState<ReadonlyArray<XcodeBuildData>>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setList(await client.xcodeBuildData());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(entries: ReadonlyArray<XcodeBuildData>) {
    if (client === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await client.removeXcodeBuildData(entries.map((entry) => entry.name));
      if (result.kept.length > 0) {
        setMessage(
          `${String(result.kept.length)} kept because Xcode opened them again or they are gone.`,
        );
      }
      await load();
    } catch {
      setMessage("Xcode build data could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  if (client === undefined || (list !== undefined && !list.available)) return null;
  const orphaned = list?.entries.filter((entry) => entry.state === "orphaned") ?? [];
  const total = list?.entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0) ?? 0;

  const body =
    list === undefined ? (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Xcode build data could not be read from this host."
          : "Reading Xcode build data…"}
      </SettingsState>
    ) : list.entries.length === 0 ? (
      <SettingsState kind="empty">No Xcode build data to clean up.</SettingsState>
    ) : (
      <>
        <div className="setgroup">
          <SettingRow
            description={`${String(list.entries.length)} build folders, ${formatBytes(total)} or more.`}
            focused={props.focusedSetting === "xcode-build-data"}
            label="Unused build folders"
            scope="host"
            settingId="xcode-build-data"
          >
            {orphaned.length === 0 ? null : (
              <OctantButton
                disabled={busy}
                onClick={() => setConfirming(orphaned)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Remove {String(orphaned.length)} whose project is gone
              </OctantButton>
            )}
          </SettingRow>
          {list.entries.map((entry) => (
            <SettingRow
              description={
                <>
                  {[
                    entry.state === "orphaned"
                      ? "Project folder is gone"
                      : entry.lastAccessedAt === undefined
                        ? "Not opened for 30 days"
                        : `Not opened since ${new Date(entry.lastAccessedAt).toLocaleDateString()}`,
                    size(entry),
                  ]
                    .filter((part) => part !== undefined)
                    .join(" · ")}
                  {entry.workspacePath === undefined ? null : (
                    <>
                      <br />
                      <span className="archived-worktrees__mono">{entry.workspacePath}</span>
                    </>
                  )}
                </>
              }
              key={entry.name}
              label={entry.name}
              scope="host"
              settingId="xcode-build-data"
            >
              <OctantButton
                disabled={busy}
                onClick={() => setConfirming([entry])}
                size="sm"
                type="button"
                variant="secondary"
              >
                Remove
              </OctantButton>
            </SettingRow>
          ))}
        </div>
        <div className="settings-feedback-slot" aria-live="polite">
          {message === undefined ? null : (
            <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
          )}
        </div>
      </>
    );

  return (
    <SettingsSection description={XCODE_BUILD_DATA_FACT} title="Xcode builds">
      {body}
      {confirming === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Remove build data"
          destructive
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            const entries = confirming;
            setConfirming(undefined);
            void remove(entries);
          }}
          pending={busy}
          title={
            confirming.length === 1
              ? "Remove this Xcode build folder?"
              : `Remove ${String(confirming.length)} Xcode build folders?`
          }
        >
          Deletes the build products, indexes and logs Xcode kept for{" "}
          {confirming.length === 1 ? "this project" : "these projects"}. Xcode builds them again if
          a project is opened.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
