import type {
  ProviderCredentialStatus,
  ProviderInstance,
  ProviderInstanceId,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  getInjectedHostBridge,
  type OctantHostBridge,
  type ProviderApiKeySummary,
} from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProviderApiKeyEditorProps {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly disabled?: boolean | undefined;
  /** Reports the stored state after a change, so the credential line stays current. */
  readonly onChanged?: ((status: ProviderCredentialStatus) => void) | undefined;
  /** The host bridge. Defaults to the injected host; absent in a browser. */
  readonly bridge?: OctantHostBridge | undefined;
}

type Pending =
  | { readonly kind: "idle" }
  | { readonly kind: "rename"; readonly keyId: string; readonly label: string }
  | { readonly kind: "replace"; readonly keyId: string }
  | { readonly kind: "confirm-remove"; readonly keyId: string };

/**
 * Whether this instance's stored value is a plain API key the pool can hold.
 * A sign-in grant is stored under the same slot, but it is not a key: the
 * editor must never list it or remove it.
 */
export function acceptsApiKeyPool(instance: ProviderInstance): boolean {
  const { configuration } = instance;
  if ("oauthDescriptorId" in configuration && configuration.oauthDescriptorId !== undefined) {
    return false;
  }
  if (!("authentication" in configuration)) return true;
  return configuration.authentication === "api-key" || configuration.authentication === "bearer";
}

/**
 * The API keys one provider instance holds, in the order Octant tries them.
 * Labels come from the host; secrets go to the host and are never read back.
 */
