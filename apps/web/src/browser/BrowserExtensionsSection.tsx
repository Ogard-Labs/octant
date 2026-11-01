import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserExtensionSummary,
  BrowserExtensionsResult,
} from "@octant/contracts/browser-extensions";
import type {
  BrowserProfileSummary,
  StoredBrowserProfile,
} from "@octant/contracts/browser-profiles";
import { browserProfileKey, describeExtensionAccess } from "@octant/domain";
import { useCallback, useEffect, useState } from "react";
import { BrowserExtensionImportDialog } from "./BrowserExtensionImportDialog";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface BrowserExtensionsSectionProps {
  readonly client: Pick<BrowserAutomationClient, "manageExtensions" | "manageProfiles">;
  /** The native folder picker; absent where this window cannot show one. */
  readonly pickExtensionFolder?: () => Promise<
    { readonly receiptId: string; readonly displayName: string } | undefined
  >;
  readonly focusedSetting?: string | undefined;
}

type Loaded =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly extensions: ReadonlyArray<BrowserExtensionSummary>;
      readonly profiles: ReadonlyArray<BrowserProfileSummary>;
    }
  | { readonly kind: "unavailable"; readonly message: string };

type Pending =
  | {
      readonly kind: "enable";
      readonly extension: BrowserExtensionSummary;
      readonly profile: BrowserProfileSummary;
    }
  | { readonly kind: "remove"; readonly extension: BrowserExtensionSummary };

/**
 * Settings › Data & privacy › Browser extensions: the extensions installed on
 * this Mac, where each runs, and the ways to change that. An extension is off
 * until the person enables it in one profile after reading, in plain words, what
 * it can read and change there. It never runs in a Private page.
 */
