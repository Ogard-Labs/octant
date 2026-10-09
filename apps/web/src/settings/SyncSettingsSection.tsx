import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ReplicaMembershipClient } from "@octant/client-runtime/replica-membership-client";
import type { ReplicaSyncStatusClient } from "@octant/client-runtime/replica-sync-status-client";
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
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FolderPicker } from "../projects/FolderPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";
import { SyncMembershipSections, SyncStatusReadOnly } from "./SyncMembershipSections";

type StoreKind = ReplicaStoreSettingsView["store"]["kind"];

const isHttpsEndpoint = Schema.is(ReplicaStoreS3Endpoint);

/**
 * The fact the sync guide requires Settings to state before the switch can be
 * turned on (decision 0163). It sits above the switch and describes it.
 */
export const SYNC_PROVIDER_FACT =
  "Your storage provider can read the synced files: they are signed but not encrypted.";

/** Why the store controls are off on a computer that belongs to a replica. */
export const REPLICA_MEMBER_LOCK =
  "This computer belongs to a replica in this store. The store can't be changed until leaving a replica is supported.";

const STORE_OPTIONS: ReadonlyArray<{ readonly id: StoreKind; readonly label: string }> = [
  { id: "none", label: "None" },
  { id: "synced-folder", label: "Synced folder" },
  { id: "s3", label: "S3-compatible bucket" },
];

/** A command's answer as the page needs it: taken, or the host's reason why not. */
type CommandOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "refused"; readonly message: string };

export interface SyncSettingsSectionProps {
  /** Absent off this host: store setup is host authority. */
  readonly client: ReplicaStoreSettingsClient | undefined;
  /** The host's folder browser, for choosing a synced folder. */
  readonly folderBrowse: Pick<FolderBrowseClient, "browse"> | undefined;
  readonly focusedSetting?: string | undefined;
  /** Absent off this host: setting up, joining, and revoking are host authority. */
  readonly membership?: ReplicaMembershipClient | undefined;
  /** Read-only status, shown when this client is not on the host. */
  readonly status?: ReplicaSyncStatusClient | undefined;
}

/**
 * Settings › Sync: the store and the switch, then this computer's replica -
 * set up, join, approve, the computers in it, revoke - and status. Off the
 * host it shows status only.
 */
export function SyncSettingsSection(props: SyncSettingsSectionProps) {
  const [storeReady, setStoreReady] = useState(false);
  // Bumped when membership changes, so the store section re-reads its lock.
  const [membershipRevision, setMembershipRevision] = useState(0);
  const onMembershipChange = useCallback(() => setMembershipRevision((value) => value + 1), []);
  return (
    <div className="settings-section-stack" id="settings-sync">
      <SyncStoreSections
        {...props}
        membershipRevision={membershipRevision}
        onStoreReady={setStoreReady}
      />
      {props.client !== undefined && props.membership !== undefined ? (
        <SyncMembershipSections
          client={props.membership}
          onMembershipChange={onMembershipChange}
          storeReady={storeReady}
        />
      ) : props.client === undefined && props.status !== undefined ? (
        <SyncStatusReadOnly client={props.status} />
      ) : null}
    </div>
  );
}

/**
 * Which store artifact versions go to, and the switch.
 *
 * The host owns the choice and its version. This reads them, sends back a
 * folder only as a candidate the host's browser listed, and sends a bucket's
 * key pair once, inside the command that saves it; the fields are emptied as
 * soon as the host answers, so the secret does not stay in the page.
 */
