import { useCallback, useEffect, useState } from "react";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  decodeBrowserDownloadPermissionsCommand,
  type BrowserDownloadPermissionsCommand,
  type BrowserDownloadPermissionsResult,
} from "@octant/contracts/browser-download-permissions";
import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import { browserProfileKey } from "@octant/domain";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantAlert } from "../ui/base/OctantAlert";

type Targets = Extract<
  BrowserDownloadPermissionsResult,
  { readonly kind: "download-permission-targets" }
>["targets"];
type Permissions = Extract<
  BrowserDownloadPermissionsResult,
  { readonly kind: "download-permissions" }
>["permissions"];
type Review = Extract<
  BrowserDownloadPermissionsResult,
  { readonly kind: "download-permission-review" }
>;
const DOWNLOAD_TYPES = [
  ["text/plain", "Text and CSV"],
  ["application/pdf", "PDF"],
  ["image/png", "PNG images"],
  ["image/jpeg", "JPEG images"],
  ["image/gif", "GIF images"],
  ["image/webp", "WebP images"],
  ["application/zip", "ZIP archives"],
  ["application/gzip", "Gzip archives"],
  ["text/html", "HTML documents"],
  ["application/xml", "XML documents"],
] as const;
const mebibytes = (bytes: number) => `${Number((bytes / 1_048_576).toFixed(2))} MiB`;

