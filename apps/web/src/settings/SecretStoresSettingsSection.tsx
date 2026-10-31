import type { SecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import type {
  SecretStoreCheckOutcome,
  SecretStoreSummary,
  SecretStoresCommand,
  SecretStoresResult,
  SecretStoreToolState,
} from "@octant/contracts/secret-stores";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

/** What each state of the tool means for the person, in plain words. */
export const SECRET_STORE_TOOL_STATE_TEXT: Readonly<Record<SecretStoreToolState, string>> = {
  ready: "Ready. The command line tool is installed and the store is unlocked.",
  locked: "Locked. Unlock it, then try again.",
  "not-installed": "The command line tool (op) is not installed on this computer.",
  unavailable: "Octant could not reach it.",
};

export const SECRET_STORE_CHECK_TEXT: Readonly<Record<SecretStoreCheckOutcome, string>> = {
  found: "Found. Octant can read this item.",
  locked: "The store is locked. Unlock it, then check again.",
  missing: "No item with that reference was found.",
  unavailable: "Octant could not reach the store.",
  "not-linked": "Link the store first.",
  "invalid-reference": "That is not a valid item reference.",
};

const REFERENCE_PLACEHOLDER = "op://Vault/Item/field";

export interface SecretStoresSettingsSectionProps {
  /** Absent off this host: linking a store is host authority. */
  readonly client: SecretStoresClient | undefined;
  readonly focusedSetting?: string | undefined;
}

/**
 * Settings › Secret stores: link a password manager you already use, then
 * point a provider's API key at an item in it from the provider's own page.
 * Octant keeps the item's address and fetches the key when it is used. This
 * page never asks for, receives, or shows a key.
 */
export function SecretStoresSettingsSection(props: SecretStoresSettingsSectionProps) {
  const { client } = props;
  const [view, setView] = useState<Extract<SecretStoresResult, { kind: "secret-stores-view" }>>();
  const [problem, setProblem] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState<SecretStoreSummary>();
  const [reference, setReference] = useState("");
  const [checked, setChecked] = useState<SecretStoreCheckOutcome>();

  const accept = useCallback((result: SecretStoresResult): boolean => {
    if (result.kind === "secret-stores-view") {
      setView(result);
      setProblem(undefined);
      return true;
    }
    if (result.kind === "secret-stores-refused") setProblem(result.message);
    return false;
  }, []);

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      const result = await client.read();
      setLoadFailed(!accept(result));
    } catch {
      setLoadFailed(true);
    }
  }, [client, accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (command: SecretStoresCommand): Promise<SecretStoresResult | undefined> => {
    if (client === undefined) return undefined;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.execute(command);
      accept(result);
      return result;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Secret stores are unavailable.");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  if (client === undefined) {
    return (
      <div className="settings-section-stack" id="settings-secret-stores">
        <SettingsSection
          description="Linking a secret store happens in the Octant app on the host machine."
          title="Linked secret stores"
        />
      </div>
    );
  }

  const linkedStore = view?.stores.find((store) => store.linked);

  const check = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (linkedStore === undefined || reference.trim() === "") return;
    setChecked(undefined);
    void run({
      kind: "check-reference",
      store: linkedStore.kind,
      reference: reference.trim(),
    }).then((result) => {
      if (result?.kind === "secret-stores-checked") setChecked(result.outcome);
    });
  };

  return (
    <div className="settings-section-stack" id="settings-secret-stores">
      <SettingsSection
        description="Link a password manager you already use. Octant keeps an item's address, never the key: it asks the manager for the key each time one is used, and never stores, logs, or shows it."
        title="Linked secret stores"
      >
        {view === undefined ? (
          <SettingsState kind={loadFailed ? "error" : "loading"}>
            {loadFailed
              ? (problem ?? "Secret stores could not be read from this host.")
              : "Reading secret stores…"}
          </SettingsState>
        ) : !view.brokerAvailable ? (
          <SettingsState kind="empty">
            This host has no credential broker, so it cannot link a secret store. The Octant app on
            macOS and a Linux host with a keyring provide one.
          </SettingsState>
        ) : (
          <div className="setgroup">
            {view.stores.map((store) => (
              <SettingRow
                description={
                  store.linked
                    ? `Linked. ${SECRET_STORE_TOOL_STATE_TEXT[store.tool]}`
                    : `Not linked. ${SECRET_STORE_TOOL_STATE_TEXT[store.tool]}`
                }
                focused={props.focusedSetting === "secret-store-link"}
                key={store.kind}
                label={store.label}
                scope="host"
                settingId="secret-store-link"
              >
                {store.linked ? (
                  <OctantButton
                    disabled={busy}
                    onClick={() => setUnlinking(store)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Unlink
                  </OctantButton>
                ) : (
                  <OctantButton
                    disabled={busy}
                    onClick={() => void run({ kind: "link-store", store: store.kind })}
                    size="sm"
                    type="button"
                  >
                    Link {store.label}
                  </OctantButton>
                )}
              </SettingRow>
            ))}
          </div>
        )}
        <div aria-live="polite">
          {problem === undefined || view === undefined ? null : (
            <SettingsState kind="error">{problem}</SettingsState>
          )}
        </div>
      </SettingsSection>

      {view?.brokerAvailable === true ? (
        <SettingsSection
          description="Check that Octant can read an item. Nothing is shown or kept: the answer says whether the item was found. To use an item as a provider's key, open that provider in Providers & Models."
          title="Check an item"
        >
          <form aria-label="Check an item" noValidate onSubmit={check}>
            <div className="setgroup">
              <SettingRow
                description={
                  linkedStore === undefined
                    ? "Link a store first."
                    : "An item reference looks like the example below."
                }
                focused={props.focusedSetting === "secret-store-check"}
                htmlFor="secret-store-reference"
                label="Item reference"
                scope="host"
                settingId="secret-store-check"
              >
                <OctantInput
                  autoComplete="off"
                  className="settings-view__text-input"
                  disabled={busy || linkedStore === undefined}
                  id="secret-store-reference"
                  maxLength={512}
                  onChange={(event) => {
                    setReference(event.target.value);
                    setChecked(undefined);
                  }}
                  placeholder={REFERENCE_PLACEHOLDER}
                  spellCheck={false}
                  value={reference}
                />
                <OctantButton
                  disabled={busy || linkedStore === undefined || reference.trim() === ""}
                  size="sm"
                  type="submit"
                >
                  Check
                </OctantButton>
              </SettingRow>
            </div>
          </form>
          <div aria-live="polite">
            {checked === undefined ? null : (
              <SettingsState kind={checked === "found" ? "success" : "error"}>
                {SECRET_STORE_CHECK_TEXT[checked]}
              </SettingsState>
            )}
          </div>
        </SettingsSection>
      ) : null}

      {unlinking === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel={`Unlink ${unlinking.label}`}
          destructive
          onCancel={() => setUnlinking(undefined)}
          onConfirm={() => {
            const store = unlinking;
            setUnlinking(undefined);
            setChecked(undefined);
            void run({ kind: "unlink-store", store: store.kind });
          }}
          pending={busy}
          title={`Unlink ${unlinking.label}?`}
        >
          Providers whose key points at an item in {unlinking.label} stop getting their key until
          you link it again. Nothing in {unlinking.label} is changed or deleted.
        </OctantConfirmDialog>
      )}
    </div>
  );
}
