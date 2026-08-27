import { useCallback, useEffect, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubAuthenticationCommand,
  GithubAuthenticationSnapshot,
  GithubAuthenticationState,
  GithubCapabilityKind,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsFactList, SettingsPanel, SettingsState } from "./primitives";

/**
 * The compact Settings connection card for one host's
 * GitHub account. It renders only what the server-authoritative snapshot
 * returned — account, honest per-capability state, setup/refresh/logout
 * commands, and clearly separated GitHub-side revocation guidance. No token,
 * credential path, or raw CLI output ever reaches this component; advanced
 * scope and storage diagnostics stay behind an explicit disclosure.
 */

export interface GitHubConnectionSettingsProps {
  readonly client: GithubClient;
}

type SnapshotState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: GithubAuthenticationSnapshot };

const STATE_LABELS: Readonly<Record<GithubAuthenticationState, string>> = {
  ready: "Connected",
  "scope-limited": "Connected (limited scopes)",
  unauthorized: "Not connected",
  "insecure-storage": "Blocked: insecure credential storage",
  "external-token": "Blocked: ambient token detected",
  "rate-limited": "Rate limited",
  unavailable: "Unavailable",
};

const CAPABILITY_LABELS: Readonly<Record<GithubCapabilityKind, string>> = {
  "repository-catalogue": "Repositories",
  "issues-read": "Issues",
  "pull-requests-read": "Pull requests",
  "projects-read": "Projects",
};

const GITHUB_APPLICATIONS_URL = "https://github.com/settings/applications";

export function GitHubConnectionSettings({ client }: GitHubConnectionSettingsProps) {
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: "loading" });
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [logoutArmed, setLogoutArmed] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.authenticationSnapshot();
      setSnapshotState({ kind: "ready", snapshot });
    } catch (error) {
      setSnapshotState({
        kind: "error",
        message: error instanceof Error ? error.message : "GitHub status is unavailable.",
      });
    }
  }, [client]);

  useEffect(() => {
    setSnapshotState({ kind: "loading" });
    void refresh();
  }, [refresh]);

  const runCommand = async (command: GithubAuthenticationCommand) => {
    setCommandBusy(true);
    setCommandError(undefined);
    try {
      const snapshot = await client.executeAuthenticationCommand(command);
      setSnapshotState({ kind: "ready", snapshot });
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "The GitHub command could not be delivered.",
      );
    } finally {
      setCommandBusy(false);
      setLogoutArmed(false);
    }
  };

  if (snapshotState.kind === "loading") {
    return (
      <section aria-label="GitHub" className="github-settings" id="settings-github">
        <SettingsState kind="loading">Loading GitHub status…</SettingsState>
      </section>
    );
  }

  if (snapshotState.kind === "error") {
    return (
      <section aria-label="GitHub" className="github-settings" id="settings-github">
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

  return (
    <section aria-label="GitHub" className="github-settings" id="settings-github">
      <SettingsPanel title="Account" description="GitHub authentication on the selected host.">
        <SettingsFactList
          facts={[
            { label: "State", value: STATE_LABELS[snapshot.state] },
            ...(account === undefined ? [] : [{ label: "Account", value: account.login }]),
          ]}
        />
        {snapshot.remediation === undefined && snapshot.interaction === undefined ? null : (
          <div className="settings-panel__stack">
            {snapshot.remediation === undefined ? null : (
              <p className="github-settings__note">{snapshot.remediation}</p>
            )}
            {snapshot.interaction === undefined ? null : (
              <div aria-live="polite" className="github-settings__device-flow">
                <p className="github-settings__note">
                  Enter this one-time code at{" "}
                  <a href={snapshot.interaction.verificationUri} rel="noreferrer" target="_blank">
                    github.com/login/device
                  </a>
                  , then refresh the status.
                </p>
                <code className="github-settings__device-code">
                  {snapshot.interaction.userCode}
                </code>
              </div>
            )}
          </div>
        )}
      </SettingsPanel>

      {snapshot.capabilities.length === 0 ? null : (
        <SettingsPanel title="Capabilities" description="GitHub data available to Octant.">
          <ul className="github-settings__capabilities settings-panel__stack">
            {snapshot.capabilities.map((capability) => (
              <li key={capability.kind}>
                <span>{CAPABILITY_LABELS[capability.kind]}</span>
                <span
                  className={
                    capability.available
                      ? "github-settings__capability-state github-settings__capability-state--available"
                      : "github-settings__capability-state github-settings__capability-state--unavailable"
                  }
                >
                  {capability.available ? "Available" : "Unavailable"}
                </span>
                {capability.remediation === undefined ? null : (
                  <span className="github-settings__note">{capability.remediation}</span>
                )}
              </li>
            ))}
          </ul>
        </SettingsPanel>
      )}

      <SettingsPanel title="Connection" description="Refresh scopes or remove local credentials.">
        <div className="github-settings__controls settings-panel__stack">
          {snapshot.state === "unauthorized" ? (
            <OctantButton
              disabled={commandBusy}
              onClick={() =>
                void runCommand({ kind: "setup", confirmation: "confirm-github-setup" })
              }
              type="button"
              variant="secondary"
            >
              Set up GitHub
            </OctantButton>
          ) : null}
          <OctantButton
            disabled={commandBusy}
            onClick={() => void refresh()}
            type="button"
            variant="secondary"
          >
            Refresh status
          </OctantButton>
          {connected ? (
            <OctantButton
              disabled={commandBusy}
              onClick={() =>
                void runCommand({
                  kind: "refresh",
                  confirmation: "confirm-github-refresh",
                  scopes: ["read:project"],
                })
              }
              type="button"
              variant="secondary"
            >
              Enable Projects metadata
            </OctantButton>
          ) : null}
          {connected ? (
            logoutArmed ? (
              <OctantButton
                disabled={commandBusy}
                onClick={() =>
                  void runCommand({ kind: "logout", confirmation: "confirm-github-local-logout" })
                }
                type="button"
                variant="destructive"
              >
                Confirm local logout
              </OctantButton>
            ) : (
              <OctantButton
                disabled={commandBusy}
                onClick={() => setLogoutArmed(true)}
                type="button"
                variant="secondary"
              >
                Log out on this host
              </OctantButton>
            )
          ) : null}
        </div>
        {commandError === undefined ? null : (
          <SettingsState kind="error">{commandError}</SettingsState>
        )}
      </SettingsPanel>

      <SettingsPanel title="Revoke access on GitHub">
        <div className="settings-panel__stack">
          <p className="github-settings__note">
            Logging out removes the credential from this host only; it does not revoke Octant's
            GitHub authorization. To revoke it, open your{" "}
            <a href={GITHUB_APPLICATIONS_URL} rel="noreferrer" target="_blank">
              GitHub application settings
            </a>{" "}
            and remove the GitHub CLI authorization.
          </p>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Advanced diagnostics">
        <div className="github-settings__diagnostics settings-panel__stack">
          <OctantButton
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            Advanced diagnostics
          </OctantButton>
          {diagnosticsOpen ? (
            <SettingsFactList
              facts={[
                { label: "Git protocol", value: account?.gitProtocol ?? "Unknown" },
                {
                  label: "Granted scopes",
                  value:
                    account === undefined || account.scopes.length === 0 ? (
                      "None reported"
                    ) : (
                      <ul className="github-settings__scopes">
                        {account.scopes.map((scope) => (
                          <li key={scope}>{scope}</li>
                        ))}
                      </ul>
                    ),
                },
              ]}
            />
          ) : null}
        </div>
      </SettingsPanel>
    </section>
  );
}
