import type {
  ThreadSecretAction,
  ThreadSecretsClient,
} from "@octant/client-runtime/thread-secrets-client";
import type {
  RememberedThreadSecret,
  ThreadSecretsHostView,
} from "@octant/contracts/thread-secrets";
import { useCallback, useEffect, useRef, useState } from "react";
import { THREAD_SECRET_SOURCES, threadSecretTimeLeft } from "../credentials/ActiveThreadSecrets";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { SettingsCompactRow, SettingsSection, SettingsState } from "./primitives";

const REFRESH_MS = 5_000;

/** Every secret a thread may use now, and every secret Octant remembers. */
export function ThreadSecretsSettings(props: {
  readonly client: ThreadSecretsClient;
  readonly focusedSetting?: string | undefined;
}) {
  const { client, focusedSetting } = props;
  const [view, setView] = useState<ThreadSecretsHostView>();
  const [unread, setUnread] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [forgetting, setForgetting] = useState<RememberedThreadSecret>();
  // A slow answer must not replace a newer one, such as the list after a Revoke.
  const asked = useRef(0);

  const load = useCallback(async () => {
    const turn = ++asked.current;
    try {
      const next = await client.readHost();
      if (turn !== asked.current) return;
      setView(next);
      setUnread(false);
    } catch {
      if (turn === asked.current) setUnread(true);
    }
  }, [client]);

  useEffect(() => {
    const stop = scheduleVisibleInterval(() => void load(), REFRESH_MS, { runImmediately: true });
    return () => {
      stop();
      asked.current += 1;
    };
  }, [load]);

  const run = async (command: ThreadSecretAction, failure: string) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { status } = await client.execute(command);
      // Gone is what was asked for.
      if (status === "refused" || status === "not-taken") setProblem(failure);
    } catch {
      setProblem(failure);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const state = (empty: string) =>
    view === undefined ? (
      <SettingsState kind={unread ? "error" : "loading"}>
        {unread ? "Secrets could not be read from this computer." : "Reading secrets…"}
      </SettingsState>
    ) : (
      <SettingsState kind="empty">{empty}</SettingsState>
    );

  return (
    <>
      <SettingsSection
        description="What the agents in your threads may use now. Revoking one deletes it and its file; a command that already read it keeps what it read."
        title="Active secrets"
      >
        {view === undefined || view.active.length === 0 ? (
          state("No thread has an active secret.")
        ) : (
          <div className="setgroup">
            {view.active.map((secret) => (
              <SettingsCompactRow
                focused={focusedSetting === "thread-secrets-active"}
                key={secret.id}
                label={secret.label}
                meta={[
                  threadSecretTimeLeft(secret),
                  THREAD_SECRET_SOURCES[secret.source],
                  secret.threadTitle,
                  secret.name,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                labelWraps
                metaWraps
                settingId="thread-secrets-active"
              >
                <OctantButton
                  aria-label={`Revoke ${secret.label}, ${secret.name}`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      { kind: "revoke", threadId: secret.threadId, secretId: secret.id },
                      `${secret.label} could not be revoked. Try again.`,
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Revoke
                </OctantButton>
              </SettingsCompactRow>
            ))}
          </div>
        )}
        <div aria-live="polite">
          {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
        </div>
      </SettingsSection>

      <SettingsSection
        description="Secrets you chose to remember. Octant offers one only on a card that asks for the same name, and uses it only when you pick it there."
        title="Remembered secrets"
      >
        {view === undefined || view.remembered.length === 0 ? (
          state("Octant remembers no secret.")
        ) : (
          <div className="setgroup">
            {view.remembered.map((secret) => (
              <SettingsCompactRow
                focused={focusedSetting === "thread-secrets-remembered"}
                key={secret.id}
                label={secret.name}
                labelWraps
                metaWraps
                meta={
                  secret.source === "pasted"
                    ? "In this computer's credential store"
                    : "The address of a 1Password item"
                }
                settingId="thread-secrets-remembered"
              >
                <OctantButton
                  aria-label={`Forget ${secret.name}`}
                  disabled={busy}
                  onClick={() => setForgetting(secret)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Forget
                </OctantButton>
              </SettingsCompactRow>
            ))}
          </div>
        )}
      </SettingsSection>

      <OctantDialogPresence>
        {forgetting === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel="Forget"
            destructive
            onCancel={() => setForgetting(undefined)}
            onConfirm={() => {
              const { id, name } = forgetting;
              setForgetting(undefined);
              void run({ kind: "forget", id }, `${name} could not be forgotten. Try again.`);
            }}
            pending={busy}
            title={`Forget ${forgetting.name}?`}
          >
            {forgetting.source === "pasted"
              ? "Its value is deleted from this computer's credential store. "
              : "Nothing in 1Password is changed or deleted. "}
            A thread that has it keeps it until it is revoked there or its thread is archived.
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </>
  );
}
