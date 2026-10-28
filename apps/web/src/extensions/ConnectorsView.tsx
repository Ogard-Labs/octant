import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionCommandFailure, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  CONNECTOR_CATEGORY_LABEL,
  connectorPackageName,
  searchConnectorCatalog,
  type ConnectorCatalogEntry,
  type ConnectorCategory,
} from "@octant/domain";
import { Search } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";
import { SettingsSection } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { thisComputerName, useHostPlatform } from "../platform";
import { McpServerSignInControl } from "./McpServerSignInControl";

const HIDDEN_KEY = "octant.connectors.hidden";
const CATEGORIES: ReadonlyArray<ConnectorCategory> = ["popular", "developer-tools", "business"];

export interface ConnectorsViewProps {
  readonly client: Pick<ExtensionClient, "addUserMcpServer" | "mcpServerSignIn">;
  readonly snapshot: ExtensionSnapshot | undefined;
  /** Whether this host keeps keys and runs sign-ins: the Octant window on it. */
  readonly localHost: boolean;
  readonly disabled: boolean;
  /** The toggle between Installed, Marketplace and Connectors, kept in the section's actions. */
  readonly actions: ReactNode;
  /** Told after a connector's package was added, so the installed set is read again. */
  readonly onConnected: () => void;
}

interface Connected {
  readonly extensionId: string;
  readonly componentId: string | undefined;
}

/**
 * Connectors: hosted MCP servers the app ships a list of. Connect adds the
 * server the same way Add MCP server does, then starts its sign-in, or takes
 * the vendor's key, or simply connects when the server asks for nothing.
 * Hide puts an entry out of sight on this computer; Show hidden brings every
 * entry back. Nothing here is fetched: the list is bundled data.
 */
