import type { ProviderToolingClient } from "@octant/client-runtime/provider-tooling-client";
import type {
  McpPlanReadOnlySettings,
  McpPlanServerProvider,
} from "@octant/contracts/mcp-plan-read-only";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";

const PROVIDERS = [
  "claude",
  "codex",
  "opencode",
] as const satisfies ReadonlyArray<McpPlanServerProvider>;

const PRODUCT: Readonly<Record<McpPlanServerProvider, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The mark's own words, the same on every surface that sets it. */
export const PLAN_READ_ONLY_LABEL = "Read-only — allowed in Plan";

export interface McpPlanReadOnlySectionProps {
  readonly client: Pick<ProviderToolingClient, "planReadOnly" | "setPlanReadOnly">;
  /** The servers the selected account lists, offered as switches; absent on a paired device. */
  readonly listed?: {
    readonly provider: McpPlanServerProvider;
    readonly names: ReadonlyArray<string>;
  };
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly settings: McpPlanReadOnlySettings };

/**
 * The provider MCP servers a person lets into Plan. Plan writes nothing, so it
 * starts none of a provider's own servers unless the person marks one here. A
 * server's own claim to be read-only is never taken: the mark is the
 * person's, and each call still asks them. Marks are per server and per host,
 * journaled, and may be changed from a window on this computer or a device
 * the person paired.
 */
export function McpPlanReadOnlySection(props: McpPlanReadOnlySectionProps) {
  const { client } = props;
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [refusal, setRefusal] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<McpPlanServerProvider>("opencode");
  const [name, setName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setLoaded({ kind: "ready", settings: await client.planReadOnly() });
    } catch {
      setLoaded({ kind: "unavailable" });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const settings = loaded.kind === "ready" ? loaded.settings : undefined;
  const marked = (candidate: McpPlanServerProvider, serverName: string) =>
    settings?.servers.some(
      (server) => server.provider === candidate && server.serverName === serverName,
    ) === true;

  const set = async (
    candidate: McpPlanServerProvider,
    serverName: string,
    readOnly: boolean,
  ): Promise<boolean> => {
    if (settings === undefined) return false;
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await client.setPlanReadOnly({
        kind: "set-mcp-server-plan-read-only",
        provider: candidate,
        serverName,
        readOnly,
        expectedVersion: settings.version,
      });
      if (result.kind === "mcp-plan-read-only-refused") {
        setRefusal(result.message);
        void refresh();
        return false;
      }
      setLoaded({ kind: "ready", settings: result.settings });
      return true;
    } catch {
      setRefusal("Octant could not reach the host. Nothing changed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const serverName = name.trim();
    if (serverName.length === 0) return;
    if (await set(provider, serverName, true)) setName("");
  };

  return (
    <SettingsSection
      description="Plan writes nothing, so it starts none of a provider's own MCP servers unless you mark one. Mark only a server whose tools only read: Octant takes your word for it, never the server's own claim. Each call in Plan still asks you."
      title="MCP servers in Plan"
    >
      {loaded.kind === "loading" ? (
        <SettingsState kind="loading">Reading the servers allowed in Plan…</SettingsState>
      ) : loaded.kind === "unavailable" ? (
        <SettingsState kind="error">The servers allowed in Plan could not be read.</SettingsState>
      ) : (
        <>
          {props.listed === undefined || props.listed.names.length === 0 ? null : (
            <ul
              aria-label={`${PRODUCT[props.listed.provider]} servers in Plan`}
              className="connectors"
            >
              {props.listed.names.map((serverName) => {
                const listedProvider = props.listed?.provider ?? "claude";
                return (
                  <li className="connectors__row" key={serverName}>
                    <span className="connectors__text">
                      <span className="connectors__name">{serverName}</span>
                      <span className="connectors__detail">{PLAN_READ_ONLY_LABEL}</span>
                    </span>
                    <OctantSwitch
                      checked={marked(listedProvider, serverName)}
                      disabled={busy}
                      label={`${serverName}: ${PLAN_READ_ONLY_LABEL}`}
                      onCheckedChange={(checked) => void set(listedProvider, serverName, checked)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {loaded.settings.servers.length === 0 ? (
            <SettingsState kind="empty">
              No server is allowed in Plan. Plan starts only Octant&apos;s own tools.
            </SettingsState>
          ) : (
            <ul aria-label="Servers allowed in Plan" className="connectors">
              {loaded.settings.servers.map((server) => (
                <li className="connectors__row" key={`${server.provider}:${server.serverName}`}>
                  <span className="connectors__text">
                    <span className="connectors__name">{server.serverName}</span>
                    <span className="connectors__detail">
                      {PRODUCT[server.provider]} · {PLAN_READ_ONLY_LABEL}
                    </span>
                  </span>
                  <span className="connectors__actions">
                    <OctantButton
                      aria-label={`Withhold ${server.serverName} from Plan`}
                      disabled={busy}
                      onClick={() => void set(server.provider, server.serverName, false)}
                      size="sm"
                      variant="outline"
                    >
                      Withhold from Plan
                    </OctantButton>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form className="endpoint-flow__form" onSubmit={(event) => void add(event)}>
            <div className="endpoint-flow__field">
              <label htmlFor={`${ids}-provider`}>Provider</label>
              <OctantSelectField
                aria-label="Provider"
                id={`${ids}-provider`}
                onValueChange={(value) => {
                  const next = PROVIDERS.find((id) => id === value);
                  if (next !== undefined) setProvider(next);
                }}
                options={PROVIDERS.map((id) => ({
                  id,
                  label: PRODUCT[id],
                }))}
                value={provider}
              />
            </div>
            <div className="endpoint-flow__field">
              <label htmlFor={`${ids}-name`}>
                Server name, as the provider&apos;s settings name it
              </label>
              <OctantInput
                id={`${ids}-name`}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <OctantButton disabled={busy || name.trim().length === 0} size="sm" type="submit">
              Allow in Plan
            </OctantButton>
          </form>
          <p className="endpoint-flow__hint">
            A hosted server works in Plan. A server that runs on this computer may not start there,
            because Plan&apos;s sandbox can refuse to start programs: OpenCode on macOS starts none
            in Plan.
          </p>
        </>
      )}
      {refusal === undefined ? null : <OctantAlert tone="warning">{refusal}</OctantAlert>}
    </SettingsSection>
  );
}
