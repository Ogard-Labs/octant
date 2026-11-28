import { useCallback, useEffect, useId, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import type { HubAdministrationBridge, HubAdministrationOperation } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface PhoneNotificationSettingsProps {
  /** Local desktop host bridge for managing this computer's direct push sender. */
  readonly hub?: HubAdministrationBridge | undefined;
  readonly focusedSetting?: string | undefined;
}

/** What the switch means: this computer sends directly to Apple and Google. */
export const PHONE_NOTIFICATIONS_FACT =
  "Send checked status notifications from this computer straight to Apple and Google for paired phones.";

const PHONE_NOTIFICATIONS_MORE =
  "This computer sends notifications directly to Apple and Google using your own push credentials, with no Octant-run relay. Every label is checked against secret patterns and known host secrets before it leaves. Off by default.";

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  "invalid-credential":
    "That is not a key Apple or Google issues. Check the file and try again; nothing was stored.",
  "credential-store-unavailable": "The credential store on this computer is unavailable.",
};

interface PushSenderView {
  readonly enabled: boolean;
  readonly development: boolean;
  readonly ios: boolean;
  readonly android: boolean;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readPushSenderStatus(body: unknown): PushSenderView | undefined {
  const pushSender = field(body, "pushSender");
  const enabled = field(pushSender, "enabled");
  const environment = field(pushSender, "environment");
  const ios = field(pushSender, "ios");
  const android = field(pushSender, "android");
  if (
    typeof enabled !== "boolean" ||
    (environment !== "production" && environment !== "development") ||
    (ios !== "stored" && ios !== "not-stored") ||
    (android !== "stored" && android !== "not-stored")
  ) {
    return undefined;
  }
  return {
    enabled,
    development: environment === "development",
    ios: ios === "stored",
    android: android === "stored",
  };
}

function refusalCopy(body: unknown, fallback: string): string {
  const reason = field(body, "reason") ?? field(body, "kind");
  if (typeof reason === "string" && reason in REFUSAL_COPY) {
    return REFUSAL_COPY[reason] ?? fallback;
  }
  const detail = field(body, "error") ?? field(body, "message");
  return typeof detail === "string" && detail !== "" ? detail : fallback;
}

/**
 * Settings › General: lets any computer send phone notifications directly to
 * Apple and Google with the person's own push credentials. Present only on a
 * local desktop window; paired browsers and phones see a read-only note.
 */
export function PhoneNotificationSettings(props: PhoneNotificationSettingsProps) {
  const { hub, focusedSetting } = props;
  const [status, setStatus] = useState<PushSenderView | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [appleDraft, setAppleDraft] = useState({
    keyId: "",
    teamId: "",
    bundleId: "",
    privateKey: "",
  });
  const [googleDraft, setGoogleDraft] = useState("");
  const appleKeyIdId = useId();
  const appleTeamIdId = useId();
  const appleBundleIdId = useId();
  const applePrivateKeyId = useId();
  const googleAccountId = useId();

  const request = useCallback(
    async (operation: HubAdministrationOperation, body?: unknown) => {
      if (hub === undefined) return undefined;
      return body === undefined
        ? await hub.hubAdministrationRequest(operation)
        : await hub.hubAdministrationRequest(operation, body);
    },
    [hub],
  );

  const refresh = useCallback(async () => {
    if (hub === undefined) return;
    try {
      const reply = await request("push-sender-status");
      const next = reply?.status === 200 ? readPushSenderStatus(reply.body) : undefined;
      if (next === undefined) {
        setLoadFailed(true);
      } else {
        setStatus(next);
        setLoadFailed(false);
      }
    } catch {
      setLoadFailed(true);
    }
  }, [hub, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(
    operation: HubAdministrationOperation,
    body: unknown,
    fallback: string,
  ): Promise<boolean> {
    if (hub === undefined) return false;
    setBusy(true);
    setProblem(undefined);
    setMessage(undefined);
    try {
      const reply = await request(operation, body);
      if (
        reply !== undefined &&
        reply.status === 200 &&
        field(reply.body, "status") === "changed"
      ) {
        return true;
      }
      setProblem(refusalCopy(reply?.body, fallback));
      return false;
    } catch (error) {
      setProblem(failureMessage(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const setEnabled = async (on: boolean) => {
    const ok = await act(
      "direct-push",
      { enabled: on },
      on
        ? "Octant could not turn on phone notifications."
        : "Octant could not turn off phone notifications.",
    );
    if (ok) {
      setMessage(
        on
          ? "Phone notifications are on. This computer sends directly to Apple and Google with your own credentials."
          : "Phone notifications are off.",
      );
    }
    await refresh();
  };

  const setDevelopment = async (development: boolean) => {
    const ok = await act(
      "direct-push-environment",
      { environment: development ? "development" : "production" },
      "Octant could not change the Apple environment.",
    );
    if (ok) {
      setMessage(
        development
          ? "Apple notifications go to the development service."
          : "Apple notifications go to the production service.",
      );
    }
    await refresh();
  };

  const storeAppleKey = async () => {
    const draft = appleDraft;
    // Cleared before the answer, so the key never waits in this window's memory for a reply.
    setAppleDraft({ keyId: "", teamId: "", bundleId: "", privateKey: "" });
    const ok = await act(
      "direct-push-credential",
      {
        platform: "ios",
        keyId: draft.keyId.trim().toUpperCase(),
        teamId: draft.teamId.trim().toUpperCase(),
        bundleId: draft.bundleId.trim(),
        privateKey: draft.privateKey,
      },
      "Octant could not store the Apple key. Check the key ID, team ID and bundle ID.",
    );
    if (ok) setMessage("Apple key stored.");
    await refresh();
  };

  const storeGoogleAccount = async () => {
    const draft = googleDraft;
    setGoogleDraft("");
    const ok = await act(
      "direct-push-credential",
      { platform: "android", serviceAccount: draft },
      "Octant could not store the service account.",
    );
    if (ok) setMessage("Google service account stored.");
    await refresh();
  };

  const removeCredential = async (platform: "ios" | "android") => {
    const ok = await act(
      "direct-push-credential-remove",
      { platform },
      "Octant could not remove the credential.",
    );
    if (ok) {
      setMessage(platform === "ios" ? "Apple key removed." : "Google service account removed.");
    }
    await refresh();
  };

  if (hub === undefined) {
    return (
      <SettingsSection
        description="Thread and automation notifications for phones paired with this computer. Off until you turn it on."
        title="Phone notifications"
      >
        <p className="settings-section-line">
          Phone notifications and push credentials are set up on the host machine.
        </p>
      </SettingsSection>
    );
  }

  let body;
  if (status === undefined) {
    body = (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Phone notification settings could not be read from this host."
          : "Reading phone notification settings…"}
      </SettingsState>
    );
  } else {
    body = (
      <>
        <div className="setgroup">
          <SettingRow
            description={PHONE_NOTIFICATIONS_FACT}
            more={PHONE_NOTIFICATIONS_MORE}
            focused={focusedSetting === "host-phone-notifications"}
            label="Phone notifications"
            scope="host"
            settingId="host-phone-notifications"
          >
            <OctantSwitch
              checked={status.enabled}
              disabled={busy}
              label="Phone notifications"
              onCheckedChange={(enabled) => void setEnabled(enabled)}
            />
          </SettingRow>
          <SettingRow
            description="Turn on for a build installed straight from Xcode, which Apple's sandbox serves."
            more="Leave off for TestFlight and App Store builds."
            label="Development build"
            scope="host"
            settingId="host-push-development"
          >
            <OctantSwitch
              checked={status.development}
              disabled={busy}
              label="Development build"
              onCheckedChange={(development) => void setDevelopment(development)}
            />
          </SettingRow>
        </div>
        <div className="settings-panel__stack">
          <SettingRow
            description={`${status.ios ? "Stored" : "Not stored"}: the .p8 key from your Apple Developer account.`}
            more="The key goes to this computer's credential store and is never shown again."
            label="Apple push key"
            scope="host"
            settingId="host-push-apple"
          >
            {status.ios ? (
              <OctantButton
                disabled={busy}
                onClick={() => void removeCredential("ios")}
                variant="secondary"
              >
                Remove
              </OctantButton>
            ) : null}
          </SettingRow>
          <OctantField>
            <OctantFieldLabel htmlFor={appleKeyIdId}>Key ID</OctantFieldLabel>
            <OctantInput
              autoComplete="off"
              id={appleKeyIdId}
              onChange={(event) => setAppleDraft({ ...appleDraft, keyId: event.target.value })}
              placeholder="ABCDE12345"
              spellCheck={false}
              value={appleDraft.keyId}
            />
          </OctantField>
          <OctantField>
            <OctantFieldLabel htmlFor={appleTeamIdId}>Team ID</OctantFieldLabel>
            <OctantInput
              autoComplete="off"
              id={appleTeamIdId}
              onChange={(event) => setAppleDraft({ ...appleDraft, teamId: event.target.value })}
              placeholder="TEAM123456"
              spellCheck={false}
              value={appleDraft.teamId}
            />
          </OctantField>
          <OctantField>
            <OctantFieldLabel htmlFor={appleBundleIdId}>Bundle ID</OctantFieldLabel>
            <OctantInput
              autoComplete="off"
              id={appleBundleIdId}
              onChange={(event) => setAppleDraft({ ...appleDraft, bundleId: event.target.value })}
              placeholder="com.example.octant"
              spellCheck={false}
              value={appleDraft.bundleId}
            />
          </OctantField>
          <OctantField>
            <OctantFieldLabel htmlFor={applePrivateKeyId}>Private key (.p8 file)</OctantFieldLabel>
            <OctantTextarea
              autoComplete="off"
              id={applePrivateKeyId}
              onChange={(event) => setAppleDraft({ ...appleDraft, privateKey: event.target.value })}
              rows={4}
              spellCheck={false}
              value={appleDraft.privateKey}
            />
          </OctantField>
          <div className="host-settings__controls">
            <OctantButton
              disabled={
                busy ||
                appleDraft.keyId.trim() === "" ||
                appleDraft.teamId.trim() === "" ||
                appleDraft.bundleId.trim() === "" ||
                appleDraft.privateKey.trim() === ""
              }
              onClick={() => void storeAppleKey()}
            >
              {status.ios ? "Replace Apple key" : "Store Apple key"}
            </OctantButton>
          </div>
        </div>
        <div className="settings-panel__stack">
          <SettingRow
            description={`${status.android ? "Stored" : "Not stored"}: the service-account JSON file from your Firebase project.`}
            more="The file goes to this computer's credential store and is never shown again."
            label="Google service account"
            scope="host"
            settingId="host-push-google"
          >
            {status.android ? (
              <OctantButton
                disabled={busy}
                onClick={() => void removeCredential("android")}
                variant="secondary"
              >
                Remove
              </OctantButton>
            ) : null}
          </SettingRow>
          <OctantField>
            <OctantFieldLabel htmlFor={googleAccountId}>Service account (JSON)</OctantFieldLabel>
            <OctantTextarea
              autoComplete="off"
              id={googleAccountId}
              onChange={(event) => setGoogleDraft(event.target.value)}
              rows={4}
              spellCheck={false}
              value={googleDraft}
            />
          </OctantField>
          <div className="host-settings__controls">
            <OctantButton
              disabled={busy || googleDraft.trim() === ""}
              onClick={() => void storeGoogleAccount()}
            >
              {status.android ? "Replace service account" : "Store service account"}
            </OctantButton>
          </div>
        </div>
      </>
    );
  }
  return (
    <SettingsSection
      description="Thread and automation notifications for phones paired with this computer. Off until you turn it on."
      title="Phone notifications"
    >
      {body}
      {message === undefined ? null : <SettingsState kind="success">{message}</SettingsState>}
      {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
    </SettingsSection>
  );
}
