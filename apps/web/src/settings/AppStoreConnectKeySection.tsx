import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AppStoreConnectKeyBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingRow, SettingsSection } from "./primitives";

type Shown =
  | { readonly kind: "loading" }
  | { readonly kind: "hidden" }
  | { readonly kind: "shown"; readonly stored: boolean };

function outcomeOf(answer: {
  readonly status: number;
  readonly body: unknown;
}): string | undefined {
  const body = answer.body;
  if (answer.status !== 200 || typeof body !== "object" || body === null) return undefined;
  const outcome = (body as { readonly outcome?: unknown }).outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

function refusalOf(answer: { readonly body: unknown }): string {
  const body = answer.body;
  if (typeof body === "object" && body !== null) {
    const message = (body as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The host did not save the key.";
}

/**
 * The App Store Connect API key a person enters so Octant can upload their own
 * app (docs/design/apple-devices.md § Distribution). Shown only in a desktop
 * window on a Mac host whose release boundary admits distribution: anything
 * else answers the status read with a refusal, and the section stays hidden.
 * The key goes to the host once and the fields are cleared at once; nothing
 * here can read it back.
 */
export function AppStoreConnectKeySection({
  bridge,
}: {
  readonly bridge: AppStoreConnectKeyBridge;
}) {
  const issuerFieldId = useId();
  const keyFieldId = useId();
  const privateKeyFieldId = useId();
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    readonly kind: "status" | "alert";
    readonly text: string;
  }>();
  const mounted = useRef(true);

  // Settings hands this section a new bridge object on every render, so the
  // status read follows the request function, which the desktop keeps stable;
  // following the object asked the host again on each keystroke elsewhere.
  const request = bridge.appStoreConnectKeyRequest;
  useEffect(() => {
    mounted.current = true;
    void request("status", {})
      .then((answer) => {
        if (!mounted.current) return;
        const outcome = outcomeOf(answer);
        setShown(
          outcome === "stored" || outcome === "missing"
            ? { kind: "shown", stored: outcome === "stored" }
            : { kind: "hidden" },
        );
      })
      .catch(() => {
        if (mounted.current) setShown({ kind: "hidden" });
      });
    return () => {
      mounted.current = false;
    };
  }, [request]);

  if (shown.kind !== "shown") return null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const body = { issuerId, keyId, privateKey, replace: shown.stored };
    // The key leaves this window with this one request and is not kept here.
    setPrivateKey("");
    setBusy(true);
    try {
      const answer = await bridge.appStoreConnectKeyRequest("set", body);
      if (!mounted.current) return;
      if (outcomeOf(answer) === "stored") {
        setIssuerId("");
        setKeyId("");
        setShown({ kind: "shown", stored: true });
        setMessage({ kind: "status", text: "Key saved." });
      } else {
        setMessage({ kind: "alert", text: refusalOf(answer) });
      }
    } catch {
      if (mounted.current) setMessage({ kind: "alert", text: "Octant could not reach the host." });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const answer = await bridge.appStoreConnectKeyRequest("remove", {});
      if (!mounted.current) return;
      if (outcomeOf(answer) === "removed") {
        setShown({ kind: "shown", stored: false });
        setMessage({ kind: "status", text: "Key removed." });
      } else {
        setMessage({ kind: "alert", text: refusalOf(answer) });
      }
    } catch {
      if (mounted.current) setMessage({ kind: "alert", text: "Octant could not reach the host." });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="App Store Connect"
      description="The API key Octant uses to upload your own app when you ask it to. It is kept in the Keychain and never shown again."
    >
      <form
        className="setgroup app-store-connect-key__fields"
        noValidate
        onSubmit={(event) => void save(event)}
      >
        <SettingRow
          settingId="app-store-connect-key-state"
          label="API key"
          description={
            shown.stored
              ? "A key is saved on this Mac. Entering another replaces it."
              : "No key is saved. Create one in App Store Connect under Users and Access › Integrations."
          }
          scope="host"
        >
          <div className="settings-view__actions">
            <span>{shown.stored ? "Saved" : "Not saved"}</span>
            {shown.stored ? (
              <OctantButton
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove key
              </OctantButton>
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          settingId="app-store-connect-issuer"
          label="Issuer ID"
          htmlFor={issuerFieldId}
          scope="host"
        >
          <OctantInput
            id={issuerFieldId}
            value={issuerId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setIssuerId(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          settingId="app-store-connect-key-id"
          label="Key ID"
          htmlFor={keyFieldId}
          scope="host"
        >
          <OctantInput
            id={keyFieldId}
            value={keyId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKeyId(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          settingId="app-store-connect-private-key"
          label="Private key"
          description="Paste the contents of the .p8 file App Store Connect gave you."
          htmlFor={privateKeyFieldId}
          scope="host"
        >
          <OctantTextarea
            id={privateKeyFieldId}
            value={privateKey}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </SettingRow>
        <div className="settings-view__actions app-store-connect-key__save">
          <OctantButton
            type="submit"
            size="sm"
            disabled={busy || issuerId === "" || keyId === "" || privateKey === ""}
          >
            {shown.stored ? "Replace key" : "Save key"}
          </OctantButton>
        </div>
      </form>
      {message === undefined ? null : (
        <p className="provider-settings__field-guidance" role={message.kind}>
          {message.text}
        </p>
      )}
    </SettingsSection>
  );
}