export function BrowserDownloadPermissionsSection(props: {
  readonly client: Pick<BrowserAutomationClient, "manageDownloadPermissions">;
  readonly profiles: ReadonlyArray<BrowserProfileSummary>;
  readonly focusedSetting?: string | undefined;
}) {
  const manage = props.client.manageDownloadPermissions;
  const [targets, setTargets] = useState<Targets>([]);
  const [permissions, setPermissions] = useState<Permissions>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [origin, setOrigin] = useState("");
  const [sources, setSources] = useState("");
  const [directory, setDirectory] = useState(".");
  const [mediaTypes, setMediaTypes] = useState<ReadonlyArray<string>>([
    "text/plain",
    "application/pdf",
  ]);
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
          targetResult.kind !== "download-permission-targets" ||
          permissionResult.kind !== "download-permissions"
        ) {
          setError("Recurring download permissions are unavailable on this host.");
          return;
        }
        setTargets(targetResult.targets);
        setPermissions(permissionResult.permissions);
        setLoaded(true);
      } catch {
        if (!signal?.aborted)
          setError("Download permissions could not be loaded. Refresh to retry.");
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
  const act = async (command: BrowserDownloadPermissionsCommand) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await manage(command);
      if (result.kind === "download-permission-refused") {
        setError(result.message);
        if (command.kind === "grant") setReview(undefined);
        return;
      }
      if (result.kind === "download-permission-review") {
        setReview(result);
        return;
      }
      if (result.kind === "download-permission-granted") {
        setReview(undefined);
        setEditing(false);
        setNotice("Download manifest granted. It grants no account access and starts no routine.");
      }
      if (result.kind === "download-permission-revoked")
        setNotice(
          "Download permission revoked. An affected page closes; a file already dispatched may have been saved; check the destination before retrying.",
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
        decodeBrowserDownloadPermissionsCommand({
          kind: "review",
          routineId: chosen.target.grantee.routineId,
          profile: profile.profile,
          folderId,
          origin,
          sourceOrigins: sources
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          directory,
          mediaTypes,
          maxFiles: Number(maxFiles),
          maxBytes: Number(maxMiB) * 1_048_576,
          durationMinutes: Number(duration),
        }),
      );
    } catch {
      setError("Check exact HTTPS sites, the relative destination, file types, quotas and expiry.");
    }
  };
  return (
    <SettingsSection title="Recurring downloads">
      <SettingRow
        label="Download manifests"
        scope="host"
        settingId="browser-download-permissions"
        focused={props.focusedSetting === "browser-download-permissions"}
        description="Save known native source chains into one approved directory for a routine and account profile. Account access stays separate."
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
            New download manifest…
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
            Refresh download permissions
          </OctantButton>
        </div>
      </SettingRow>
      {!loaded && error === undefined ? (
        <SettingsState kind="loading">Loading download permissions…</SettingsState>
      ) : null}
      {loaded && targets.length === 0 ? (
        <SettingsState kind="empty">
          No eligible local Work or Code routine in this Project. Reviewing a manifest starts
          nothing.
        </SettingsState>
      ) : null}
      {loaded && permissions.length === 0 ? (
        <SettingsState kind="empty">No recurring download permissions.</SettingsState>
      ) : null}
      {permissions.map(({ permission, remainingFiles, remainingBytes }) => (
        <SettingRow
          key={permission.permissionId}
          settingId="browser-download-permissions"
          label={`${permission.target.label} · ${permission.folder.label}`}
          scope="host"
          description={`${permission.origin} · ${remainingFiles} file uses and ${mebibytes(remainingBytes)} remaining · Expires ${new Date(permission.expiresAt).toLocaleString()}`}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <p className="break-all">
              {permission.directory} · {permission.mediaTypes.join(", ")}
            </p>
            <OctantButton
              size="sm"
              variant="secondary"
              disabled={pending}
              aria-label={`Revoke download permission for ${permission.target.label}`}
              onClick={() => void act({ kind: "revoke", permissionId: permission.permissionId })}
            >
              Revoke download permission
            </OctantButton>
          </div>
        </SettingRow>
      ))}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {!editing && error !== undefined ? <OctantAlert tone="danger">{error}</OctantAlert> : null}
      <OctantDialogPresence>
        {!editing ? null : (
          <OctantConfirmDialog
            children="Review one routine’s source sites, destination, file types and limits before granting download permission."
            title={
              review === undefined ? "Review recurring downloads" : "Grant this download manifest?"
            }
            confirmLabel={
              review === undefined ? "Review sources and destination" : "Grant download manifest"
            }
            pending={pending}
            confirmDisabled={
              review === undefined &&
              (chosen === undefined ||
                profile === undefined ||
                folderId === "" ||
                origin.trim() === "" ||
                sources.trim() === "" ||
                directory.trim() === "" ||
                mediaTypes.length === 0)
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
                        aria-label="Download routine"
                        value={targetId}
                        placeholder="Choose a routine"
                        onValueChange={(value) => {
                          setTargetId(value);
                          setFolderId("");
                          setProfileId("");
                        }}
                        options={targets.flatMap((row) =>
                          row.target.grantee.kind === "routine"
                            ? [
                                {
                                  id: String(row.target.grantee.routineId),
                                  label: row.target.label,
                                },
                              ]
                            : [],
                        )}
                      />
                    </label>
                    <label>
                      Account profile
                      <OctantSelectField
                        aria-label="Download account profile"
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
                      Destination folder
                      <OctantSelectField
                        aria-label="Download destination folder"
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
                        aria-label="Download HTTPS site"
                        value={origin}
                        maxLength={2048}
                        placeholder="https://example.com"
                        onChange={(event) => setOrigin(event.target.value)}
                      />
                    </label>
                    <label>
                      Download source sites, one exact HTTPS origin per line
                      <OctantTextarea
                        aria-label="Download source sites"
                        value={sources}
                        maxLength={65536}
                        rows={4}
                        onChange={(event) => setSources(event.target.value)}
                      />
                    </label>
                    <label>
                      Destination directory, relative to the approved folder
                      <OctantInput
                        aria-label="Download destination directory"
                        value={directory}
                        maxLength={4096}
                        onChange={(event) => setDirectory(event.target.value)}
                      />
                    </label>
                    <fieldset className="flex flex-col gap-2">
                      <legend>Allowed file types</legend>
                      {DOWNLOAD_TYPES.map(([type, label]) => (
                        <label className="flex items-center gap-2" key={type}>
                          <OctantCheckbox
                            aria-label={label}
                            checked={mediaTypes.includes(type)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setMediaTypes((values) =>
                                checked
                                  ? [...values.filter((value) => value !== type), type]
                                  : values.filter((value) => value !== type),
                              );
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    <p>
                      The directory must already exist. Every native redirect origin must match a
                      reviewed source site. Unverified sources, other types and files above 25 MiB
                      are refused. Files never overwrite existing files.
                    </p>
                    <label>
                      Total file uses
                      <OctantInput
                        aria-label="Total download file uses"
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
                        aria-label="Total download MiB"
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
                        aria-label="Download permission expiry"
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
                    <dt>Destination folder</dt>
                    <dd>{review.permission.folder.label}</dd>
                    <dt>HTTPS site</dt>
                    <dd className="break-all">{review.permission.origin}</dd>
                    <dt>Destination directory</dt>
                    <dd className="break-all">{review.permission.directory}</dd>
                    <dt>Download source sites</dt>
                    <dd>
                      <ul>
                        {review.permission.sourceOrigins.map((origin) => (
                          <li className="break-all" key={origin}>
                            {origin}
                          </li>
                        ))}
                      </ul>
                    </dd>
                    <dt>Allowed file types</dt>
                    <dd>
                      {review.permission.mediaTypes
                        .map(
                          (type) => DOWNLOAD_TYPES.find(([value]) => value === type)?.[1] ?? type,
                        )
                        .join(", ")}
                    </dd>
                    <dt>Total quota</dt>
                    <dd>
                      {review.permission.maxFiles} file uses ·{" "}
                      {mebibytes(review.permission.maxBytes)}
                    </dd>
                    <dt>Expires</dt>
                    <dd>{new Date(review.permission.expiresAt).toLocaleString()}</dd>
                  </dl>
                )}
                <p>
                  Each admitted file consumes quota, including a later cancellation. Permission ends
                  on revocation, changed routine authority or host restart. Revoking closes an
                  affected page, but a file already dispatched may have been saved. Check the
                  destination before retrying. This manifest grants no account access, uploads or
                  access to other folders.
                </p>
                {error === undefined ? null : <OctantAlert tone="danger">{error}</OctantAlert>}
              </div>
            }
          />
        )}
      </OctantDialogPresence>
    </SettingsSection>
  );
}
