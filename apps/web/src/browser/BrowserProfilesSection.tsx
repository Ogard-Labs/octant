import { OctantInput } from "../ui/base/OctantInput";
import { OctantAlert } from "../ui/base/OctantAlert";
import { announceBrowserAccountProfilesChanged } from "./useBrowserAccountProfiles";
import { browserProfileKey } from "@octant/domain";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserProfileSummary,
  StoredBrowserProfile,
} from "@octant/contracts/browser-profiles";
import { useCallback, useEffect, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { BrowserCookieImportDialog } from "./BrowserCookieImportDialog";
import { formatProfileSize } from "./browserProfileCopy";
import { BrowserSessionGrantsSection } from "./BrowserSessionGrantsSection";

export interface BrowserProfilesSectionProps {
  readonly client: Pick<BrowserAutomationClient, "manageProfiles" | "manageSessionGrants">;
  readonly focusedSetting?: string | undefined;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly profiles: ReadonlyArray<BrowserProfileSummary> }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Settings › Data & privacy › Browser profiles: the sign-ins this Mac keeps for
 * Browser pages, each with its size and a way to sign out. Nothing here reads a
 * cookie; a profile is known by its name and the space it occupies.
 */
export function BrowserProfilesSection(props: BrowserProfilesSectionProps) {
  const { client } = props;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [confirming, setConfirming] = useState<{
    readonly summary: BrowserProfileSummary;
    readonly scope: "all" | "cookies";
  }>();
  const [importingInto, setImportingInto] = useState<BrowserProfileSummary>();
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [newName, setNewName] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const manage = client.manageProfiles;

  const refresh = useCallback(async () => {
    if (manage === undefined) {
      setLoaded({ kind: "unavailable", message: "Browser profiles are not available here." });
      return;
    }
    try {
      const result = await manage.call(client, { kind: "list" });
      setLoaded(
        result.kind === "browser-profiles"
          ? { kind: "ready", profiles: result.profiles }
          : {
              kind: "unavailable",
              message: result.kind === "browser-profiles-refused" ? result.message : "",
            },
      );
    } catch {
      setLoaded({ kind: "unavailable", message: "Browser profiles are unavailable." });
    }
  }, [client, manage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function clear(profile: StoredBrowserProfile, scope: "all" | "cookies"): Promise<void> {
    if (manage === undefined) return;
    setClearing(true);
    try {
      const result = await manage.call(client, { kind: "clear", profile, scope });
      setNotice(
        result.kind === "browser-profiles-refused"
          ? result.message
          : scope === "all"
            ? "Signed out. The profile’s pages closed and its data was removed."
            : "Cookies cleared. The profile’s pages closed.",
      );
    } catch {
      setNotice("The profile could not be cleared.");
    } finally {
      setClearing(false);
      setConfirming(undefined);
      await refresh();
    }
  }

  async function createAccount(): Promise<void> {
    if (manage === undefined || newName === undefined) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const result = await manage.call(client, { kind: "create-account", label: newName.trim() });
      if (result.kind !== "browser-account-profile-created") {
        setCreateError(
          result.kind === "browser-profiles-refused"
            ? result.message
            : "The account profile could not be created.",
        );
        return;
      }
      setNotice(`Created “${result.label}”. Choose it explicitly in a Browser profile control.`);
      setNewName(undefined);
      announceBrowserAccountProfilesChanged();
      await refresh();
    } catch {
      setCreateError("The account profile could not be created. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <SettingsSection
        description="Sign-ins that Browser pages keep on this Mac. Private pages keep none."
        title="Browser profiles"
      >
        {loaded.kind === "loading" ? <SettingsState kind="loading">Loading…</SettingsState> : null}
        {loaded.kind === "unavailable" ? (
          <SettingsState kind="empty">{loaded.message}</SettingsState>
        ) : null}
        {loaded.kind !== "ready" ? null : (
          <SettingRow
            focused={props.focusedSetting === "browser-accounts"}
            label="Named account profiles"
            description="Separate sign-ins on this host, reusable across Projects only when you choose them. Creating a profile grants no site or task access."
            scope="host"
            settingId="browser-accounts"
          >
            <OctantButton
              onClick={() => {
                setNewName("");
                setCreateError(undefined);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              New account profile…
            </OctantButton>
          </SettingRow>
        )}
        {newName === undefined ? null : (
          <OctantConfirmDialog
            title="New account profile"
            confirmLabel="Create profile"
            confirmDisabled={newName.trim().length === 0 || newName.trim().length > 80}
            pending={creating}
            onCancel={() => setNewName(undefined)}
            onConfirm={() => void createAccount()}
            details={
              <>
                <label className="field">
                  <span className="field__label">Profile name</span>
                  <OctantInput
                    aria-label="Profile name"
                    value={newName}
                    maxLength={80}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </label>
                {createError === undefined ? null : (
                  <OctantAlert tone="danger">{createError}</OctantAlert>
                )}
              </>
            }
          >
            This profile keeps its own sign-ins on this host. It is not exported or synced. Select
            it explicitly before using it in a task.
          </OctantConfirmDialog>
        )}
        {loaded.kind === "ready" ? (
          <div className="setgroup">
            {loaded.profiles.map((summary, index) => (
              <SettingRow
                description={
                  summary.profile.kind !== "project"
                    ? "Shared by every Project that chooses it."
                    : "Shared by every page of this Project."
                }
                focused={props.focusedSetting === "browser-profiles" && index === 0}
                key={browserProfileKey(summary.profile)}
                label={`${summary.label} · ${formatProfileSize(summary.sizeBytes)}`}
                scope="host"
                settingId="browser-profiles"
              >
                <div className="host-settings__controls">
                  <OctantButton
                    aria-label={`Import cookies into ${summary.label}`}
                    onClick={() => setImportingInto(summary)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Import cookies…
                  </OctantButton>
                  <OctantButton
                    aria-label={`Clear cookies in ${summary.label}`}
                    onClick={() => setConfirming({ summary, scope: "cookies" })}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Clear cookies…
                  </OctantButton>
                  <OctantButton
                    aria-label={`Sign out of ${summary.label}`}
                    onClick={() => setConfirming({ summary, scope: "all" })}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Sign out…
                  </OctantButton>
                </div>
              </SettingRow>
            ))}
          </div>
        ) : null}
        {notice === undefined ? null : <SettingsState kind="empty">{notice}</SettingsState>}
        {importingInto === undefined ? null : (
          <BrowserCookieImportDialog
            client={client}
            onClose={(outcome) => {
              setImportingInto(undefined);
              if (outcome !== undefined) setNotice(outcome);
              void refresh();
            }}
            profile={importingInto}
          />
        )}
        {confirming === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel={confirming.scope === "all" ? "Sign out" : "Clear cookies"}
            destructive
            onCancel={() => setConfirming(undefined)}
            onConfirm={() => void clear(confirming.summary.profile, confirming.scope)}
            pending={clearing}
            title={
              confirming.scope === "all"
                ? `Sign out of ${confirming.summary.label}?`
                : `Clear cookies in ${confirming.summary.label}?`
            }
          >
            {confirming.scope === "all"
              ? "Every page in this profile closes, and its cookies, site storage and cache are removed. Sites you were signed in to will ask you to sign in again."
              : "Every page in this profile closes and its cookies are removed. Other site storage stays. Sites you were signed in to will ask you to sign in again."}
          </OctantConfirmDialog>
        )}
      </SettingsSection>
      <BrowserSessionGrantsSection
        client={client}
        profiles={loaded.kind === "ready" ? loaded.profiles : []}
        focusedSetting={props.focusedSetting}
      />
    </>
  );
}
