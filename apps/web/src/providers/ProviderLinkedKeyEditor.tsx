import type { ProviderCredentialStatus, ProviderInstanceId } from "@octant/contracts";
import type {
  SecretStoreCheckOutcome,
  SecretStoreKind,
  SecretStoreSummary,
  SecretStoresResult,
} from "@octant/contracts/secret-stores";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SECRET_STORE_CHECK_TEXT } from "../settings/SecretStoresSettingsSection";
import { useSecretStoresClient } from "../settings/SecretStoresClientContext";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProviderLinkedKeyEditorProps {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly disabled?: boolean | undefined;
  /** Reports the stored state after a change, so the credential line stays current. */
  readonly onChanged?: ((status: ProviderCredentialStatus) => void) | undefined;
}

interface Reference {
  readonly store: SecretStoreKind;
  readonly reference: string;
}

/**
 * Points this provider's API key at an item in a linked secret store instead
 * of storing a key. Octant keeps the item's address and fetches the key each
 * time it is used. The page shows the address, which names an item, and never
 * a key: the host does not send one back.
 */
export function ProviderLinkedKeyEditor(props: ProviderLinkedKeyEditorProps) {
  const client = useSecretStoresClient();
  const { instanceId, onChanged } = props;
  const [reference, setReference] = useState<Reference | null | undefined>(undefined);
  const [stores, setStores] = useState<ReadonlyArray<SecretStoreSummary>>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [checked, setChecked] = useState<SecretStoreCheckOutcome>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      const [current, view] = await Promise.all([
        client.execute({ kind: "read-provider-key-reference", instanceId }),
        client.read(),
      ]);
      if (current.kind === "secret-stores-provider-reference") setReference(current.reference);
      if (view.kind === "secret-stores-view") setStores(view.stores);
    } catch {
      setReference(undefined);
    }
  }, [client, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (client === undefined) return null;
  const linked = stores.filter((store) => store.linked);
  // Nothing to show until the host has answered, and nothing to offer when no
  // store is linked and no reference exists: every provider card would
  // otherwise carry a section most people never use.
  if (reference === undefined || (reference === null && linked.length === 0)) return null;

  const run = async (
    command: Parameters<typeof client.execute>[0],
    onDone: (result: SecretStoresResult) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await client.execute(command);
      if (result.kind === "secret-stores-refused") setMessage(result.message);
      else onDone(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Secret stores are unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const store = linked[0];
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = draft.trim();
    if (store === undefined || value === "") return;
    void run(
      { kind: "point-provider-key", instanceId, store: store.kind, reference: value },
      (result) => {
        if (result.kind !== "secret-stores-provider-reference") return;
        setReference(result.reference);
        setEditing(false);
        setDraft("");
        setChecked(undefined);
        onChanged?.("stored");
      },
    );
  };

  const disabled = props.disabled === true || busy;
  const storeLabel =
    stores.find((entry) => entry.kind === reference?.store)?.label ?? "the secret store";

  return (
    <section
      aria-label={`Key from a secret store for ${props.displayName}`}
      className="provider-details__section provider-api-keys provider-linked-key"
    >
      <div>
        <h4 className="oct-section-label">Key from a secret store</h4>
        <p className="oct-row-detail">
          Instead of storing a key, point this provider at an item in a store you have linked.
          Octant fetches the key each time it is used and never keeps it.
        </p>
      </div>
      {reference !== null && !editing ? (
        <div className="provider-api-keys__key">
          <span className="provider-api-keys__label provider-linked-key__item">
            {storeLabel}: <code>{reference.reference}</code>
          </span>
          <span className="provider-api-keys__actions">
            <OctantButton
              aria-label={`Check the item for ${props.displayName}`}
              disabled={disabled}
              onClick={() =>
                void run(
                  {
                    kind: "check-reference",
                    store: reference.store,
                    reference: reference.reference,
                  },
                  (result) => {
                    if (result.kind === "secret-stores-checked") setChecked(result.outcome);
                  },
                )
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Check
            </OctantButton>
            <OctantButton
              aria-label={`Change the item for ${props.displayName}`}
              disabled={disabled}
              onClick={() => {
                setDraft(reference.reference);
                setEditing(true);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Change item
            </OctantButton>
            <OctantButton
              aria-label={`Remove the item for ${props.displayName}`}
              disabled={disabled}
              onClick={() =>
                void run({ kind: "clear-provider-key-reference", instanceId }, () => {
                  setReference(null);
                  setChecked(undefined);
                  onChanged?.("missing");
                })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </OctantButton>
          </span>
        </div>
      ) : store === undefined ? null : (
        <form
          noValidate
          aria-label={`Point ${props.displayName} at an item in ${store.label}`}
          onSubmit={save}
        >
          <div className="provider-api-keys__edit">
            <OctantInput
              aria-label={`Item reference in ${store.label}`}
              autoComplete="off"
              className="settings-view__text-input"
              disabled={disabled}
              maxLength={512}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="op://Vault/Item/field"
              spellCheck={false}
              value={draft}
            />
            <OctantButton disabled={disabled || draft.trim() === ""} size="sm" type="submit">
              Use this item
            </OctantButton>
            {editing ? (
              <OctantButton
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </OctantButton>
            ) : null}
          </div>
        </form>
      )}
      <div aria-live="polite">
        {checked === undefined ? null : (
          <p className="oct-row-detail" role="status">
            {SECRET_STORE_CHECK_TEXT[checked]}
          </p>
        )}
      </div>
      {message !== undefined ? <OctantAlert tone="danger">{message}</OctantAlert> : null}
    </section>
  );
}