export function BrowserExtensionsSection(props: BrowserExtensionsSectionProps) {
  const { client } = props;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [importing, setImporting] = useState(false);
  const manage = client.manageExtensions;
  const manageProfiles = client.manageProfiles;

  const refresh = useCallback(async () => {
    if (manage === undefined || manageProfiles === undefined) {
      setLoaded({ kind: "unavailable", message: "Browser extensions are not available here." });
      return;
    }
    try {
      const [extensions, profiles] = await Promise.all([
        manage.call(client, { kind: "list" }),
        manageProfiles.call(client, { kind: "list" }),
      ]);
      if (extensions.kind !== "browser-extensions") {
        setLoaded({ kind: "unavailable", message: refusalOf(extensions) });
      } else {
        setLoaded({
          kind: "ready",
          extensions: extensions.extensions,
          // Where an extension may be enabled: the profiles that can be listed.
          profiles: profiles.kind === "browser-profiles" ? profiles.profiles : [],
        });
      }
    } catch {
      setLoaded({ kind: "unavailable", message: "Browser extensions are unavailable." });
    }
  }, [client, manage, manageProfiles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(command: Parameters<NonNullable<typeof manage>>[0], success: string) {
    if (manage === undefined) return;
    setBusy(true);
    try {
      const result = await manage.call(client, command);
      setNotice(result.kind === "browser-extension-refused" ? result.message : success);
    } catch {
      setNotice("That did not go through.");
    } finally {
      setBusy(false);
      setPending(undefined);
      await refresh();
    }
  }

  async function install(): Promise<void> {
    const picked = await props.pickExtensionFolder?.();
    if (picked === undefined) return;
    await run(
      { kind: "install", receiptId: picked.receiptId },
      `Installed ${picked.displayName}. It is off until you enable it in a profile.`,
    );
  }

  const labelOf = (profile: StoredBrowserProfile, profiles: ReadonlyArray<BrowserProfileSummary>) =>
    profiles.find((entry) => browserProfileKey(entry.profile) === browserProfileKey(profile))
      ?.label ?? "A Project profile";

  return (
    <SettingsSection
      description="Extensions add features to pages in a Project or Personal profile. They can read and change the sites they ask for, including what the agent reads, so each one is off until you turn it on."
      title="Browser extensions"
    >
      {loaded.kind === "loading" ? <SettingsState kind="loading">Loading…</SettingsState> : null}
      {loaded.kind === "unavailable" ? (
        <SettingsState kind="empty">{loaded.message}</SettingsState>
      ) : null}
      {loaded.kind === "ready" ? (
        <div className="setgroup">
          {loaded.extensions.length === 0 ? (
            <SettingsState kind="empty">No extensions installed.</SettingsState>
          ) : null}
          {loaded.extensions.map((extension, index) => {
            const available = loaded.profiles.filter(
              (profile) =>
                !extension.enabledIn.some(
                  (entry) => browserProfileKey(entry) === browserProfileKey(profile.profile),
                ),
            );
            const selectedKey =
              chosen[extension.id] ??
              browserProfileKey(available[0]?.profile ?? { kind: "personal" });
            const selected = available.find(
              (profile) => browserProfileKey(profile.profile) === selectedKey,
            );
            return (
              <SettingRow
                description={describeWhere(extension, loaded.profiles, labelOf)}
                focused={props.focusedSetting === "browser-extensions" && index === 0}
                key={extension.id}
                label={`${extension.name} · ${extension.version}`}
                scope="host"
                settingId="browser-extensions"
              >
                <div className="host-settings__controls">
                  {available.length === 0 ? null : (
                    <>
                      <OctantSelectField
                        aria-label={`Profile to enable ${extension.name} in`}
                        onValueChange={(value) =>
                          setChosen((current) => ({ ...current, [extension.id]: value }))
                        }
                        options={available.map((profile) => ({
                          id: browserProfileKey(profile.profile),
                          label: profile.label,
                        }))}
                        value={selectedKey}
                      />
                      <OctantButton
                        aria-label={`Enable ${extension.name}`}
                        disabled={selected === undefined || busy}
                        onClick={() =>
                          selected === undefined
                            ? undefined
                            : setPending({ kind: "enable", extension, profile: selected })
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Enable…
                      </OctantButton>
                    </>
                  )}
                  {extension.enabledIn.map((profile) => (
                    <OctantButton
                      aria-label={`Turn ${extension.name} off in ${labelOf(profile, loaded.profiles)}`}
                      disabled={busy}
                      key={browserProfileKey(profile)}
                      onClick={() =>
                        void run(
                          { kind: "disable", extensionId: extension.id, profile },
                          `Turned ${extension.name} off in ${labelOf(profile, loaded.profiles)}.`,
                        )
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Turn off in {labelOf(profile, loaded.profiles)}
                    </OctantButton>
                  ))}
                  <OctantButton
                    aria-label={`Remove ${extension.name}`}
                    disabled={busy}
                    onClick={() => setPending({ kind: "remove", extension })}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Remove…
                  </OctantButton>
                </div>
              </SettingRow>
            );
          })}
        </div>
      ) : null}
      {loaded.kind === "ready" && props.pickExtensionFolder !== undefined ? (
        <div className="host-settings__controls">
          <OctantButton
            disabled={busy}
            onClick={() => void install()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Install extension…
          </OctantButton>
          <OctantButton
            disabled={busy}
            onClick={() => setImporting(true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Import from another browser…
          </OctantButton>
        </div>
      ) : null}
      {importing ? (
        <BrowserExtensionImportDialog
          client={client}
          onClose={(outcome) => {
            setImporting(false);
            if (outcome === undefined) return;
            setNotice(outcome);
            void refresh();
          }}
        />
      ) : null}
      {notice === undefined ? null : <SettingsState kind="empty">{notice}</SettingsState>}
      {pending?.kind === "enable" ? (
        <OctantConfirmDialog
          confirmLabel="Enable"
          details={
            <ul aria-label="What this extension can do">
              {describeExtensionAccess(
                pending.extension.addedAccess !== undefined &&
                  pending.extension.needsConfirmation.some(
                    (profile) =>
                      browserProfileKey(profile) === browserProfileKey(pending.profile.profile),
                  )
                  ? pending.extension.addedAccess
                  : pending.extension.access,
              ).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          }
          onCancel={() => setPending(undefined)}
          onConfirm={() =>
            void run(
              {
                kind: "enable",
                extensionId: pending.extension.id,
                profile: pending.profile.profile,
                contentHash: pending.extension.contentHash,
              },
              `Turned ${pending.extension.name} on in ${pending.profile.label}.`,
            )
          }
          pending={busy}
          title={`Enable ${pending.extension.name} in ${pending.profile.label}?`}
        >
          {pending.extension.addedAccess !== undefined
            ? "This update asks for more than the version you allowed. It can:"
            : "While it is on, this extension can see and change what pages show in this profile, including what an agent reads there. It can:"}
        </OctantConfirmDialog>
      ) : null}
      {pending?.kind === "remove" ? (
        <OctantConfirmDialog
          confirmLabel="Remove"
          destructive
          onCancel={() => setPending(undefined)}
          onConfirm={() =>
            void run(
              { kind: "remove", extensionId: pending.extension.id },
              `Removed ${pending.extension.name}.`,
            )
          }
          pending={busy}
          title={`Remove ${pending.extension.name}?`}
        >
          It turns off in every profile and its copy is deleted.
        </OctantConfirmDialog>
      ) : null}
    </SettingsSection>
  );
}

function describeWhere(
  extension: BrowserExtensionSummary,
  profiles: ReadonlyArray<BrowserProfileSummary>,
  labelOf: (
    profile: StoredBrowserProfile,
    profiles: ReadonlyArray<BrowserProfileSummary>,
  ) => string,
): string {
  const on =
    extension.enabledIn.length === 0
      ? "Off everywhere."
      : `On in ${extension.enabledIn.map((profile) => labelOf(profile, profiles)).join(", ")}.`;
  if (extension.needsConfirmation.length === 0) return on;
  return `${on} An update asks for more, so it is off in ${extension.needsConfirmation
    .map((profile) => labelOf(profile, profiles))
    .join(", ")} until you confirm.`;
}

function refusalOf(result: BrowserExtensionsResult): string {
  return result.kind === "browser-extension-refused"
    ? result.message
    : "Browser extensions are unavailable.";
}
