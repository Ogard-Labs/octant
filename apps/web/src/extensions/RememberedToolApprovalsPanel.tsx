import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot, ExtensionToolGrant } from "@octant/contracts/extension-rpc";
import { useEffect, useMemo, useState } from "react";
import {
  SettingGroup,
  SettingsCompactRow,
  SettingsSection,
  SettingsState,
} from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { pluginNameIn, serverNameIn, UNNAMED_PLUGIN } from "./toolGrantLabels";

/** A Project that is no longer in the list still holds grants until they are revoked. */
const UNKNOWN_PROJECT = "A Project that is no longer listed";
/** Approvals remembered for the account, which only threads outside a Project use. */
const ACCOUNT_GROUP = "Chat outside a Project";

/** What a row calls its grant: the tool, or every tool of the server. */
function grantLabel(grant: ExtensionToolGrant, server: string | undefined): string {
  return grant.mcpToolName ?? `All tools of ${server ?? "one server"}`;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly grants: ReadonlyArray<ExtensionToolGrant> };

/**
 * MCP tools and whole servers a person chose to always allow, in a Project
 * or for the account, from an "always allow" answer on a tool request.
 * Revoking one makes the next call it covered ask again. Remembering is a local window's authority,
 * so a client that is not one draws nothing.
 */
export function RememberedToolApprovalsPanel(props: {
  readonly client: ExtensionClient;
  /** Project names by Project id, for the headings. */
  readonly projectNames: ReadonlyMap<string, string>;
  readonly focusedSetting?: string | undefined;
}) {
  const { client } = props;
  const available = client.toolGrantsAvailable;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot>();
  const [revoking, setRevoking] = useState<string>();
  const [notice, setNotice] = useState<
    { readonly kind: "success" | "error"; readonly text: string } | undefined
  >();

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    setLoaded({ kind: "loading" });
    client
      .listToolGrants(controller.signal)
      .then((grants) => {
        if (!controller.signal.aborted) setLoaded({ kind: "ready", grants });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ kind: "failed" });
      });
    // Names are a nicety: without them a row still names its tool.
    client
      .snapshot()
      .then((next) => {
        if (!controller.signal.aborted) setSnapshot(next);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [available, client]);

  const byProject = useMemo(() => {
    if (loaded.kind !== "ready") return [];
    const groups = new Map<string | undefined, Array<ExtensionToolGrant>>();
    for (const grant of loaded.grants) {
      const key = grant.projectId === undefined ? undefined : String(grant.projectId);
      groups.set(key, [...(groups.get(key) ?? []), grant]);
    }
    return [...groups.entries()]
      .map(([projectId, rows]) => ({
        projectId,
        name:
          projectId === undefined
            ? ACCOUNT_GROUP
            : (props.projectNames.get(projectId) ?? UNKNOWN_PROJECT),
        // A whole server's grant has no tool name and sorts ahead of its tools.
        rows: [...rows].sort((a, b) => (a.mcpToolName ?? "").localeCompare(b.mcpToolName ?? "")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [loaded, props.projectNames]);

  if (!available) return null;

  async function revoke(grant: ExtensionToolGrant, label: string) {
    setRevoking(String(grant.grantId));
    setNotice(undefined);
    try {
      // A grant the host no longer holds answers false: it is gone either way.
      await client.revokeToolGrant(String(grant.grantId));
      setLoaded((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              grants: current.grants.filter((entry) => entry.grantId !== grant.grantId),
            }
          : current,
      );
      setNotice({
        kind: "success",
        text: `${label} will ask again before it runs.`,
      });
    } catch {
      setNotice({
        kind: "error",
        text: `Octant could not revoke ${label}. It is still allowed.`,
      });
    } finally {
      setRevoking(undefined);
    }
  }

  const grantCount = loaded.kind === "ready" ? loaded.grants.length : 0;
  return (
    <SettingsSection
      // What a person allowed is authority: it opens whenever there is any, or
      // when it could not be read; the closed line still says how many.
      collapse={{
        open: grantCount > 0 || loaded.kind === "failed" || notice !== undefined,
        summary:
          loaded.kind === "loading"
            ? "Reading…"
            : loaded.kind === "failed"
              ? "Could not be read"
              : grantCount === 0
                ? "None remembered"
                : grantCount === 1
                  ? "1 approval remembered"
                  : `${grantCount} approvals remembered`,
      }}
      className="remembered-tool-approvals"
      description="Tools and servers you chose to always allow, in a Project or for Chat outside a Project. Revoking one makes Octant ask again the next time it runs."
      title="Remembered tool approvals"
    >
      {notice === undefined ? null : (
        <SettingsState kind={notice.kind}>{notice.text}</SettingsState>
      )}
      {loaded.kind === "loading" ? (
        <SettingsState kind="loading">Loading remembered tool approvals…</SettingsState>
      ) : loaded.kind === "failed" ? (
        <SettingsState kind="error">
          Octant could not load remembered tool approvals. Close Settings and open it again to
          retry.
        </SettingsState>
      ) : byProject.length === 0 ? (
        <SettingsState kind="empty">
          No remembered tool approvals. Choose “Always allow” or “Allow all tools of this server” on
          a tool request and it appears here.
        </SettingsState>
      ) : (
        byProject.map((group, groupIndex) => (
          <SettingGroup key={group.projectId ?? "account"} label={group.name}>
            {group.rows.map((grant, rowIndex) => {
              const plugin = pluginNameIn(snapshot, String(grant.packageId)) ?? UNNAMED_PLUGIN;
              const server = serverNameIn(
                snapshot,
                String(grant.packageId),
                String(grant.componentId),
              );
              const label = grantLabel(grant, server);
              const place =
                group.projectId === undefined
                  ? "in Chat threads outside a Project"
                  : "in this Project";
              return (
                <SettingsCompactRow
                  detail={
                    grant.mcpToolName === undefined
                      ? `Octant runs every tool of this server ${place} without asking, until an update comes from a different publisher or source, asks for more, or is rolled back.`
                      : `Octant runs it ${place} without asking.`
                  }
                  focused={
                    props.focusedSetting === "tool-approvals" && groupIndex === 0 && rowIndex === 0
                  }
                  key={String(grant.grantId)}
                  label={label}
                  metaWraps
                  meta={`Always allowed · From ${plugin}${server === undefined ? "" : `, server ${server}`}`}
                  settingId="tool-approvals"
                >
                  <OctantButton
                    aria-label={`Revoke ${label} in ${group.name}`}
                    disabled={revoking === String(grant.grantId)}
                    onClick={() => void revoke(grant, label)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Revoke
                  </OctantButton>
                </SettingsCompactRow>
              );
            })}
          </SettingGroup>
        ))
      )}
    </SettingsSection>
  );
}