export function ProviderApiKeyEditor(props: ProviderApiKeyEditorProps) {
  const bridge: OctantHostBridge | undefined = props.bridge ?? getInjectedHostBridge();
  const [keys, setKeys] = useState<readonly ProviderApiKeySummary[]>([]);
  const [loaded, setLoaded] = useState<"loading" | "ready" | "failed">("loading");
  const [pending, setPending] = useState<Pending>({ kind: "idle" });
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const newSecret = useRef<HTMLInputElement>(null);
  const replacementSecret = useRef<HTMLInputElement>(null);
  const { instanceId, onChanged } = props;

  const load = useCallback(async (): Promise<readonly ProviderApiKeySummary[] | undefined> => {
    if (bridge === undefined) return undefined;
    try {
      const listed = await bridge.listProviderApiKeys(instanceId);
      setKeys(listed);
      setLoaded("ready");
      return listed;
    } catch {
      setLoaded("failed");
      return undefined;
    }
  }, [bridge, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (task: () => Promise<void>, onDone?: () => void) => {
    if (bridge === undefined || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await task();
      onDone?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Octant could not update the API keys.");
    } finally {
      setBusy(false);
      const listed = await load();
      if (listed !== undefined) onChanged?.(listed.length > 0 ? "stored" : "missing");
    }
  };

  if (bridge === undefined) {
    return (
      <section
        aria-label={`API keys for ${props.displayName}`}
        className="provider-details__section"
      >
        <p className="provider-card__guidance">
          Manage API keys in the Octant host app. Adding, renaming, and removing keys is unavailable
          in this browser.
        </p>
      </section>
    );
  }

  const disabled = props.disabled === true || busy;

  const addKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const secret = newSecret.current?.value ?? "";
    if (secret.length === 0) {
      setMessage("Enter an API key first.");
      return;
    }
    const label = newLabel.trim();
    void change(
      async () => {
        await bridge.addProviderApiKey(instanceId, secret, label === "" ? undefined : label);
      },
      () => {
        if (newSecret.current !== null) newSecret.current.value = "";
        setNewLabel("");
      },
    );
  };

  const saveRename = (keyId: string, label: string) => {
    void change(
      async () => {
        await bridge.renameProviderApiKey(instanceId, keyId, label.trim());
      },
      () => setPending({ kind: "idle" }),
    );
  };

  const saveReplacement = (keyId: string) => {
    const secret = replacementSecret.current?.value ?? "";
    if (secret.length === 0) {
      setMessage("Enter the replacement key first.");
      return;
    }
    void change(
      async () => {
        await bridge.replaceProviderApiKey(instanceId, keyId, secret);
      },
      () => {
        if (replacementSecret.current !== null) replacementSecret.current.value = "";
        setPending({ kind: "idle" });
      },
    );
  };

  const removeKey = (keyId: string) => {
    void change(
      async () => {
        await bridge.removeProviderApiKey(instanceId, keyId);
      },
      () => setPending({ kind: "idle" }),
    );
  };

  return (
    <section
      aria-label={`API keys for ${props.displayName}`}
      className="provider-details__section provider-api-keys"
    >
      <div>
        <h4 className="oct-section-label">API keys</h4>
        <p className="oct-row-detail">
          Octant tries the keys in this order. A key that runs out of quota or hits a limit is
          skipped, and the next one is used.
        </p>
      </div>
      {loaded === "failed" ? (
        <p className="provider-card__guidance">Octant could not read the API keys.</p>
      ) : null}
      <ol className="provider-api-keys__list">
        {keys.map((key, index) => (
          <li className="provider-api-keys__key" key={key.id}>
            <span className="provider-api-keys__label">{key.label}</span>
            {index === 0 ? <span className="oct-row-detail">Tried first</span> : null}
            {pending.kind === "rename" && pending.keyId === key.id ? (
              <form
                noValidate
                aria-label={`Rename ${key.label}`}
                className="provider-api-keys__edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveRename(key.id, pending.label);
                }}
              >
                <OctantInput
                  aria-label={`New label for ${key.label}`}
                  className="settings-view__text-input"
                  disabled={disabled}
                  maxLength={64}
                  onChange={(event) =>
                    setPending({ kind: "rename", keyId: key.id, label: event.target.value })
                  }
                  value={pending.label}
                />
                <OctantButton disabled={disabled} size="sm" type="submit">
                  Save label
                </OctantButton>
                <OctantButton
                  onClick={() => setPending({ kind: "idle" })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </OctantButton>
              </form>
            ) : pending.kind === "replace" && pending.keyId === key.id ? (
              <form
                noValidate
                aria-label={`Replace ${key.label}`}
                className="provider-api-keys__edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveReplacement(key.id);
                }}
              >
                <OctantInput
                  aria-label={`New API key for ${key.label}`}
                  autoComplete="new-password"
                  className="settings-view__text-input"
                  disabled={disabled}
                  ref={replacementSecret}
                  spellCheck={false}
                  type="password"
                />
                <OctantButton disabled={disabled} size="sm" type="submit">
                  Replace key
                </OctantButton>
                <OctantButton
                  onClick={() => setPending({ kind: "idle" })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </OctantButton>
              </form>
            ) : pending.kind === "confirm-remove" && pending.keyId === key.id ? (
              <span className="provider-api-keys__edit">
                <OctantButton
                  disabled={disabled}
                  onClick={() => removeKey(key.id)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Remove {key.label}
                </OctantButton>
                <OctantButton
                  onClick={() => setPending({ kind: "idle" })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Keep it
                </OctantButton>
              </span>
            ) : (
              <span className="provider-api-keys__actions">
                <OctantButton
                  aria-label={`Rename ${key.label}`}
                  disabled={disabled}
                  onClick={() => setPending({ kind: "rename", keyId: key.id, label: key.label })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Rename
                </OctantButton>
                <OctantButton
                  aria-label={`Replace the key for ${key.label}`}
                  disabled={disabled}
                  onClick={() => setPending({ kind: "replace", keyId: key.id })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Replace key
                </OctantButton>
                <OctantButton
                  aria-label={`Remove ${key.label}`}
                  disabled={disabled}
                  onClick={() => setPending({ kind: "confirm-remove", keyId: key.id })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              </span>
            )}
          </li>
        ))}
      </ol>
      <form noValidate aria-label={`Add an API key for ${props.displayName}`} onSubmit={addKey}>
        <div className="provider-api-keys__edit">
          <OctantInput
            aria-label="Label for the new API key"
            className="settings-view__text-input"
            disabled={disabled}
            maxLength={64}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder="Label (optional)"
            value={newLabel}
          />
          <OctantInput
            aria-label="New API key"
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={disabled}
            ref={newSecret}
            spellCheck={false}
            type="password"
          />
          <OctantButton disabled={disabled} size="sm" type="submit">
            Add key
          </OctantButton>
        </div>
      </form>
      {message !== undefined ? <OctantAlert tone="danger">{message}</OctantAlert> : null}
    </section>
  );
}
