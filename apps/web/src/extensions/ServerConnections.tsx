import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  McpServerConnection,
  McpServerConnectionState,
} from "@octant/contracts/extension-rpc";
import { useState, type ReactNode } from "react";
import { SettingsSection } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge, type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { McpServerSignInControl } from "./McpServerSignInControl";

const LABEL: Record<McpServerConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  ready: "Ready",
  "needs-sign-in": "Needs sign-in",
  failed: "Not connecting",
  off: "Off",
  blocked: "Blocked",
};

const VARIANT: Record<McpServerConnectionState, OctantBadgeProps["variant"]> = {
  connected: "success",
  connecting: "secondary",
  ready: "secondary",
  "needs-sign-in": "warning",
  failed: "warning",
  off: "outline",
  blocked: "warning",
};

const TRANSPORT: Record<McpServerConnection["transport"], string> = {
  "streamable-http": "Hosted",
  stdio: "Runs on this computer",
  unknown: "Unknown transport",
};

/** Whether the row is a server the person has to act on before it works. */
export function connectionNeedsAttention(state: McpServerConnectionState): boolean {
  return state === "needs-sign-in" || state === "failed" || state === "blocked";
}

/** The state word, and for a server that is not working, the host's reason beside it. */
export function ConnectionStatus(props: {
  readonly connection: Pick<McpServerConnection, "state" | "reason">;
}) {
  const { state, reason } = props.connection;
  return (
    <span className="connection-status" data-state={state}>
      <OctantBadge variant={VARIANT[state]}>{LABEL[state]}</OctantBadge>
      {reason !== undefined && connectionNeedsAttention(state) ? (
        <span className="connection-status__reason">{reason}</span>
      ) : null}
    </span>
  );
}

function checkedLabel(checkedAt: string | undefined): string | undefined {
  if (checkedAt === undefined) return undefined;
  const at = new Date(checkedAt);
  return `Last checked ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export interface ServerConnectionsProps {
  readonly servers: ReadonlyArray<McpServerConnection> | undefined;
  readonly client: Pick<ExtensionClient, "mcpServerSignIn" | "reconnectMcpServer">;
  /** Whether this is the Octant window on the host: only it may sign in or reconnect. */
  readonly localHost: boolean;
  readonly disabled: boolean;
  /** Told after a Reconnect, so the listing is read again. */
  readonly onChanged: () => void;
  /** The view switch, kept in the first section's actions like the other views. */
  readonly actions?: ReactNode;
}

/**
 * Every installed MCP server and connector with how it is connecting. A row
 * that needs a sign-in offers it; a row whose connection failed offers
 * Reconnect, which drops the failed connection so the next task connects
 * fresh. The listing comes from what the host retained, never a probe.
 */
export function ServerConnections(props: ServerConnectionsProps) {
  const [busy, setBusy] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const servers = props.servers ?? [];

  const reconnect = async (server: McpServerConnection) => {
    const key = `${server.extensionId}:${server.componentId}`;
    setBusy(key);
    setRefusal(undefined);
    try {
      const result = await props.client.reconnectMcpServer({
        extensionId: String(server.extensionId),
        componentId: String(server.componentId),
      });
      if (result.kind === "refused") setRefusal(result.message);
    } catch {
      setRefusal("Reconnect did not reach the host. Try again.");
    } finally {
      setBusy(undefined);
      props.onChanged();
    }
  };

  return (
    <SettingsSection
      actions={props.actions}
      className="extensions-settings__section"
      title="Server connections"
    >
      <div className="extensions-settings__body">
        {props.servers === undefined ? (
          <p className="extensions-settings__state" role="status">
            Server connections could not be read.
          </p>
        ) : servers.length === 0 ? (
          <p className="extensions-settings__state" role="status">
            No MCP servers or connectors are installed.
          </p>
        ) : (
          <ul aria-label="Server connections" className="connectors">
            {servers.map((server) => {
              const key = `${server.extensionId}:${server.componentId}`;
              const checked = checkedLabel(server.checkedAt);
              return (
                <li className="connectors__row" data-state={server.state} key={key}>
                  <span className="connectors__text">
                    <span className="connectors__name">
                      {server.serverName === server.packageName
                        ? server.serverName
                        : `${server.packageName} · ${server.serverName}`}
                    </span>
                    <span className="connectors__detail">
                      {TRANSPORT[server.transport]}
                      {checked === undefined ? "" : ` · ${checked}`}
                    </span>
                    <ConnectionStatus connection={server} />
                  </span>
                  {props.localHost ? (
                    <span className="connectors__actions">
                      {server.state === "needs-sign-in" ? (
                        <McpServerSignInControl
                          client={props.client}
                          componentId={String(server.componentId)}
                          disabled={props.disabled}
                          extensionId={String(server.extensionId)}
                        />
                      ) : null}
                      {server.state === "failed" ? (
                        <OctantButton
                          aria-label={`Reconnect ${server.serverName}`}
                          disabled={props.disabled || busy !== undefined}
                          onClick={() => void reconnect(server)}
                          size="sm"
                          variant="outline"
                        >
                          {busy === key ? "Reconnecting…" : "Reconnect"}
                        </OctantButton>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {refusal === undefined ? null : (
          <OctantAlert className="provider-settings__alert" tone="warning">
            {refusal}
          </OctantAlert>
        )}
        <p className="connectors__detail">
          Reconnect drops a failed connection. The next task that uses the server connects again; a
          call that failed is not sent again.
        </p>
      </div>
    </SettingsSection>
  );
}
