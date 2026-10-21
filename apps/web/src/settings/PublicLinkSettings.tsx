import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import {
  decodeCanvasPublicLinkSettingsCommand,
  type CanvasPublicLinkSettings,
  type CanvasPublicLinkSettingsResult,
} from "@octant/contracts/canvas-public-share";
import { useCallback, useEffect, useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsState } from "./primitives";

export interface PublicLinkSettingsProps {
  /** Absent where the host publishes no public link settings. */
  readonly client: Pick<CanvasClient, "publicLinkSettings" | "setPublicLinkSettings"> | undefined;
  readonly focusedSetting?: string | undefined;
}

/** The sentence the switch is described by: the service reads what is published. */
export const PUBLIC_LINK_FACT =
  "Publish a Canvas as a link anyone with it can open. The service stores and can read what you publish.";

/**
 * Settings: the switch that lets a Canvas be published as a public link, and
 * the service it is published to. Both are saved together from the version
 * the person read, so a change made in another window is refused rather than
 * overwritten.
 */
export function PublicLinkSettings(props: PublicLinkSettingsProps) {
  const { client } = props;
  const urlId = useId();
  const [settings, setSettings] = useState<CanvasPublicLinkSettings | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [serviceUrl, setServiceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    const read = client?.publicLinkSettings;
    if (read === undefined) return;
    try {
      const next = await read();
      setSettings(next);
      setServiceUrl(next.serviceUrl);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(enabled: boolean, nextServiceUrl: string) {
    const write = client?.setPublicLinkSettings;
    if (write === undefined || settings === undefined) return;
    setProblem(undefined);
    let command;
    try {
      command = decodeCanvasPublicLinkSettingsCommand({
        schemaVersion: 1,
        kind: "set-canvas-public-link-settings",
        enabled,
        serviceUrl: nextServiceUrl.trim(),
        expectedVersion: settings.version,
      });
    } catch {
      setProblem(
        "The service address must be an https address, or http on this computer's loopback address, with no password or fragment.",
      );
      return;
    }
    setBusy(true);
    let result: CanvasPublicLinkSettingsResult;
    try {
      result = await write(command);
    } catch {
      setProblem("Public link settings could not be saved.");
      return;
    } finally {
      setBusy(false);
    }
    if (result.kind === "canvas-public-link-settings") {
      setSettings(result.settings);
      setServiceUrl(result.settings.serviceUrl);
      return;
    }
    setProblem(result.message);
    // A stale version means another window moved the settings on.
    if (result.reason === "stale-version") await load();
  }

  if (client?.publicLinkSettings === undefined || client.setPublicLinkSettings === undefined) {
    return <SettingsState kind="empty">Public links are set up on the host machine.</SettingsState>;
  }
  if (settings === undefined) {
    return (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Public link settings could not be read from this host."
          : "Reading public link settings…"}
      </SettingsState>
    );
  }
  const changedUrl = serviceUrl.trim() !== settings.serviceUrl;
  return (
    <>
      <SettingRow
        description={PUBLIC_LINK_FACT}
        focused={props.focusedSetting === "public-links"}
        label="Public links"
        scope="host"
        settingId="public-links"
      >
        <OctantSwitch
          checked={settings.enabled}
          describedBy="public-links-description"
          disabled={busy}
          label="Public links"
          onCheckedChange={(enabled) => void save(enabled, settings.serviceUrl)}
        />
      </SettingRow>
      <SettingRow
        description="Where public links are published. Change it to use a service you run."
        focused={props.focusedSetting === "public-link-service"}
        htmlFor={urlId}
        label="Service address"
        scope="host"
        settingId="public-link-service"
      >
        <OctantInput
          disabled={busy}
          id={urlId}
          onChange={(event) => setServiceUrl(event.target.value)}
          type="url"
          value={serviceUrl}
        />
        <OctantButton
          disabled={busy || !changedUrl}
          onClick={() => void save(settings.enabled, serviceUrl)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Save address
        </OctantButton>
      </SettingRow>
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </>
  );
}
