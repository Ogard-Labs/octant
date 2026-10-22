import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  DiscoveredAgentToolingListing,
  DiscoveredMcpServer,
  DiscoveredPlugin,
  ExtensionCommandFailure,
  ExtensionPackagePreview,
} from "@octant/contracts/extension-rpc";
import { useCallback, useEffect, useState } from "react";
import { SettingsSection } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

export interface DiscoveredToolingSectionProps {
  readonly client: Pick<ExtensionClient, "listDiscoveredTooling" | "applyDiscoveredTooling">;
  readonly disabled: boolean;
  /** A found server was added, installed and switched on. */
  readonly onServerAdded: () => void;
  /** A found plugin was read for review; the usual preview and Install follow. */
  readonly onPluginInspected: (preview: ExtensionPackagePreview) => void;
  /** Bumped by the page when the installed set changes, so the list is read again. */
  readonly revision: number;
}

const ORIGIN_LABEL = { "claude-code": "Claude Code", codex: "Codex" } as const;
const FORMAT_LABEL = {
  "agent-plugins": "Agent Plugins package",
  "codex-plugin": "Codex plugin",
  "claude-plugin": "Claude Code plugin",
} as const;

/** Why a found server cannot be copied as it is, or undefined when it can. */
function blockedReason(server: DiscoveredMcpServer): string | undefined {
  if (server.unsupportedPlaceholders.length > 0) {
    return `Uses ${server.unsupportedPlaceholders.join(", ")} in its command or address, which Octant does not copy. Add it by hand.`;
  }
  if (server.needsValues.length > 0) {
    return `Needs a value for ${server.needsValues.join(", ")}. Add it by hand and enter it there.`;
  }
  return undefined;
}

/**
 * Found on this Mac: the MCP servers and plugins Claude Code and Codex
 * already know here, each with one button that copies it into Octant. The
 * list is read-only until the person clicks; nothing is added by looking.
 */
export function DiscoveredToolingSection(props: DiscoveredToolingSectionProps) {
  const [listing, setListing] = useState<DiscoveredAgentToolingListing>();
  const [busyId, setBusyId] = useState<string>();
  // The refusal is shown in the row that was clicked, so it is seen there.
  const [failure, setFailure] = useState<{
    readonly id: string;
    readonly failure: ExtensionCommandFailure;
  }>();
  const { client, revision } = props;

  useEffect(() => {
    let cancelled = false;
    client
      .listDiscoveredTooling()
      .then((found) => {
        if (!cancelled) setListing(found);
      })
      .catch(() => {
        if (!cancelled) setListing(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [client, revision]);

  const addServer = useCallback(
    async (server: DiscoveredMcpServer) => {
      setBusyId(server.id);
      setFailure(undefined);
      try {
        const result = await client.applyDiscoveredTooling({ kind: "add-server", id: server.id });
        if (result.kind === "extension-command-failed") {
          setFailure({ id: server.id, failure: result.failure });
          return;
        }
        props.onServerAdded();
      } catch (error) {
        setFailure({
          id: server.id,
          failure: {
            category: "unavailable",
            message: error instanceof Error ? error.message : "Extension service is unavailable.",
          },
        });
      } finally {
        setBusyId(undefined);
      }
    },
    [client, props],
  );

  const importPlugin = useCallback(
    async (plugin: DiscoveredPlugin) => {
      setBusyId(plugin.id);
      setFailure(undefined);
      try {
        const result = await client.applyDiscoveredTooling({
          kind: "import-plugin",
          id: plugin.id,
        });
        if (result.kind === "extension-command-failed") {
          setFailure({ id: plugin.id, failure: result.failure });
          return;
        }
        if (result.kind === "package-inspected") props.onPluginInspected(result.preview);
      } catch (error) {
        setFailure({
          id: plugin.id,
          failure: {
            category: "unavailable",
            message: error instanceof Error ? error.message : "Extension service is unavailable.",
          },
        });
      } finally {
        setBusyId(undefined);
      }
    },
    [client, props],
  );

  if (listing === undefined) return null;
  if (listing.servers.length === 0 && listing.plugins.length === 0 && listing.notes.length === 0) {
    return null;
  }
  return (
    <SettingsSection
      className="extensions-settings__section"
      description="Servers and plugins other agent tools on this Mac already use. Adding one copies it into Octant; the other tool's files are not changed."
      title="Found on this Mac"
    >
      <div className="extensions-settings__body">
        {listing.servers.length === 0 ? null : (
          <ul aria-label="Servers found on this Mac" className="discovered-tooling">
            {listing.servers.map((server) => (
              <li className="discovered-tooling__row" key={server.id}>
                <span className="discovered-tooling__text">
                  <span className="discovered-tooling__name">{server.name}</span>
                  <span className="discovered-tooling__detail">
                    {ORIGIN_LABEL[server.origin]}
                    {server.scope === "project" ? " · in a Project" : ""} · {server.summary}
                  </span>
                  {server.secretNames.length > 0 ? (
                    <span className="discovered-tooling__detail">
                      Kept in the credential store: {server.secretNames.join(", ")}
                    </span>
                  ) : null}
                  {blockedReason(server) === undefined ? null : (
                    <span className="discovered-tooling__detail" role="note">
                      {blockedReason(server)}
                    </span>
                  )}
                  {failure?.id === server.id ? (
                    <OctantAlert className="provider-settings__alert" tone="warning">
                      {failure.failure.message}
                    </OctantAlert>
                  ) : null}
                </span>
                <OctantButton
                  disabled={
                    props.disabled || busyId !== undefined || blockedReason(server) !== undefined
                  }
                  onClick={() => void addServer(server)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busyId === server.id ? "Adding…" : "Add to Octant"}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
        {listing.plugins.length === 0 ? null : (
          <ul aria-label="Plugins found on this Mac" className="discovered-tooling">
            {listing.plugins.map((plugin) => (
              <li className="discovered-tooling__row" key={plugin.id}>
                <span className="discovered-tooling__text">
                  <span className="discovered-tooling__name">{plugin.name}</span>
                  <span className="discovered-tooling__detail">
                    {ORIGIN_LABEL[plugin.origin]} · {FORMAT_LABEL[plugin.format]}
                    {plugin.version === undefined ? "" : ` · v${plugin.version}`}
                    {plugin.enabledThere ? "" : " · off there"}
                  </span>
                  {failure?.id === plugin.id ? (
                    <OctantAlert className="provider-settings__alert" tone="warning">
                      {failure.failure.message}
                    </OctantAlert>
                  ) : null}
                </span>
                <OctantButton
                  disabled={props.disabled || busyId !== undefined}
                  onClick={() => void importPlugin(plugin)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busyId === plugin.id ? "Reading…" : "Review and import"}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
        {listing.notes.length === 0 ? null : (
          <ul aria-label="Left out" className="discovered-tooling__notes">
            {listing.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