function SyncStoreSections(
  props: SyncSettingsSectionProps & {
    readonly membershipRevision: number;
    readonly onStoreReady: (ready: boolean) => void;
  },
) {
  const { client, membershipRevision, onStoreReady } = props;
  const factId = useId();
  const testReasonId = useId();
  const [view, setView] = useState<ReplicaStoreSettingsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [draftKind, setDraftKind] = useState<StoreKind>("none");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [connection, setConnection] = useState<
    Extract<ReplicaStoreSettingsResult, { kind: "replica-store-connection-tested" }> | undefined
  >();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [confirmingNone, setConfirmingNone] = useState(false);
  // Kept here, not in the bucket form: the form is rebuilt from the host's
  // view after a reload, and the reason a save was refused must outlive that.
  const [bucketProblem, setBucketProblem] = useState<string>();

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
  }, [load, membershipRevision]);

  const ready = view !== undefined && view.store.kind !== "none" && view.syncOn;
  useEffect(() => onStoreReady(ready), [onStoreReady, ready]);

  /**
   * Runs one command. A refusal is shown in the section's feedback slot
   * unless the caller shows it where the person acted.
   */
  const run = useCallback(
    async (
      command: ReplicaStoreSettingsCommand,
      report: (message: string) => void = setProblem,
    ): Promise<CommandOutcome> => {
      if (client === undefined)
        return { status: "refused", message: "Sync settings are host-only." };
      setBusy(true);
      setProblem(undefined);
      // A bucket refusal belongs to the save that caused it, not to whatever
      // the person does next.
      setBucketProblem(undefined);
      let outcome: CommandOutcome;
      try {
        const result = await client.execute(command);
        if (result.kind === "replica-store-refused") {
          outcome = { status: "refused", message: result.message };
          // A stale version means another window moved the settings on; a
          // member lock means this page's view is out of date too.
          if (result.reason === "stale-version" || result.reason === "member-of-replica") {
            await load();
          }
        } else if (result.kind === "replica-store-connection-tested") {
          setConnection(result);
          outcome = { status: "accepted" };
        } else {
          setView(result);
          setDraftKind(result.store.kind);
          setConnection(undefined);
          outcome = { status: "accepted" };
        }
      } catch (error) {
        outcome = {
          status: "refused",
          message: error instanceof Error ? error.message : "Sync settings are unavailable.",
        };
      } finally {
        setBusy(false);
      }
      if (outcome.status === "refused") report(outcome.message);
      return outcome;
    },
    [client, load],
  );

  if (client === undefined) {
    return (
      <SettingsSection
        description="Choosing a store and turning sync on happen in the Octant app on the host machine."
        title="Store"
      />
    );
  }
  if (view === undefined) {
    return (
      <SettingsSection title="Store">
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
  const locked = view.replicaMember;
  const testDisabledReason = view.syncOn ? undefined : "Turn sync on to test the connection.";

  return (
    <>
      <SettingsSection
        description="A folder your sync client watches, or an S3-compatible bucket you own. Octant runs no store of its own."
        title="Store"
      >
        <div className="setgroup">
          <SettingRow
            description={locked ? REPLICA_MEMBER_LOCK : "Changing the store turns sync off."}
            focused={props.focusedSetting === "sync-store"}
            label="Store"
            labelledBySection
            scope="host"
            settingId="sync-store"
          >
            <OctantSelectField
              aria-label="Store"
              disabled={busy || locked}
              onValueChange={(value) => {
                const kind = STORE_OPTIONS.find((option) => option.id === value)?.id;
                if (kind === undefined) return;
                setProblem(undefined);
                setBucketProblem(undefined);
                // Choosing no store stops sync and forgets a bucket's key
                // pair, so it waits for a confirmation; until then the
                // current store stays selected.
                if (kind === "none" && view.store.kind !== "none") {
                  setConfirmingNone(true);
                  return;
                }
                setDraftKind(kind);
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
                  disabled={busy || locked || props.folderBrowse === undefined}
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
                hostProblem={bucketProblem}
                // Rebuilt from the host's view whenever it moves, so a reload
                // after a refusal shows what the host holds, not a stale draft.
                key={view.version}
                locked={locked}
                onSave={async (settings, credentials) => {
                  await run(
                    {
                      schemaVersion: 1,
                      kind: "configure-s3",
                      settings,
                      ...(credentials === undefined ? {} : { credentials }),
                      expectedVersion: view.version,
                    },
                    setBucketProblem,
                  );
                }}
                saved={store.kind === "s3" ? store : undefined}
                syncOn={view.syncOn}
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
                draftKind === "s3"
                  ? "Save the bucket and its access key first."
                  : draftKind === "synced-folder"
                    ? "Choose a folder first."
                    : "Choose a store first."
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
            {/* Focusable while off, so its reason reaches keyboard and screen
                reader users the way the switch's does. */}
            <OctantButton
              aria-describedby={testDisabledReason === undefined ? undefined : testReasonId}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              disabled={busy || !view.syncOn}
              focusableWhenDisabled
              onClick={() => void run({ schemaVersion: 1, kind: "test-connection" })}
              size="sm"
              title={testDisabledReason}
              type="button"
              variant="secondary"
            >
              Test connection
            </OctantButton>
            {testDisabledReason === undefined ? null : (
              <span className="sr-only" id={testReasonId}>
                {testDisabledReason}
              </span>
            )}
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

      {confirmingNone ? (
        <OctantConfirmDialog
          confirmLabel="Stop syncing"
          destructive
          onCancel={() => setConfirmingNone(false)}
          onConfirm={() => {
            setConfirmingNone(false);
            const current = view.store.kind;
            setDraftKind("none");
            void run({
              schemaVersion: 1,
              kind: "clear-store",
              expectedVersion: view.version,
            }).then((outcome) => {
              if (outcome.status === "refused") setDraftKind(current);
            });
          }}
          pending={busy}
          title="Choose no store?"
        >
          {view.store.kind === "s3"
            ? "Sync stops, and this bucket's saved access key and secret are removed from this computer. Nothing in the bucket is deleted."
            : "Sync stops, and Octant stops using this folder. Nothing in the folder is deleted."}
        </OctantConfirmDialog>
      ) : null}

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
          showMode={false}
          title="Sync folder"
        />
      ) : null}
    </>
  );
}

function BucketForm(props: {
  readonly busy: boolean;
  readonly credentialStoreAvailable: boolean;
  /** The host's reason the last save was refused. */
  readonly hostProblem: string | undefined;
  /** This computer belongs to a replica: only the key pair and region can change. */
  readonly locked: boolean;
  readonly saved: Extract<ReplicaStoreSettingsView["store"], { readonly kind: "s3" }> | undefined;
  readonly syncOn: boolean;
  readonly onSave: (
    settings: ReplicaStoreS3Settings,
    credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined,
  ) => Promise<void>;
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
  const problemRef = useRef<HTMLParagraphElement>(null);
  const shownProblem = problem ?? props.hostProblem;
  // The saved key pair belongs to one server: a different endpoint, bucket,
  // or addressing is a different server, and the host asks for a new pair.
  const sameServer =
    saved !== undefined &&
    endpoint.trim() === saved.endpoint &&
    bucket.trim() === saved.bucket &&
    addressing === saved.addressing;
  const keyKept = props.saved?.credentials === "saved" && sameServer;
  const unchanged =
    sameServer && region.trim() === saved.region && (prefix.trim() || undefined) === saved.prefix;
  const fieldsOff = !props.credentialStoreAvailable;
  const locationOff = fieldsOff || props.locked;

  useEffect(() => {
    if (shownProblem !== undefined) problemRef.current?.focus();
  }, [shownProblem]);

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
        "Check the region, bucket, and prefix. Virtual-host addressing needs a lowercase bucket name and an endpoint with a DNS name, not an IP address.",
      );
      return;
    }
    const typedKey = accessKeyId.trim() !== "" || secretAccessKey !== "";
    if (typedKey && (accessKeyId.trim() === "" || secretAccessKey === "")) {
      setProblem("Enter both the access key and the secret.");
      return;
    }
    if (!typedKey && !keyKept) {
      setProblem(
        props.saved === undefined
          ? "Enter the access key and secret for this bucket."
          : "A different endpoint, bucket, or addressing needs its own access key and secret.",
      );
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
      className="sync-settings__bucket-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.credentialStoreAvailable ? null : (
        <p className="provider-settings__field-guidance">
          Octant cannot reach a Keychain or Secret Service on this computer to keep a bucket&apos;s
          access key in, so a bucket cannot be saved here. A synced folder still works.
        </p>
      )}
      <label>
        <span>Endpoint</span>
        <OctantInput
          aria-label="Endpoint"
          autoComplete="off"
          className="settings-view__text-input"
          disabled={locationOff}
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
          disabled={fieldsOff}
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
          disabled={locationOff}
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
          disabled={locationOff}
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
          disabled={locationOff}
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
          disabled={fieldsOff}
          onChange={(event) => setAccessKeyId(event.currentTarget.value)}
          placeholder={keyKept ? "Saved — leave blank to keep" : undefined}
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
          disabled={fieldsOff}
          onChange={(event) => setSecretAccessKey(event.currentTarget.value)}
          placeholder={keyKept ? "Saved — leave blank to keep" : undefined}
          spellCheck={false}
          type="password"
          value={secretAccessKey}
        />
      </label>
      {props.saved?.credentials === "saved" && !sameServer ? (
        <p className="provider-settings__field-guidance">
          A different endpoint, bucket, or addressing needs its own access key and secret.
        </p>
      ) : null}
      {props.syncOn && !unchanged ? (
        <p className="provider-settings__field-guidance">Saving turns sync off.</p>
      ) : null}
      {shownProblem === undefined ? null : (
        /* ui-boundary-exception: inline-field-error */
        <p
          className="provider-settings__field-guidance"
          ref={problemRef}
          role="alert"
          tabIndex={-1}
        >
          {shownProblem}
        </p>
      )}
      <div className="settings-view__actions">
        <OctantButton
          disabled={props.busy || fieldsOff}
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
