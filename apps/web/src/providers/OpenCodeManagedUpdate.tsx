import { useEffect, useRef, useState } from "react";
import {
  decodeManagedToolsStatus,
  type ManagedToolStatus,
  type ManagedToolsStatus,
} from "@octant/contracts/managed-tooling";
import type { ProviderInstanceId } from "@octant/contracts";
import { getInjectedHostBridge, type OctantHostBridge } from "../shell/hostBridge";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";

type ManagedToolsBridge = Pick<
  OctantHostBridge,
  "getManagedToolsStatus" | "checkManagedToolUpdates"
>;

export interface OpenCodeManagedInstance {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly binaryPath: string;
}

function usesManagedCopy(binaryPath: string, tool: ManagedToolStatus): boolean {
  if (tool.executablePath !== undefined && binaryPath === tool.executablePath) return true;
  const root = tool.managedDirectory;
  if (root === undefined || root === "") return false;
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return binaryPath === normalized || binaryPath.startsWith(`${normalized}/`);
}

export function OpenCodeManagedUpdate(props: {
  readonly bridge?: ManagedToolsBridge;
  readonly instances: ReadonlyArray<OpenCodeManagedInstance>;
  readonly onChangeBinary: (instanceId: ProviderInstanceId, binaryPath: string) => Promise<boolean>;
}) {
  const bridge = props.bridge ?? getInjectedHostBridge();
  const [status, setStatus] = useState<ManagedToolsStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const read = async () => {
      if (!active) return;
      if (bridge?.getManagedToolsStatus === undefined) {
        setError("OpenCode updates require the Octant desktop app.");
        return;
      }
      const request = ++revision.current;
      try {
        const next = decodeManagedToolsStatus(await bridge.getManagedToolsStatus());
        if (active && request === revision.current) {
          setStatus(next);
          setError(undefined);
        }
      } catch {
        if (active && request === revision.current)
          setError("OpenCode update status is unavailable.");
      }
    };
    void read();
    return () => {
      active = false;
      mounted.current = false;
      revision.current += 1;
    };
  }, [bridge]);

  const tool = status?.tools.find((entry) => entry.tool === "opencode");
  const installed =
    tool === undefined || !tool.available || tool.version === "0.0.0"
      ? "Not installed"
      : tool.version;
  const available =
    tool?.availableVersion ?? (tool?.update === "current" ? tool.version : undefined);
  const updateFailure =
    tool?.update === "failed" ? (tool.message ?? "The OpenCode update failed.") : undefined;
  const outside = (tool === undefined ? [] : props.instances).filter(
    (instance) => tool !== undefined && !usesManagedCopy(instance.binaryPath, tool),
  );

  async function update() {
    const check = bridge?.checkManagedToolUpdates;
    if (check === undefined || busy) return;
    setBusy(true);
    const request = ++revision.current;
    try {
      const next = decodeManagedToolsStatus(await check("opencode"));
      if (mounted.current && request === revision.current) {
        setStatus(next);
        const updated = next.tools.find((entry) => entry.tool === "opencode");
        setError(updated?.update === "failed" ? updated.message : undefined);
      }
    } catch {
      if (mounted.current) setError("OpenCode update could not be completed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section aria-label="OpenCode update" id="opencode-managed-update">
      <SettingsSection
        title="OpenCode"
        description="Octant can install and update its own OpenCode copy. That never replaces an OpenCode you installed somewhere else."
      >
        <div className="setgroup">
          <SettingRow
            settingId="opencode-managed-update"
            label="Installed version"
            description="The copy in Octant's managed location, not a binary found on your PATH."
            scope="host"
          >
            <span>{status === undefined && error === undefined ? "Checking…" : installed}</span>
          </SettingRow>
          <SettingRow
            settingId="opencode-managed-available"
            label="Available version"
            description="The latest release on the managed tool channel."
            scope="host"
          >
            <span>{available ?? "Not checked yet"}</span>
          </SettingRow>
          <SettingRow
            settingId="opencode-managed-update-action"
            label="Update"
            description="Downloads a verified release into Octant's managed location and keeps the previous copy if it does not start."
            scope="host"
          >
            <OctantButton
              type="button"
              size="sm"
              variant="secondary"
              disabled={
                busy || bridge?.checkManagedToolUpdates === undefined || status?.supported === false
              }
              onClick={() => void update()}
            >
              {busy ? "Updating…" : "Update"}
            </OctantButton>
          </SettingRow>
          {outside.map((instance) => {
            const agreed = consented.has(String(instance.id));
            const managedPath = tool?.executablePath;
            return (
              <SettingRow
                key={String(instance.id)}
                settingId={`opencode-managed-consent-${String(instance.id)}`}
                label={`Use Octant's copy for ${instance.displayName}`}
                description="This switches the provider to Octant's copy. It does not replace the OpenCode you installed elsewhere."
                scope="host"
              >
                <label className="settings-view__actions">
                  <OctantCheckbox
                    aria-label={`Consent to use Octant's OpenCode for ${instance.displayName}`}
                    checked={agreed}
                    disabled={managedPath === undefined || busy}
                    onChange={(event) => {
                      const next = new Set(consented);
                      if (event.currentTarget.checked) next.add(String(instance.id));
                      else next.delete(String(instance.id));
                      setConsented(next);
                    }}
                  />
                  <OctantButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!agreed || managedPath === undefined || busy}
                    onClick={() => {
                      if (managedPath === undefined) return;
                      void props.onChangeBinary(instance.id, managedPath);
                    }}
                  >
                    Use Octant's copy
                  </OctantButton>
                </label>
              </SettingRow>
            );
          })}
        </div>
      </SettingsSection>
      <p
        className="provider-settings__field-guidance"
        role={updateFailure === undefined ? "status" : "alert"}
      >
        {updateFailure ??
          error ??
          "An update writes only inside Octant's managed location. Agreeing to use that copy does not replace any other OpenCode install."}
      </p>
    </section>
  );
}
