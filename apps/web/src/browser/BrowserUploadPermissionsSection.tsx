import { useCallback, useEffect, useState } from "react";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  decodeBrowserUploadPermissionsCommand,
  type BrowserUploadPermissionsCommand,
  type BrowserUploadPermissionsResult,
} from "@octant/contracts/browser-upload-permissions";
import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import { browserProfileKey } from "@octant/domain";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantAlert } from "../ui/base/OctantAlert";

type Targets = Extract<
  BrowserUploadPermissionsResult,
  { readonly kind: "upload-permission-targets" }
>["targets"];
type Permissions = Extract<
  BrowserUploadPermissionsResult,
  { readonly kind: "upload-permissions" }
>["permissions"];
type Review = Extract<
  BrowserUploadPermissionsResult,
  { readonly kind: "upload-permission-review" }
>;
const mebibytes = (bytes: number) => `${Number((bytes / 1_048_576).toFixed(2))} MiB`;

export function BrowserUploadPermissionsSection(props: {
  readonly client: Pick<BrowserAutomationClient, "manageUploadPermissions">;
  readonly profiles: ReadonlyArray<BrowserProfileSummary>;
  readonly focusedSetting?: string | undefined;
}) {
  const manage = props.client.manageUploadPermissions;
  const [targets, setTargets] = useState<Targets>([]);
  const [permissions, setPermissions] = useState<Permissions>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [origin, setOrigin] = useState("");
  const [paths, setPaths] = useState("");
  const [maxFiles, setMaxFiles] = useState("5");
  const [maxMiB, setMaxMiB] = useState("125");
  const [duration, setDuration] = useState("10080");
  const [review, setReview] = useState<Review>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (manage === undefined) return;
      try {
        const [targetResult, permissionResult] = await Promise.all([
          manage({ kind: "targets" }, signal),
          manage({ kind: "list" }, signal),
        ]);
        if (signal?.aborted) return;
        if (
          targetResult.kind !== "upload-permission-targets" ||
          permissionResult.kind !== "upload-permissions"
        ) {
          setError("Recurring upload permissions are unavailable on this host.");
          return;
        }
        setTargets(targetResult.targets);
        setPermissions(permissionResult.permissions);
        setLoaded(true);
      } catch {
        if (!signal?.aborted) setError("Upload permissions could not be loaded. Refresh to retry.");
      }
    },
    [manage],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setTargets([]);
    setPermissions([]);
    setReview(undefined);
    setEditing(false);
    setError(undefined);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  if (manage === undefined) return null;
  const chosen = targets.find(
    (row) =>
      row.target.grantee.kind === "routine" && String(row.target.grantee.routineId) === targetId,
  );
  const profile = props.profiles.find((row) => browserProfileKey(row.profile) === profileId);
  const profileChoices = props.profiles.filter(
    (row) =>
      row.profile.kind !== "project" ||
      String(row.profile.projectId) === String(chosen?.target.authority.projectId),
  );
  const act = async (command: BrowserUploadPermissionsCommand) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await manage(command);
      if (result.kind === "upload-permission-refused") {
        setError(result.message);
        if (command.kind === "grant") setReview(undefined);
        return;
      }
      if (result.kind === "upload-permission-review") {
        setReview(result);
        return;
      }
      if (result.kind === "upload-permission-granted") {
        setReview(undefined);
        setEditing(false);
        setNotice("Upload manifest granted. It grants no account access and starts no routine.");
      }
      if (result.kind === "upload-permission-revoked")
        setNotice(
          "Upload permission revoked. An affected page closes; data already given to the site cannot be recalled.",
        );
      await refresh();
    } catch {
      setError("The result could not be confirmed. Refresh permissions before retrying.");
    } finally {
      setPending(false);
    }
  };
  const startReview = () => {
    if (chosen?.target.grantee.kind !== "routine" || profile === undefined) return;
    try {
      void act(
        decodeBrowserUploadPermissionsCommand({
          kind: "review",
          routineId: chosen.target.grantee.routineId,
          profile: profile.profile,
          folderId,
          origin,
          files: paths
            .split(/\r?\n/)
            .map((path) => path.trim())
            .filter(Boolean),
          maxFiles: Number(maxFiles),
          maxBytes: Number(maxMiB) * 1_048_576,
          durationMinutes: Number(duration),
        }),
      );
    } catch {
      setError("Check the HTTPS origin, relative paths, quotas and expiry.");
    }
  };
  return (
    <SettingsSection title="Recurring uploads">
      <SettingRow
        label="Upload manifests"
        scope="host"
        settingId="browser-upload-permissions"
        focused={props.focusedSetting === "browser-upload-permissions"}
        description="Permit exact file contents from an approved folder for one routine, profile and HTTPS site. Account access stays separate."
      >
        <div className="host-settings__controls">
          <OctantButton
            size="sm"
            variant="secondary"
            disabled={!loaded || targets.length === 0 || props.profiles.length === 0 || pending}
            onClick={() => {
              setEditing(true);
              setReview(undefined);
              setError(undefined);
            }}
          >
            New upload manifest…
          </OctantButton>
          <OctantButton
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setError(undefined);
              void refresh();
            }}
          >
            Refresh upload permissions
          </OctantButton>
        </div>
      </SettingRow>
      {!loaded && error === undefined ? (
        <SettingsState kind="loading">Loading upload permissions…</SettingsState>
      ) : null}
      {loaded && targets.length === 0 ? (
        <SettingsState kind="empty">
          No eligible local Work or Code routine in this Project. Reviewing a manifest starts
          nothing.
        </SettingsState>
      ) : null}
      {loaded && permissions.length === 0 ? (
        <SettingsState kind="empty">No recurring upload permissions.</SettingsState>
      ) : null}
      {permissions.map(({ permission, remainingFiles, remainingBytes }) => (
        <SettingRow
          key={permission.permissionId}
          settingId="browser-upload-permissions"
          label={`${permission.target.label} · ${permission.folder.label}`}
          scope="host"
          description={`${permission.origin} · ${remainingFiles} file uses and ${mebibytes(remainingBytes)} remaining · Expires ${new Date(permission.expiresAt).toLocaleString()}`}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <p className="break-all">
              {permission.files.map((file) => String(file.path)).join(", ")}
            </p>
            <OctantButton
              size="sm"
              variant="secondary"
              disabled={pending}
              aria-label={`Revoke upload permission for ${permission.target.label}`}
              onClick={() => void act({ kind: "revoke", permissionId: permission.permissionId })}
            >
              Revoke upload permission
            </OctantButton>
          </div>
        </SettingRow>
      ))}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {!editing && error !== undefined ? <OctantAlert tone="danger">{error}</OctantAlert> : null}
      {!editing ? null : (
        <OctantConfirmDialog
          children="Review one routine’s exact files and limits before granting upload permission."
          title={
            review === undefined ? "Review recurring upload files" : "Grant this upload manifest?"
          }
          confirmLabel={review === undefined ? "Review files" : "Grant upload manifest"}
          pending={pending}
          confirmDisabled={
            review === undefined &&
            (chosen === undefined ||
              profile === undefined ||
              folderId === "" ||
              origin.trim() === "" ||
              paths.trim() === "")
          }
          onCancel={() => {
            if (!pending) {
              setEditing(false);
              setReview(undefined);
            }
          }}
          onConfirm={() =>
            review === undefined
              ? startReview()
              : void act({ kind: "grant", reviewId: review.reviewId })
          }
          details={
            <div className="flex min-w-0 flex-col gap-3">
              {review === undefined ? (
                <>
                  <label>
                    Routine
                    <OctantSelectField
                      aria-label="Upload routine"
                      value={targetId}
                      placeholder="Choose a routine"
                      onValueChange={(value) => {
                        setTargetId(value);
                        setFolderId("");
                        setProfileId("");
                      }}
                      options={targets.flatMap((row) =>
                        row.target.grantee.kind === "routine"
                          ? [{ id: String(row.target.grantee.routineId), label: row.target.label }]
                          : [],
                      )}
                    />
                  </label>
                  <label>
                    Account profile
                    <OctantSelectField
                      aria-label="Upload account profile"
                      value={profileId}
                      placeholder="Choose an account profile"
                      onValueChange={setProfileId}
                      options={profileChoices.map((row) => ({
                        id: browserProfileKey(row.profile),
                        label: row.label,
                      }))}
                    />
                  </label>
                  <label>
                    Source folder
                    <OctantSelectField
                      aria-label="Upload source folder"
                      value={folderId}
                      placeholder="Choose an approved folder"
                      onValueChange={setFolderId}
                      options={(chosen?.folders ?? []).map((row) => ({
                        id: String(row.id),
                        label: row.label,
                      }))}
                    />
                  </label>
                  <label>
                    HTTPS site
                    <OctantInput
                      aria-label="Upload HTTPS site"
                      value={origin}
                      maxLength={2048}
                      placeholder="https://example.com"
                      onChange={(event) => setOrigin(event.target.value)}
                    />
                  </label>
                  <label>
                    Files, one relative path per line
                    <OctantTextarea
                      aria-label="Upload file paths"
                      value={paths}
                      maxLength={20_480}
                      rows={4}
                      onChange={(event) => setPaths(event.target.value)}
                    />
                  </label>
                  <p>
                    Choose up to five plain files, each at most 25 MiB. Paths are relative to the
                    selected approved folder. Contents and file identity are checked again on every
                    upload.
                  </p>
                  <label>
                    Total file uses
                    <OctantInput
                      aria-label="Total upload file uses"
                      type="number"
                      min={1}
                      max={100}
                      value={maxFiles}
                      onChange={(event) => setMaxFiles(event.target.value)}
                    />
                  </label>
                  <label>
                    Total file contents, MiB
                    <OctantInput
                      aria-label="Total upload MiB"
                      type="number"
                      min={1}
                      max={250}
                      value={maxMiB}
                      onChange={(event) => setMaxMiB(event.target.value)}
                    />
                  </label>
                  <label>
                    Expiry
                    <OctantSelectField
                      aria-label="Upload permission expiry"
                      value={duration}
                      onValueChange={setDuration}
                      options={[
                        { id: "60", label: "1 hour" },
                        { id: "10080", label: "7 days" },
                        { id: "43200", label: "30 days" },
                      ]}
                    />
                  </label>
                </>
              ) : (
                <dl className="grid min-w-0 gap-2">
                  <dt>Routine</dt>
                  <dd>{review.permission.target.label}</dd>
                  <dt>Model</dt>
                  <dd>{review.permission.target.modelId}</dd>
                  <dt>Account profile</dt>
                  <dd>
                    {props.profiles.find(
                      (row) =>
                        browserProfileKey(row.profile) ===
                        browserProfileKey(review.permission.profile),
                    )?.label ?? review.permission.profile.kind}
                  </dd>
                  <dt>Source folder</dt>
                  <dd>{review.permission.folder.label}</dd>
                  <dt>HTTPS site</dt>
                  <dd className="break-all">{review.permission.origin}</dd>
                  <dt>Exact files</dt>
                  <dd>
                    <ul>
                      {review.permission.files.map((file) => (
                        <li className="break-all" key={String(file.path)}>
                          {file.path} · {mebibytes(file.sizeBytes)} ·{" "}
                          {file.fileType || "No extension"}
                        </li>
                      ))}
                    </ul>
                  </dd>
                  <dt>Total quota</dt>
                  <dd>
                    {review.permission.maxFiles} file uses · {mebibytes(review.permission.maxBytes)}
                  </dd>
                  <dt>Expires</dt>
                  <dd>{new Date(review.permission.expiresAt).toLocaleString()}</dd>
                </dl>
              )}
              <p>
                Each admitted file consumes quota, including a later cancellation. Permission ends
                on revocation, changed routine authority or host restart. Revoking closes an
                affected page but cannot recall data already given to the site. This manifest grants
                no account access, downloads or other files.
              </p>
              {error === undefined ? null : <OctantAlert tone="danger">{error}</OctantAlert>}
            </div>
          }
        />
      )}
    </SettingsSection>
  );
}
