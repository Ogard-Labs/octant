import { useCallback, useEffect, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type {
  IntegrationAuthenticationSnapshot,
  IntegrationAuthenticationState,
} from "@octant/contracts/integration";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingsFactList, SettingsPanel, SettingsState } from "./primitives";

export interface LinearConnectionSettingsProps {
  readonly client: IntegrationClient;
}

type SnapshotState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: IntegrationAuthenticationSnapshot };

const STATE_LABELS: Readonly<Record<IntegrationAuthenticationState, string>> = {
  ready: "Connected",
  "scope-limited": "Connected (limited scopes)",
  unauthorized: "Not connected",
  "external-token": "Blocked: ambient token detected",
  "rate-limited": "Rate limited",
  unavailable: "Unavailable",
};

export function LinearConnectionSettings({ client }: LinearConnectionSettingsProps) {
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: "loading" });
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [personalKey, setPersonalKey] = useState("");
  const [personalBusy, setPersonalBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.authenticationSnapshot();
      setSnapshotState({ kind: "ready", snapshot });
    } catch (error) {
      setSnapshotState({
        kind: "error",
        message: error instanceof Error ? error.message : "Linear status is unavailable.",
      });
    }
  }, [client]);

  useEffect(() => {
    setSnapshotState({ kind: "loading" });
    void refresh();
  }, [refresh]);

  const runCommand = async (kind: "setup" | "refresh" | "logout") => {
    setCommandBusy(true);
    setCommandError(undefined);
    try {
      const snapshot = await client.executeAuthenticationCommand({ kind });
      setSnapshotState({ kind: "ready", snapshot });
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "The Linear command could not be delivered.",
      );
    } finally {
      setCommandBusy(false);
      setDisconnectArmed(false);
    }
  };

  if (snapshotState.kind === "loading") {
    return (
      <section aria-label="Linear" className="linear-settings" id="settings-linear">
        <SettingsState kind="loading">Loading Linear status…</SettingsState>
      </section>
    );
  }

  if (snapshotState.kind === "error") {
    return (
      <section aria-label="Linear" className="linear-settings" id="settings-linear">
        <SettingsState kind="error">{snapshotState.message}</SettingsState>
        <OctantButton
          onClick={() => {
            setSnapshotState({ kind: "loading" });
            void refresh();
          }}
          type="button"
          variant="secondary"
        >
          Retry
        </OctantButton>
      </section>
    );
  }

  const { snapshot } = snapshotState;
  const account = snapshot.account;
  const connected = snapshot.state === "ready" || snapshot.state === "scope-limited";
  const reconnect =
    snapshot.state === "unauthorized" &&
    snapshot.remediation !== undefined &&
    snapshot.remediation.includes("Reconnect");
  const authorizationUri =
    snapshot.interaction?.kind === "authorization-redirect"
      ? snapshot.interaction.authorizationUri
      : undefined;

  return (
    <section aria-label="Linear" className="linear-settings" id="settings-linear">
      <SettingsPanel title="Workspace" description="Linear authentication on the selected host.">
        <SettingsFactList
          facts={[
            { label: "State", value: STATE_LABELS[snapshot.state] },
            ...(account === undefined ? [] : [{ label: "Workspace", value: account.login }]),
            ...(account === undefined ? [] : [{ label: "Source", value: account.source }]),
          ]}
        />
        {snapshot.remediation === undefined ? null : (
          <p className="linear-settings__note">{snapshot.remediation}</p>
        )}
        {authorizationUri === undefined ? null : (
          <p className="linear-settings__note">
            Continue in Linear:{" "}
            <a href={authorizationUri} rel="noreferrer" target="_blank">
              Approve access
            </a>
            , then refresh the status.
          </p>
        )}
      </SettingsPanel>

      <SettingsPanel
        title="Connection"
        description="Connect, reconnect, or remove local credentials."
      >
        <div className="linear-settings__controls">
          {snapshot.state === "unauthorized" ? (
            <OctantButton
              disabled={commandBusy}
              onClick={() => void runCommand("setup")}
              type="button"
              variant="secondary"
            >
              {reconnect ? "Reconnect" : "Connect"}
            </OctantButton>
          ) : null}
          <OctantButton
            disabled={commandBusy}
            onClick={() => {
              setSnapshotState({ kind: "loading" });
              void refresh();
            }}
            type="button"
            variant="secondary"
          >
            Refresh status
          </OctantButton>
          {connected ? (
            disconnectArmed ? (
              <OctantButton
                disabled={commandBusy}
                onClick={() => void runCommand("logout")}
                type="button"
                variant="destructive"
              >
                Confirm disconnect
              </OctantButton>
            ) : (
              <OctantButton
                disabled={commandBusy}
                onClick={() => setDisconnectArmed(true)}
                type="button"
                variant="secondary"
              >
                Disconnect
              </OctantButton>
            )
          ) : null}
        </div>
        {commandError === undefined ? null : (
          <SettingsState kind="error">{commandError}</SettingsState>
        )}
      </SettingsPanel>

      <SettingsPanel title="Advanced">
        <div className="linear-settings__controls">
          <OctantButton
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            Personal API key
          </OctantButton>
        </div>
        {advancedOpen ? (
          <div className="linear-settings__advanced">
            <p className="linear-settings__note">
              A personal API key is stored in the same host secret store as OAuth tokens. It is
              never used as a fallback when OAuth authorization expires.
            </p>
            <label className="linear-settings__note" htmlFor="linear-personal-api-key">
              Personal API key
            </label>
            <OctantInput
              autoComplete="off"
              id="linear-personal-api-key"
              onChange={(event) => setPersonalKey(event.currentTarget.value)}
              type="password"
              value={personalKey}
            />
            <div className="linear-settings__controls">
              <OctantButton
                disabled={personalBusy || personalKey.trim().length === 0}
                onClick={() => {
                  setPersonalBusy(true);
                  void client
                    .storePersonalCredential(personalKey)
                    .then(() => {
                      setPersonalKey("");
                      return refresh();
                    })
                    .catch((error: unknown) => {
                      setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be stored.",
                      );
                    })
                    .finally(() => setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Store key
              </OctantButton>
              <OctantButton
                disabled={personalBusy}
                onClick={() => {
                  setPersonalBusy(true);
                  void client
                    .deletePersonalCredential()
                    .then(() => refresh())
                    .catch((error: unknown) => {
                      setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be removed.",
                      );
                    })
                    .finally(() => setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Remove key
              </OctantButton>
            </div>
          </div>
        ) : null}
      </SettingsPanel>
    </section>
  );
}
