import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import type {
  BrowserSessionGrant,
  BrowserSessionGrantsCommand,
  BrowserSessionGrantsResult,
  BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { browserProfileKey } from "@octant/domain";
import { useCallback, useEffect, useId, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantAlert } from "../ui/base/OctantAlert";

export function BrowserSessionGrantsSection(props: {
  readonly client: Pick<BrowserAutomationClient, "manageSessionGrants">;
  readonly profiles: ReadonlyArray<BrowserProfileSummary>;
  readonly focusedSetting?: string | undefined;
}) {
  const manage = props.client.manageSessionGrants;
  const [targets, setTargets] = useState<ReadonlyArray<BrowserSessionTarget>>([]);
  const [grants, setGrants] = useState<ReadonlyArray<BrowserSessionGrant>>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [origins, setOrigins] = useState("");
  const [duration, setDuration] = useState<15 | 60 | 480>(15);
  const [review, setReview] =
    useState<Extract<BrowserSessionGrantsResult, { readonly kind: "browser-session-review" }>>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const errorId = useId();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (manage === undefined) return;
      try {
        const [targetResult, grantResult] = await Promise.all([
          manage({ kind: "targets" }, signal),
          manage({ kind: "list" }, signal),
        ]);
        if (signal?.aborted) return;
        if (
          targetResult.kind !== "browser-session-targets" ||
          grantResult.kind !== "browser-session-grants"
        ) {
          setError(
            targetResult.kind === "browser-session-refused"
              ? targetResult.message
              : grantResult.kind === "browser-session-refused"
                ? grantResult.message
                : "Session permissions are unavailable.",
          );
          return;
        }
        setTargets(targetResult.targets);
        setGrants(grantResult.grants);
        setLoaded(true);
      } catch {
        if (!signal?.aborted)
          setError("Session permissions could not be loaded. Refresh to try again.");
      }
    },
    [manage],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError(undefined);
    setGrants([]);
    setTargets([]);
    setEditing(false);
    setReview(undefined);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  if (manage === undefined) return null;
  const chosenTarget = targets.find((target) => JSON.stringify(target.grantee) === targetId);
  const chosenProfile = props.profiles.find(
    (profile) => browserProfileKey(profile.profile) === profileId,
  );
  const act = async (command: BrowserSessionGrantsCommand) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await manage(command);
      if (result.kind === "browser-session-refused") {
        setError(result.message);
        if (command.kind === "grant") setReview(undefined);
        if (command.kind === "revoke") await refresh();
        return;
      }
      if (result.kind === "browser-session-review") {
        setReview(result);
        return;
      }
      if (result.kind === "browser-session-granted") {
        setEditing(false);
        setReview(undefined);
        setNotice("Session permission granted. It ends at the displayed expiry or when revoked.");
      }
      if (result.kind === "browser-session-revoked")
        setNotice("Session permission revoked. Its Browser context closes.");
      await refresh();
    } catch {
      setError(
        "The result could not be confirmed. Refresh the permission list before trying again.",
      );
      if (command.kind === "grant") {
        setReview(undefined);
        await refresh();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSection
      title="Browser session permissions"
      description="Allow a selected caller to use an existing sign-in on this host for exact sites. Permissions end on host restart. File transfers and login or script permissions stay separate."
    >
      <SettingRow
        label="Session permissions"
        scope="host"
        settingId="browser-session-permissions"
        focused={props.focusedSetting === "browser-session-permissions"}
        description={
          props.profiles.length === 0
            ? "No Browser profiles are available on this host. Check Browser profiles above, then reopen this page to reload them."
            : loaded && targets.length === 0
              ? "No eligible managed child in this Project. A local Work or Code child needs tool authority and a supported provider. Queued and waiting children can be reviewed without starting them."
              : "Choose the caller and profile explicitly, then review sites and expiry."
        }
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
            New session permission…
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
            Refresh permissions
          </OctantButton>
        </div>
      </SettingRow>
      {!loaded && error === undefined ? (
        <SettingsState kind="loading">Loading session permissions…</SettingsState>
      ) : null}
      {loaded && grants.length === 0 ? (
        <SettingsState kind="empty">No session permissions.</SettingsState>
      ) : null}
      {grants.map((grant) => (
        <SettingRow
          settingId="browser-session-permissions"
          key={grant.grantId}
          label={`${grant.target.label} · ${grant.profileLabel}`}
          description={`${grant.origins.join(", ")} · Expires ${new Date(grant.expiresAt).toLocaleString()} · ${grant.target.modelId}`}
          scope="host"
        >
          <OctantButton
            aria-label={`Revoke permission for ${grant.target.label}`}
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void act({ kind: "revoke", grantId: grant.grantId })}
          >
            Revoke
          </OctantButton>
        </SettingRow>
      ))}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {!editing && error !== undefined ? <OctantAlert tone="danger">{error}</OctantAlert> : null}
      {!editing ? null : (
        <OctantConfirmDialog
          title={
            review === undefined
              ? "Review Browser session permission"
              : "Grant Browser session permission?"
          }
          confirmLabel={review === undefined ? "Review permission" : "Grant session permission"}
          pending={pending}
          confirmDisabled={
            review === undefined &&
            (chosenTarget === undefined || chosenProfile === undefined || origins.trim() === "")
          }
          onCancel={() => {
            if (!pending) {
              setEditing(false);
              setReview(undefined);
            }
          }}
          onConfirm={() => {
            if (review !== undefined) {
              void act({ kind: "grant", reviewId: review.reviewId });
              return;
            }
            if (chosenTarget !== undefined && chosenProfile !== undefined)
              void act({
                kind: "review",
                grantee: chosenTarget.grantee,
                profile: chosenProfile.profile,
                origins: origins.split(/[\s,]+/).filter(Boolean),
                durationMinutes: duration,
              });
          }}
          details={
            <>
              {review === undefined ? (
                <div className="flex flex-col gap-3">
                  <label className="field">
                    <span className="field__label">Caller</span>
                    <OctantSelectField
                      aria-label="Caller"
                      value={targetId}
                      placeholder="Choose a caller"
                      onValueChange={setTargetId}
                      options={targets.map((target) => ({
                        id: JSON.stringify(target.grantee),
                        label: `${target.grantee.kind === "child" ? "Child" : target.grantee.kind === "routine" ? "Routine" : "Terminal"} · ${target.label}`,
                      }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Profile</span>
                    <OctantSelectField
                      aria-label="Profile"
                      value={profileId}
                      placeholder="Choose a profile"
                      onValueChange={setProfileId}
                      options={props.profiles.map((profile) => ({
                        id: browserProfileKey(profile.profile),
                        label: profile.label,
                      }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">HTTPS origins</span>
                    <OctantInput
                      aria-label="HTTPS origins"
                      aria-describedby={error === undefined ? undefined : errorId}
                      value={origins}
                      maxLength={32_768}
                      placeholder="https://example.com"
                      onChange={(event) => setOrigins(event.target.value)}
                    />
                  </label>
                  <p>
                    Exact HTTPS origins, separated by spaces or commas. Include a port when needed;
                    omit paths and query values.
                  </p>
                  <label className="field">
                    <span className="field__label">Expires after</span>
                    <OctantSelectField
                      aria-label="Permission duration"
                      value={String(duration)}
                      onValueChange={(value) =>
                        setDuration(value === "480" ? 480 : value === "60" ? 60 : 15)
                      }
                      options={[
                        { id: "15", label: "15 minutes" },
                        { id: "60", label: "1 hour" },
                        { id: "480", label: "8 hours" },
                      ]}
                    />
                  </label>
                </div>
              ) : (
                <dl className="grid gap-2">
                  <dt>Caller</dt>
                  <dd>{review.grant.target.label}</dd>
                  <dt>Profile</dt>
                  <dd>{review.grant.profileLabel}</dd>
                  <dt>Sites</dt>
                  <dd className="break-all">{review.grant.origins.join(", ")}</dd>
                  <dt>Model</dt>
                  <dd>{review.grant.target.modelId}</dd>
                  <dt>Execution host</dt>
                  <dd>This host</dd>
                  <dt>Expires</dt>
                  <dd>{new Date(review.grant.expiresAt).toLocaleString()}</dd>
                </dl>
              )}
              {error === undefined ? null : (
                <div id={errorId}>
                  <OctantAlert tone="danger">{error}</OctantAlert>
                </div>
              )}
            </>
          }
        >
          This caller can act as the account already signed in to this profile on the listed sites.
          Grant only the intended task. Other sites, callers, login actions and file transfers are
          not authorized.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