export function ConnectorsView(props: ConnectorsViewProps) {
  const ids = useId();
  const hostPlatform = useHostPlatform();
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => readHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [keyFor, setKeyFor] = useState<string>();
  const [key, setKey] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [failure, setFailure] = useState<ExtensionCommandFailure>();
  const [connected, setConnected] = useState<Readonly<Record<string, Connected>>>({});
  const { client, snapshot } = props;

  const installedFor = (entry: ConnectorCatalogEntry): Connected | undefined => {
    const known = connected[entry.id];
    if (known !== undefined) return known;
    // A package the host marks as one it wrote, named `connector-<id>`: the
    // host gives that name only to a catalog add and refuses it to a
    // hand-added server. The name alone is not enough, since a third-party
    // plugin may carry it too and showed as Connected with no way to connect;
    // the installed source cannot tell either, because the host reports its
    // own packages as `plugin-package`.
    const pkg = snapshot?.packages.find(
      (candidate) =>
        candidate.activation.installed &&
        candidate.addedInSettings === true &&
        candidate.slug === connectorPackageName(entry.id),
    );
    if (pkg === undefined) return undefined;
    return {
      extensionId: String(pkg.extensionId),
      componentId: mcpComponentId(pkg),
    };
  };

  const connect = useCallback(
    async (entry: ConnectorCatalogEntry, secret?: string) => {
      setBusyId(entry.id);
      setFailure(undefined);
      try {
        const result = await client.addUserMcpServer({
          name: entry.displayName,
          connectorId: entry.id,
          server: {
            type: "streamable-http",
            url: entry.url,
            headers:
              entry.auth.kind === "key" && secret !== undefined
                ? [
                    {
                      name: entry.auth.header,
                      value:
                        entry.auth.prefix === undefined ? secret : `${entry.auth.prefix} ${secret}`,
                      secret: true,
                    },
                  ]
                : [],
          },
        });
        if (result.kind === "extension-command-failed") {
          setFailure(result.failure);
          return;
        }
        if (result.kind === "extension-state-updated" && result.addedPackage !== undefined) {
          const added = result.addedPackage;
          setConnected((current) => ({
            ...current,
            [entry.id]: {
              extensionId: String(added.extensionId),
              componentId: added.componentId === undefined ? undefined : String(added.componentId),
            },
          }));
        }
        setKeyFor(undefined);
        setKey("");
        props.onConnected();
      } catch (error) {
        setFailure({
          category: "unavailable",
          message: error instanceof Error ? error.message : "Extension service is unavailable.",
        });
      } finally {
        setBusyId(undefined);
      }
    },
    [client, props],
  );

  const hide = (id: string) => {
    const next = new Set(hidden);
    next.add(id);
    setHidden(next);
    writeHidden(next);
  };
  const showAll = () => {
    setHidden(new Set());
    writeHidden(new Set());
    setShowHidden(false);
  };

  const matching = searchConnectorCatalog(query);
  const listed = showHidden ? matching : matching.filter((entry) => !hidden.has(entry.id));
  const hiddenCount = matching.length - matching.filter((entry) => !hidden.has(entry.id)).length;

  return (
    <SettingsSection
      actions={props.actions}
      className="extensions-settings__section"
      description="Hosted services an agent can use once you connect them. Connecting adds the server to this host; nothing is fetched to show this list."
      title="Connectors"
    >
      <div className="extensions-settings__body">
        <div className="extensions-settings__search">
          <Search aria-hidden="true" className="icon" size={14} strokeWidth={1.5} />
          <OctantInput
            aria-label="Search connectors"
            className="extensions-settings__search-input"
            id={`${ids}-search`}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search connectors"
            value={query}
          />
          {hiddenCount > 0 || showHidden ? (
            <OctantButton
              onClick={() => (showHidden ? showAll() : setShowHidden(true))}
              size="sm"
              type="button"
              variant="ghost"
            >
              {showHidden ? "Show all again" : `Show hidden (${hiddenCount})`}
            </OctantButton>
          ) : null}
        </div>
        {!props.localHost ? (
          <p className="extensions-settings__state" role="status">
            Connect from the Octant window on this host; a browser-hosted Settings cannot keep a key
            or run a sign-in.
          </p>
        ) : null}
        {CATEGORIES.map((category) => {
          const entries = listed.filter((entry) => entry.category === category);
          if (entries.length === 0) return null;
          return (
            <section aria-label={CONNECTOR_CATEGORY_LABEL[category]} key={category}>
              <h3 className="connectors__category">{CONNECTOR_CATEGORY_LABEL[category]}</h3>
              <ul className="connectors">
                {entries.map((entry) => {
                  const installed = installedFor(entry);
                  const isHidden = hidden.has(entry.id);
                  return (
                    <li
                      className="connectors__row"
                      data-hidden={isHidden ? "true" : "false"}
                      key={entry.id}
                    >
                      <span className="connectors__text">
                        <span className="connectors__name">{entry.displayName}</span>
                        <span className="connectors__detail">{entry.description}</span>
                        {installed?.componentId !== undefined && entry.auth.kind === "sign-in" ? (
                          <McpServerSignInControl
                            autoBegin={connected[entry.id] !== undefined}
                            client={client}
                            componentId={installed.componentId}
                            disabled={props.disabled}
                            extensionId={installed.extensionId}
                          />
                        ) : null}
                        {keyFor === entry.id && entry.auth.kind === "key" ? (
                          <form
                            aria-label={`${entry.displayName} key`}
                            className="connectors__key"
                            noValidate
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (key.trim().length > 0) void connect(entry, key.trim());
                            }}
                          >
                            <OctantInput
                              aria-label="Key"
                              autoComplete="off"
                              className="settings-view__text-input"
                              onChange={(event) => setKey(event.currentTarget.value)}
                              spellCheck={false}
                              type="password"
                              value={key}
                            />
                            <OctantButton
                              disabled={props.disabled || busyId !== undefined}
                              size="sm"
                              type="submit"
                            >
                              Connect
                            </OctantButton>
                            <span className="connectors__detail">
                              Create one at{" "}
                              <a href={entry.auth.keyPage} rel="noreferrer" target="_blank">
                                {new URL(entry.auth.keyPage).host}
                              </a>
                              . Kept in {thisComputerName(hostPlatform)}&apos;s credential store.
                            </span>
                          </form>
                        ) : null}
                      </span>
                      <span className="connectors__actions">
                        {installed !== undefined ? (
                          <span className="connectors__detail" role="status">
                            Connected
                          </span>
                        ) : (
                          <OctantButton
                            aria-label={`Connect ${entry.displayName}`}
                            disabled={!props.localHost || props.disabled || busyId !== undefined}
                            onClick={() => {
                              if (entry.auth.kind === "key") {
                                setKeyFor(keyFor === entry.id ? undefined : entry.id);
                                setKey("");
                                return;
                              }
                              void connect(entry);
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {busyId === entry.id ? "Connecting…" : "Connect"}
                          </OctantButton>
                        )}
                        {isHidden ? null : (
                          <OctantButton
                            aria-label={`Hide ${entry.displayName}`}
                            onClick={() => hide(entry.id)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Hide
                          </OctantButton>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {listed.length === 0 ? (
          <p className="extensions-settings__state" role="status">
            No connector matches.
          </p>
        ) : null}
        {failure === undefined ? null : (
          <OctantAlert className="provider-settings__alert" tone="warning">
            {failure.message}
          </OctantAlert>
        )}
      </div>
    </SettingsSection>
  );
}

function mcpComponentId(pkg: ExtensionSnapshot["packages"][number]): string | undefined {
  const component = pkg.components.find((entry) => entry.component.kind === "mcp-server");
  return component === undefined ? undefined : String(component.component.id);
}

function readHidden(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(HIDDEN_KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeHidden(ids: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch {
    // A browser that refuses storage simply forgets the hidden set.
  }
}
