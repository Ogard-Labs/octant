import { SettingsSetupLink } from "./SettingsSetupLink";
import type { ExternalUrlHost } from "../shell/openExternalUrl";
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
import { SettingRow, SettingsDisclosure, SettingsState } from "./primitives";

export interface PublicLinkSettingsProps {
  /** Absent where the host publishes no public link settings. */
  readonly client: Pick<CanvasClient, "publicLinkSettings" | "setPublicLinkSettings"> | undefined;
  readonly externalUrlHost?: ExternalUrlHost | undefined;
  readonly focusedSetting?: string | undefined;
}

/** The sentence the switch is described by: the service reads what is published. */
export const PUBLIC_LINK_FACT =
  "Publish a Canvas as a link anyone with it can open. The service you set stores and can read what you publish.";

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
        description="Where public links are published: a service you run or trust. Empty means no links can be published."
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
          placeholder="https://your-share-service.example"
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
      <SettingsDisclosure
        title="Set up the self-hosted Canvas share service"
        variant="inline"
        settingId="public-link-setup"
        focused={props.focusedSetting === "public-link-setup"}
      >
        <ol className="remote-setup__steps">
          <li>
            On a server with Docker Compose, check out the{" "}
            <SettingsSetupLink
              host={props.externalUrlHost}
              href="https://github.com/Ogard-Labs/octant"
            >
              Octant repository
            </SettingsSetupLink>
            . Point two DNS names at the server, one for shared pages and one for embedded content.
            Allow incoming TCP connections on ports 80 and 443 and leave those ports free for the
            HTTPS proxy.
          </li>
          <li>
            From the repository root, run these commands in a shell. Replace the example names with
            your own. Compose starts the share service and Caddy, provisions HTTPS, and keeps
            published pages and certificates in Docker volumes.
            <pre className="settings-setup-command">
              <code>{`export SHARE_DOMAIN=share.example.com
export CONTENT_DOMAIN=content.example.com
docker compose -f apps/share/compose.yaml up -d --build`}</code>
            </pre>
          </li>
          <li>
            Open <code>https://share.example.com/healthz</code> using your viewer domain and check
            for <code>ok</code>. Enter that viewer origin without the path in Service address, save
            it, then turn on Public links.
          </li>
          <li>
            Publish a test Canvas with a design block and open its link in a browser. If the page
            opens but the design is missing, check DNS and HTTPS for the content domain.
          </li>
        </ol>
      </SettingsDisclosure>
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </>
  );
}
