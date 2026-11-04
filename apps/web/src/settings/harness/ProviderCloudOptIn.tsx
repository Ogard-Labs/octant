import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInstanceId } from "@octant/contracts";
import type { ProviderCloudProfile } from "@octant/contracts/provider-cloud-sessions";
import type { ProviderCloudSessionClient } from "@octant/client-runtime/provider-cloud-session-client";
import { OctantSwitch } from "../../ui/base/OctantSwitch";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { SettingRow, SettingsSection } from "../primitives";

export function ProviderCloudOptIn(props: {
  readonly client: ProviderCloudSessionClient;
  readonly instanceId: ProviderInstanceId;
}) {
  const [profile, setProfile] = useState<typeof ProviderCloudProfile.Type>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const context = useMemo(
    () => ({ client: props.client, id: props.instanceId }),
    [props.client, props.instanceId],
  );
  const active = useRef(context);
  active.current = context;
  useEffect(() => {
    const abort = new AbortController();
    setProfile(undefined);
    setBusy(true);
    setMessage("");
    void context.client.execute({ kind: "profiles" }, abort.signal).then((result) => {
      if (abort.signal.aborted || active.current !== context) return;
      if (result.status === "ready")
        setProfile(result.profiles.find((item) => String(item.instanceId) === String(context.id)));
      else setMessage("Cloud-session settings are unavailable on this connection.");
      setBusy(false);
    });
    return () => abort.abort();
  }, [context]);
  const save = async (enabled: boolean) => {
    const owner = context;
    setBusy(true);
    setMessage("");
    const result = await owner.client.execute({ kind: "opt-in", instanceId: owner.id, enabled });
    if (active.current !== owner) return;
    if (result.status === "ready")
      setProfile(result.profiles.find((item) => String(item.instanceId) === String(owner.id)));
    else
      setMessage(
        "The change could not be confirmed. Reopen this endpoint to read its saved setting.",
      );
    setBusy(false);
  };
  return (
    <SettingsSection title="Provider cloud sessions">
      <SettingRow
        settingId="provider-cloud-sessions"
        label="Allow cloud sessions"
        scope="host"
        description="Enable this provider's remote sandbox for separately reviewed Code tasks; this does not start a task."
      >
        <OctantSwitch
          checked={profile?.enabled === true}
          disabled={busy || (profile?.supported !== true && profile?.enabled !== true)}
          disabledReason={
            busy
              ? "Reading the saved setting."
              : "This endpoint does not currently offer cloud sessions; check its connection and supported API identity."
          }
          label="Allow cloud sessions for this endpoint"
          onCheckedChange={(enabled) => void save(enabled)}
        />
      </SettingRow>
      <p className="settings-note">
        Only text you review is sent. Remote commands have no local approval callbacks or host
        tools; provider model and sandbox charges apply.
      </p>
      {message === "" ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </SettingsSection>
  );
}
