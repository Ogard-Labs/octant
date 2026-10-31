import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserProfileSummary,
  StoredBrowserProfile,
} from "@octant/contracts/browser-profiles";
import { useCallback, useEffect, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { formatProfileSize } from "./browserProfileCopy";

export interface BrowserProfilesSectionProps {
  readonly client: Pick<BrowserAutomationClient, "manageProfiles">;
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
  const [confirming, setConfirming] = useState<BrowserProfileSummary>();
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string>();
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

  async function signOut(profile: StoredBrowserProfile): Promise<void> {
    if (manage === undefined) return;
    setClearing(true);
    try {
      const result = await manage.call(client, { kind: "clear", profile, scope: "all" });
      setNotice(
        result.kind === "browser-profiles-refused"
          ? result.message
          : "Signed out. The profile’s pages closed and its data was removed.",
      );
    } catch {
      setNotice("The profile could not be cleared.");
    } finally {
      setClearing(false);
      setConfirming(undefined);
      await refresh();
    }
  }

  return (
    <SettingsSection
      description="Sign-ins that Browser pages keep on this Mac. Private pages keep none."
      title="Browser profiles"
    >
      {loaded.kind === "loading" ? <SettingsState kind="loading">Loading…</SettingsState> : null}
      {loaded.kind === "unavailable" ? (
        <SettingsState kind="empty">{loaded.message}</SettingsState>
      ) : null}
      {loaded.kind === "ready" ? (
        <div className="setgroup">
          {loaded.profiles.map((summary, index) => (
            <SettingRow
              description={
                summary.profile.kind === "personal"
                  ? "Shared by every Project that chooses it."
                  : "Shared by every page of this Project."
              }
              focused={props.focusedSetting === "browser-profiles" && index === 0}
              key={summary.profile.kind === "personal" ? "personal" : summary.profile.projectId}
              label={`${summary.label} · ${formatProfileSize(summary.sizeBytes)}`}
              scope="host"
              settingId="browser-profiles"
            >
              <OctantButton
                onClick={() => setConfirming(summary)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Sign out…
              </OctantButton>
            </SettingRow>
          ))}
        </div>
      ) : null}
      {notice === undefined ? null : <SettingsState kind="empty">{notice}</SettingsState>}
      {confirming === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Sign out"
          destructive
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => void signOut(confirming.profile)}
          pending={clearing}
          title={`Sign out of ${confirming.label}?`}
        >
          Every page in this profile closes, and its cookies, site storage and cache are removed.
          Sites you were signed in to will ask you to sign in again.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
