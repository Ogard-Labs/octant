import type { ProtectedFilesClient } from "@octant/client-runtime/protected-files-client";
import {
  decodeProtectedFilesCommand,
  type BuiltInProtectedFiles,
  type ProtectedFilesCommand,
  type ProtectedFilesSettings as ProtectedFilesSnapshot,
} from "@octant/contracts/protected-files";
import { useCallback, useEffect, useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface ProtectedFilesSettingsProps {
  /** Absent where the host publishes no protected list, such as a paired device. */
  readonly client: ProtectedFilesClient | undefined;
  readonly focusedSetting?: string | undefined;
}

/** A command as the window builds it; the version is the one it last read. */
type ProtectedFilesChange = {
  [Kind in ProtectedFilesCommand["kind"]]: Omit<
    Extract<ProtectedFilesCommand, { readonly kind: Kind }>,
    "expectedVersion"
  >;
}[ProtectedFilesCommand["kind"]];

/** What the section says the guard is, in the person's words. */
export const PROTECTED_FILES_FACT =
  "Below Full access, agents cannot read or change these files. At Full access they are guarded by Octant's own tools and redaction only, and a shell command can read them. Work goes through the channel instead: SSH through your SSH agent, Git over HTTPS through the system credential helper, and keys through Octant's credential broker.";

const CHANNEL_HINT: Record<BuiltInProtectedFiles["channel"], string> = {
  "ssh-agent": "Use SSH through your SSH agent.",
  "git-credential-helper": "Git signs in through the system credential helper.",
  "credential-broker": "Link the credential in Octant instead.",
  "keychain-api": "Programs use the keychain service instead.",
  "provider-sign-in": "Each runtime still reads its own sign-in.",
  none: "No agent channel replaces these.",
};

/**
 * Settings › Permissions › Protected files. The built-in groups are on by
 * default; removing one asks first, because every agent on this host can then
 * read those files, and the host journals the confirmed removal. Added paths
 * are protected like built-ins and removed without asking.
 */
export function ProtectedFilesSettings(props: ProtectedFilesSettingsProps) {
  const { client } = props;
  const inputId = useId();
  const [settings, setSettings] = useState<ProtectedFilesSnapshot>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirming, setConfirming] = useState<BuiltInProtectedFiles>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setSettings(await client.settings());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(change: ProtectedFilesChange): Promise<boolean> {
    if (client === undefined || settings === undefined) return false;
    let command: ProtectedFilesCommand;
    try {
      command = decodeProtectedFilesCommand({ ...change, expectedVersion: settings.version });
    } catch {
      setProblem("Use an absolute path, or one that starts with ~/ for your home folder.");
      return false;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(command);
      if (result.kind === "protected-files-settings") {
        setSettings(result.settings);
        return true;
      }
      setProblem(result.message);
      if (result.reason === "stale-version") await load();
      return false;
    } catch {
      setProblem("Protected files could not be changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const body =
    client === undefined ? (
      <SettingsState kind="empty">Protected files are set on the host machine.</SettingsState>
    ) : settings === undefined ? (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Protected files could not be read from this host."
          : "Reading protected files…"}
      </SettingsState>
    ) : (
      <>
        <div className="setgroup">
          {settings.builtIns.map((group, index) => (
            <SettingRow
              description={
                <>
                  <span className="protected-files__paths">{group.paths.join(", ")}</span>{" "}
                  {group.removed ? "Agents can read these now." : CHANNEL_HINT[group.channel]}
                </>
              }
              focused={props.focusedSetting === "protected-files" && index === 0}
              key={group.id}
              label={group.removed ? `${group.label} (not protected)` : group.label}
              scope="host"
              settingId="protected-files"
            >
              {group.removed ? (
                <OctantButton
                  disabled={busy}
                  onClick={() =>
                    void send({ kind: "restore-built-in-protected-files", id: group.id })
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Protect again
                </OctantButton>
              ) : (
                <OctantButton
                  disabled={busy}
                  onClick={() => setConfirming(group)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove
                </OctantButton>
              )}
            </SettingRow>
          ))}
        </div>
        <div className="setgroup">
          {settings.added.map((path) => (
            <SettingRow
              description="Added by you."
              key={path}
              label={path}
              scope="host"
              settingId="protected-files"
            >
              <OctantButton
                disabled={busy}
                onClick={() => void send({ kind: "remove-protected-path", path })}
                size="sm"
                type="button"
                variant="secondary"
              >
                Remove
              </OctantButton>
            </SettingRow>
          ))}
          <SettingRow
            description="A file, or a folder and everything in it. Absolute, or starting with ~/."
            htmlFor={inputId}
            label="Protect another path"
            scope="host"
            settingId="protected-files-add"
          >
            <form
              className="protected-files__add"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const path = draft.trim();
                if (path === "") return;
                void send({ kind: "add-protected-path", path }).then((added) => {
                  if (added) setDraft("");
                });
              }}
            >
              <OctantInput
                aria-label="Path to protect"
                className="settings-view__text-input"
                disabled={busy}
                id={inputId}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="~/secrets"
                type="text"
                value={draft}
              />
              <OctantButton disabled={busy || draft.trim() === ""} size="sm" type="submit">
                Add
              </OctantButton>
            </form>
          </SettingRow>
        </div>
        <div className="settings-feedback-slot" aria-live="polite">
          {problem === undefined ? null : (
            <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
          )}
        </div>
      </>
    );

  return (
    <SettingsSection description={PROTECTED_FILES_FACT} title="Protected files">
      {body}
      {confirming === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Remove protection"
          destructive
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            const group = confirming;
            setConfirming(undefined);
            void send({
              kind: "remove-built-in-protected-files",
              id: group.id,
              confirmed: true,
            });
          }}
          pending={busy}
          title={`Stop protecting ${confirming.label}?`}
        >
          Every agent on this computer will be able to read and change {confirming.paths.join(", ")}
          . The change is recorded, and you can protect them again here.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
