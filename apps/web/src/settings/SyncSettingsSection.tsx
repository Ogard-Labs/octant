import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ReplicaStoreSettingsClient } from "@octant/client-runtime/replica-store-settings-client";
import {
  ReplicaStoreS3Endpoint,
  decodeReplicaStoreS3Settings,
  type ReplicaStoreS3Addressing,
  type ReplicaStoreS3Settings,
  type ReplicaStoreSettingsCommand,
  type ReplicaStoreSettingsResult,
  type ReplicaStoreSettingsView,
} from "@octant/contracts/replica-store-settings";
import { Schema } from "effect";
import { useCallback, useEffect, useId, useState } from "react";
import { FolderPicker } from "../projects/FolderPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

type StoreKind = ReplicaStoreSettingsView["store"]["kind"];

const isHttpsEndpoint = Schema.is(ReplicaStoreS3Endpoint);

/**
 * The fact the sync guide requires Settings to state before the switch can be
 * turned on (decision 0163). It sits above the switch and describes it.
 */
export const SYNC_PROVIDER_FACT =
  "Your storage provider can read the synced files: they are signed but not encrypted.";

const STORE_OPTIONS: ReadonlyArray<{ readonly id: StoreKind; readonly label: string }> = [
  { id: "none", label: "None" },
  { id: "synced-folder", label: "Synced folder" },
  { id: "s3", label: "S3-compatible bucket" },
];

export interface SyncSettingsSectionProps {
  /** Absent off this host: store setup is host authority. */
  readonly client: ReplicaStoreSettingsClient | undefined;
  /** The host's folder browser, for choosing a synced folder. */
  readonly folderBrowse: Pick<FolderBrowseClient, "browse"> | undefined;
  readonly focusedSetting?: string | undefined;
}

/**
 * Settings › Sync: which store artifact versions go to, and the switch.
 *
 * The host owns the choice and its version. This reads them, sends back a
 * folder only as a candidate the host's browser listed, and sends a bucket's
 * key pair once, inside the command that saves it; the fields are emptied as
 * soon as the host answers, so the secret does not stay in the page.
 */
