import type { SecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import {
  decodeGoogleCliAccountReference,
  type GoogleCliAccountReference,
  type SecretStoresResult,
  type SecretStoreSummary,
} from "@octant/contracts/secret-stores";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

type Snapshot = Extract<SecretStoresResult, { kind: "secret-stores-google-cli-account" }>;
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
function sameSelection(left: GoogleCliAccountReference | null, right: GoogleCliAccountReference) {
  return (
    left !== null &&
    left.store === right.store &&
    left.reference === right.reference &&
    left.serviceAccountEmail === right.serviceAccountEmail &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}

export function GoogleCliAccountSettings({
  client,
  linkedStore,
  focusedSetting,
}: {
  readonly client: SecretStoresClient;
  readonly linkedStore: SecretStoreSummary | undefined;
  readonly focusedSetting?: string | undefined;
}) {
  const current = useRef(client);
  current.current = client;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [revision, refresh] = useState(0);
  const readEpoch = useRef(0);
  const [state, setState] = useState<{
    readonly client: SecretStoresClient;
    readonly snapshot?: Snapshot;
    readonly problem?: string;
  }>();
  const [draft, setDraft] = useState({ client, email: "", reference: "", scopes: DEFAULT_SCOPE });
  const [candidate, setCandidate] = useState<{
    readonly client: SecretStoresClient;
    readonly selection: GoogleCliAccountReference;
  }>();
  const [busyClient, setBusy] = useState<SecretStoresClient>();
  const review = useRef<HTMLButtonElement>(null);
  const shown = state?.client === client ? state : undefined;
  const fields =
    draft.client === client ? draft : { client, email: "", reference: "", scopes: DEFAULT_SCOPE };
  const busy = busyClient === client;
  const selection =
    candidate?.client === client && linkedStore?.kind === candidate.selection.store
      ? candidate.selection
      : undefined;
  const stillCurrent = () => active.current && current.current === client;
  useEffect(() => {
    const epoch = ++readEpoch.current;
    let live = true;
    setState({ client });
    void client
      .execute({ kind: "read-google-cli-account" })
      .then((result) => {
        if (!live || current.current !== client || readEpoch.current !== epoch) return;
        setState(
          result.kind === "secret-stores-google-cli-account"
            ? { client, snapshot: result }
            : {
                client,
                problem:
                  result.kind === "secret-stores-refused"
                    ? result.message
                    : "This host has not reported its Google Cloud account.",
              },
        );
      })
      .catch(() => {
        if (live && current.current === client && readEpoch.current === epoch)
          setState({
            client,
            problem:
              "The Google Cloud account could not be read. Refresh before relying on a previous report.",
          });
      });
    return () => {
      live = false;
    };
  }, [client, revision]);
  const problem = (message: string) =>
    setState({
      client,
      ...(shown?.snapshot === undefined ? {} : { snapshot: shown.snapshot }),
      problem: message,
    });
  const ask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (linkedStore === undefined || busy) return;
    try {
      const next = decodeGoogleCliAccountReference({
        store: linkedStore.kind,
        reference: fields.reference.trim(),
        serviceAccountEmail: fields.email.trim(),
        scopes: fields.scopes.trim().split(/\s+/).filter(Boolean),
      });
      setCandidate({ client, selection: next });
    } catch {
      problem(
        "Enter a valid service-account email, linked item reference and one to 16 distinct Google OAuth scope URLs.",
      );
    }
  };
  const configure = async () => {
    if (selection === undefined || busy) return;
    const submitted = selection;
    readEpoch.current += 1;
    setBusy(client);
    try {
      const result = await client.execute({
        kind: "point-google-cli-account",
        confirmed: true,
        ...submitted,
      });
      if (!stillCurrent()) return;
      if (
        result.kind === "secret-stores-google-cli-account" &&
        sameSelection(result.reference, submitted)
      ) {
        setState({ client, snapshot: result });
        setDraft({ client, email: "", reference: "", scopes: DEFAULT_SCOPE });
      } else
        problem(
          result.kind === "secret-stores-refused"
            ? result.message
            : "The account change was not confirmed. Read the current account before trying again.",
        );
    } catch {
      if (stillCurrent())
        problem(
          "The account change was not confirmed. Read the current account before trying again.",
        );
    } finally {
      if (stillCurrent()) {
        setBusy(undefined);
        setCandidate(undefined);
      }
    }
  };
  const remove = async () => {
    if (busy) return;
    readEpoch.current += 1;
    setBusy(client);
    try {
      const result = await client.execute({ kind: "clear-google-cli-account" });
      if (!stillCurrent()) return;
      if (result.kind === "secret-stores-google-cli-account" && result.reference === null)
        setState({ client, snapshot: result });
      else
        problem(
          result.kind === "secret-stores-refused"
            ? result.message
            : "Removal was not confirmed. Read the current account before trying again.",
        );
    } catch {
      if (stillCurrent())
        problem("Removal was not confirmed. Read the current account before trying again.");
    } finally {
      if (stillCurrent()) setBusy(undefined);
    }
  };
  useEffect(() => {
    setCandidate(undefined);
  }, [client, linkedStore?.kind, linkedStore?.linked]);
  const saved = shown?.snapshot;
  return (
    <SettingsSection
      title="Google Cloud command line"
      description="For gcloud commands in Octant's own shell. The linked service-account key stays in the broker; each command receives an expiring token in its own temporary file and private configuration."
    >
      <p>
        A token can access every Project allowed by this account&apos;s IAM roles and the OAuth
        scopes you select. It is not confined to the task&apos;s Project.
      </p>
      <form aria-label="Google Cloud command line" noValidate onSubmit={ask}>
        <div className="setgroup">
          <SettingRow
            label="Current account"
            scope="host"
            settingId="secret-store-google-cli"
            focused={focusedSetting === "secret-store-google-cli"}
            description={
              saved === undefined
                ? shown?.problem === undefined
                  ? "Reading Google Cloud account…"
                  : "Google Cloud account not reported."
                : saved.reference === null
                  ? "No Google Cloud account configured."
                  : `${saved.reference.serviceAccountEmail} · ${saved.reference.reference}`
            }
          >
            <OctantButton
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => refresh((value) => value + 1)}
            >
              Read current Google account
            </OctantButton>
            {saved?.reference === null || saved?.reference === undefined ? null : (
              <OctantButton
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove Google Cloud account
              </OctantButton>
            )}
          </SettingRow>
          <SettingRow
            label="Service account email"
            scope="host"
            settingId="secret-store-google-cli-email"
            htmlFor="google-cli-email"
            description="Must match the service account in the linked JSON item."
          >
            <OctantInput
              className="settings-view__text-input"
              id="google-cli-email"
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              disabled={busy || linkedStore === undefined}
              value={fields.email}
              onChange={(event) => setDraft({ ...fields, email: event.target.value })}
            />
          </SettingRow>
          <SettingRow
            label="Service-account JSON item"
            scope="host"
            settingId="secret-store-google-cli-reference"
            htmlFor="google-cli-reference"
            description={
              linkedStore === undefined
                ? "Link a secret store first."
                : "Enter the linked item's address, not its JSON or private key."
            }
          >
            <OctantInput
              className="settings-view__text-input"
              id="google-cli-reference"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              placeholder="op://Vault/Google/service account JSON"
              disabled={busy || linkedStore === undefined}
              value={fields.reference}
              onChange={(event) => setDraft({ ...fields, reference: event.target.value })}
            />
          </SettingRow>
          <SettingRow
            label="OAuth scopes"
            scope="host"
            settingId="secret-store-google-cli-scopes"
            htmlFor="google-cli-scopes"
            description="One Google OAuth scope URL per line. Select only the access these commands need."
          >
            <OctantTextarea
              className="settings-view__text-input"
              id="google-cli-scopes"
              rows={3}
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || linkedStore === undefined}
              value={fields.scopes}
              onChange={(event) => setDraft({ ...fields, scopes: event.target.value })}
            />
          </SettingRow>
        </div>
        <OctantButton
          ref={review}
          type="submit"
          size="sm"
          disabled={
            busy ||
            linkedStore === undefined ||
            fields.reference.trim() === "" ||
            fields.email.trim() === "" ||
            fields.scopes.trim() === ""
          }
        >
          Review Google Cloud account
        </OctantButton>
      </form>
      {saved?.reference === undefined || saved.reference === null ? null : (
        <ul className="break-words">
          {saved.reference.scopes.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
      )}
      <p>
        {saved?.sessionExpiresAt === undefined
          ? "Tokens are issued when commands run and expire within one hour. No token issuance has been reported here."
          : `Last token expiry: ${absoluteTimeFormatter.format(new Date(saved.sessionExpiresAt))}.`}
      </p>
      <p>
        Removing this reference stops Octant supplying tokens to future commands and cancels
        commands still being prepared. It does not sign out the host or revoke tokens already
        received by a running command; those may remain valid until expiry.
      </p>
      <div aria-live="polite">
        {shown?.problem === undefined ? null : (
          <SettingsState kind="error">{shown.problem}</SettingsState>
        )}
      </div>
      {selection === undefined ? null : (
        <OctantConfirmDialog
          title="Use this service account for commands?"
          confirmLabel="Use this service account"
          pending={busy}
          restoreFocus={review}
          onCancel={() => setCandidate(undefined)}
          onConfirm={() => void configure()}
          details={
            <div className="break-words">
              <p>{selection.serviceAccountEmail}</p>
              <ul>
                {selection.scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            </div>
          }
        >
          Allow gcloud commands in Octant&apos;s own shell to use short-lived tokens for this
          account and these scopes. The service-account key remains in the linked store and broker.
          The account&apos;s IAM roles can allow access to several Projects.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