export function SyncSettingsSection(props: SyncSettingsSectionProps) {
  const { client } = props;
  const factId = useId();
  const [view, setView] = useState<ReplicaStoreSettingsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [draftKind, setDraftKind] = useState<StoreKind>("none");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [connection, setConnection] = useState<
    Extract<ReplicaStoreSettingsResult, { kind: "replica-store-connection-tested" }> | undefined
  >();
  const [pickingFolder, setPickingFolder] = useState(false);

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      const next = await client.read();
      setView(next);
      setDraftKind(next.store.kind);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one command; answers whether the host took it. */
  const run = useCallback(
    async (command: ReplicaStoreSettingsCommand): Promise<boolean> => {
      if (client === undefined) return false;
      setBusy(true);
      setProblem(undefined);
      try {
        const result = await client.execute(command);
        if (result.kind === "replica-store-refused") {
          setProblem(result.message);
          // A stale version means another window moved the settings on.
          if (result.reason === "stale-version") await load();
          return false;
        }
        if (result.kind === "replica-store-connection-tested") {
          setConnection(result);
          return true;
        }
        setView(result);
        setDraftKind(result.store.kind);
        setConnection(undefined);
        return true;
      } catch (error) {
        setProblem(error instanceof Error ? error.message : "Sync settings are unavailable.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, load],
  );

  if (client === undefined) {
    return (
      <SettingsSection
        description="Choosing a store and turning sync on happen in the Octant app on the host machine."
        id="settings-sync"
        title="Store"
      />
    );
  }
  if (view === undefined) {
    return (
      <SettingsSection id="settings-sync" title="Store">
        <SettingsState kind={loadFailed ? "error" : "loading"}>
          {loadFailed
            ? "Sync settings could not be read from this host."
            : "Reading sync settings…"}
        </SettingsState>
      </SettingsSection>
    );
  }

  const store = view.store;
  const canTurnOn =
    store.kind === "synced-folder" || (store.kind === "s3" && store.credentials === "saved");
  const switchDisabled = busy || (!view.syncOn && !canTurnOn);

  return (
    <div className="settings-section-stack" id="settings-sync">
      <SettingsSection
        description="A folder your sync client watches, or an S3-compatible bucket you own. Octant runs no store of its own."
        title="Store"
      >
        <div className="setgroup">
          <SettingRow
            description="Changing the store turns sync off."
            focused={props.focusedSetting === "sync-store"}
            label="Store"
            labelledBySection
            scope="host"
            settingId="sync-store"
          >
            <OctantSelectField
              aria-label="Store"
              disabled={busy}
              onValueChange={(value) => {
                const kind = STORE_OPTIONS.find((option) => option.id === value)?.id;
                if (kind === undefined) return;
                setProblem(undefined);
                setDraftKind(kind);
                if (kind === "none" && view.store.kind !== "none") {
                  const current = view.store.kind;
                  void run({
                    schemaVersion: 1,
                    kind: "clear-store",
                    expectedVersion: view.version,
                  }).then((accepted) => {
                    if (!accepted) setDraftKind(current);
                  });
                }
              }}
              options={STORE_OPTIONS}
              value={draftKind}
            />
          </SettingRow>
          {draftKind === "synced-folder" ? (
            <SettingRow
              description="Octant writes only inside an Octant Sync folder in it."
              label="Folder"
              scope="host"
              settingId="sync-folder"
            >
              <div className="sync-settings__folder">
                {store.kind === "synced-folder" ? (
                  <code className="sync-settings__path" title={store.folder}>
                    {homeRelativePath(store.folder)}
                  </code>
                ) : (
                  <span className="sync-settings__path">No folder chosen</span>
                )}
                <OctantButton
                  disabled={busy || props.folderBrowse === undefined}
                  onClick={() => setPickingFolder(true)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Choose folder…
                </OctantButton>
              </div>
            </SettingRow>
          ) : null}
          {draftKind === "s3" ? (
            <SettingRow
              description="The access key and secret are kept in Keychain or Secret Service, never in a file."
              label="Bucket"
              scope="host"
              settingId="sync-bucket"
            >
              <BucketForm
                busy={busy}
                credentialStoreAvailable={view.credentialStore === "available"}
                onSave={(settings, credentials) =>
                  run({
                    schemaVersion: 1,
                    kind: "configure-s3",
                    settings,
                    ...(credentials === undefined ? {} : { credentials }),
                    expectedVersion: view.version,
                  })
                }
                saved={store.kind === "s3" ? store : undefined}
              />
            </SettingRow>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        description={<span id={factId}>{SYNC_PROVIDER_FACT}</span>}
        title="Sync artifacts"
      >
        <div className="setgroup">
          <SettingRow
            description="In this preview, sync on lets Octant reach the store; artifact versions are not copied yet."
            focused={props.focusedSetting === "sync-enabled"}
            label="Sync artifacts"
            labelledBySection
            scope="host"
            settingId="sync-enabled"
          >
            <OctantSwitch
              checked={view.syncOn}
              describedBy={factId}
              disabled={switchDisabled}
              disabledReason={
                store.kind === "s3" ? "Save the access key first." : "Choose a store first."
              }
              label="Sync artifacts"
              onCheckedChange={(syncOn) =>
                void run({
                  schemaVersion: 1,
                  kind: "set-sync",
                  syncOn,
                  expectedVersion: view.version,
                })
              }
            />
          </SettingRow>
          <SettingRow
            description="Writes one small probe file to the store and deletes nothing."
            focused={props.focusedSetting === "sync-test-connection"}
            label="Test connection"
            scope="host"
            settingId="sync-test-connection"
          >
            <OctantButton
              disabled={busy || !view.syncOn}
              onClick={() => void run({ schemaVersion: 1, kind: "test-connection" })}
              size="sm"
              title={view.syncOn ? undefined : "Turn sync on to test the connection."}
              type="button"
              variant="secondary"
            >
              Test connection
            </OctantButton>
          </SettingRow>
        </div>
        <div aria-live="polite" className="settings-feedback-slot">
          {connection === undefined ? null : (
            <SettingsState kind={connection.outcome === "reachable" ? "success" : "error"}>
              {connection.message}
            </SettingsState>
          )}
          {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
        </div>
      </SettingsSection>

      {pickingFolder && props.folderBrowse !== undefined ? (
        <FolderPicker
          client={props.folderBrowse}
          hint="Pick a folder your sync client watches. Octant writes inside an Octant Sync folder there."
          hostId={view.hostId}
          mode={view.mode}
          onCancel={() => setPickingFolder(false)}
          onSelectCandidate={(candidate) => {
            setPickingFolder(false);
            void run({
              schemaVersion: 1,
              kind: "choose-synced-folder",
              mode: view.mode,
              candidateId: candidate.candidateId,
              expectedVersion: view.version,
            });
          }}
          showGitInit={false}
          title="Sync folder"
        />
      ) : null}
    </div>
  );
}

function BucketForm(props: {
  readonly busy: boolean;
  readonly credentialStoreAvailable: boolean;
  readonly saved: Extract<ReplicaStoreSettingsView["store"], { readonly kind: "s3" }> | undefined;
  readonly onSave: (
    settings: ReplicaStoreS3Settings,
    credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined,
  ) => Promise<boolean>;
}) {
  const saved = props.saved?.settings;
  const [endpoint, setEndpoint] = useState(saved?.endpoint ?? "");
  const [region, setRegion] = useState(saved?.region ?? "");
  const [bucket, setBucket] = useState(saved?.bucket ?? "");
  const [prefix, setPrefix] = useState(saved?.prefix ?? "");
  const [addressing, setAddressing] = useState<ReplicaStoreS3Addressing>(
    saved?.addressing ?? "path",
  );
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [problem, setProblem] = useState<string>();
  const keySaved = props.saved?.credentials === "saved";

  const submit = async () => {
    if (!isHttpsEndpoint(endpoint.trim())) {
      setProblem("The endpoint must be an https address with no path.");
      return;
    }
    let settings: ReplicaStoreS3Settings;
    try {
      settings = decodeReplicaStoreS3Settings({
        endpoint: endpoint.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
        ...(prefix.trim() === "" ? {} : { prefix: prefix.trim() }),
        addressing,
      });
    } catch {
      setProblem(
        "Check the region, bucket, and prefix. A virtual-host bucket name must be lowercase.",
      );
      return;
    }
    const typedKey = accessKeyId.trim() !== "" || secretAccessKey !== "";
    if (typedKey && (accessKeyId.trim() === "" || secretAccessKey === "")) {
      setProblem("Enter both the access key and the secret.");
      return;
    }
    if (!typedKey && !keySaved) {
      setProblem("Enter the access key and secret for this bucket.");
      return;
    }
    setProblem(undefined);
    await props.onSave(
      settings,
      typedKey ? { accessKeyId: accessKeyId.trim(), secretAccessKey } : undefined,
    );
    // The host has the key pair now, or refused it; either way the page lets
    // go of the secret rather than holding it for a retry.
    setAccessKeyId("");
    setSecretAccessKey("");
  };

  return (
    <form
      aria-label="Bucket connection"
      className="voice-settings__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Endpoint</span>
        <OctantInput
          aria-label="Endpoint"
          autoComplete="off"
          className="settings-view__text-input"
          onChange={(event) => setEndpoint(event.currentTarget.value)}
          placeholder="https://s3.eu-north-1.amazonaws.com"
          spellCheck={false}
          value={endpoint}
        />
      </label>
      <label>
        <span>Region</span>
        <OctantInput
          aria-label="Region"
          autoComplete="off"
          className="settings-view__text-input"
          onChange={(event) => setRegion(event.currentTarget.value)}
          placeholder="eu-north-1"
          spellCheck={false}
          value={region}
        />
      </label>
      <label>
        <span>Bucket</span>
        <OctantInput
          aria-label="Bucket"
          autoComplete="off"
          className="settings-view__text-input"
          onChange={(event) => setBucket(event.currentTarget.value)}
          spellCheck={false}
          value={bucket}
        />
      </label>
      <label>
        <span>Prefix (optional)</span>
        <OctantInput
          aria-label="Prefix"
          autoComplete="off"
          className="settings-view__text-input"
          onChange={(event) => setPrefix(event.currentTarget.value)}
          placeholder="octant"
          spellCheck={false}
          value={prefix}
        />
      </label>
      <label>
        <span>Addressing</span>
        <OctantSelectField
          aria-label="Addressing"
          className="settings-view__select"
          onValueChange={(value) => {
            if (value === "path" || value === "virtual-host") setAddressing(value);
          }}
          options={[
            { id: "path", label: "Path-style" },
            { id: "virtual-host", label: "Virtual-host" },
          ]}
          value={addressing}
        />
      </label>
      <label>
        <span>Access key ID</span>
        <OctantInput
          aria-label="Access key ID"
          autoComplete="off"
          className="settings-view__text-input"
          disabled={!props.credentialStoreAvailable}
          onChange={(event) => setAccessKeyId(event.currentTarget.value)}
          placeholder={keySaved ? "Saved — leave blank to keep" : undefined}
          spellCheck={false}
          value={accessKeyId}
        />
      </label>
      <label>
        <span>Secret access key</span>
        <OctantInput
          aria-label="Secret access key"
          autoComplete="new-password"
          className="settings-view__text-input"
          disabled={!props.credentialStoreAvailable}
          onChange={(event) => setSecretAccessKey(event.currentTarget.value)}
          placeholder={keySaved ? "Saved — leave blank to keep" : undefined}
          spellCheck={false}
          type="password"
          value={secretAccessKey}
        />
      </label>
      {props.credentialStoreAvailable ? null : (
        <p className="provider-settings__field-guidance">
          This host has no credential store, so a bucket&apos;s key cannot be saved here.
        </p>
      )}
      {problem === undefined ? null : (
        /* ui-boundary-exception: inline-field-error */
        <p className="provider-settings__field-guidance" role="alert">
          {problem}
        </p>
      )}
      <div className="settings-view__actions">
        <OctantButton
          disabled={props.busy || !props.credentialStoreAvailable}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}

/** The folder sits inside home; the home prefix is what the ellipsis would eat. */
function homeRelativePath(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
