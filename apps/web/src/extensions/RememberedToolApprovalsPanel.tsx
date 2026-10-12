import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot, ExtensionToolGrant } from "@octant/contracts/extension-rpc";
import { useEffect, useMemo, useState } from "react";
import { SettingGroup, SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { pluginNameIn, serverNameIn, UNNAMED_PLUGIN } from "./toolGrantLabels";

/** A Project that is no longer in the list still holds grants until they are revoked. */
const UNKNOWN_PROJECT = "A Project that is no longer listed";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly grants: ReadonlyArray<ExtensionToolGrant> };

/**
 * MCP tools a person chose to always allow in a Project, from the "Always
 * allow in this Project" answer on a tool request. Revoking one makes the
 * next call of that tool ask again. Remembering is a local window's authority,
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
    const groups = new Map<string, Array<ExtensionToolGrant>>();
    for (const grant of loaded.grants) {
      const key = String(grant.projectId);
      groups.set(key, [...(groups.get(key) ?? []), grant]);
    }
    return [...groups.entries()]
      .map(([projectId, rows]) => ({
        projectId,
        name: props.projectNames.get(projectId) ?? UNKNOWN_PROJECT,
        rows: [...rows].sort((a, b) => a.mcpToolName.localeCompare(b.mcpToolName)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [loaded, props.projectNames]);

  if (!available) return null;

  async function revoke(grant: ExtensionToolGrant) {
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
        text: `${grant.mcpToolName} will ask again before it runs.`,
      });
    } catch {
      setNotice({
        kind: "error",
        text: `Octant could not revoke ${grant.mcpToolName}. It is still allowed.`,
      });
    } finally {
      setRevoking(undefined);
    }
  }

  return (
    <SettingsSection
      className="remembered-tool-approvals"
      description="Tools you chose to always allow in a Project. Revoking one makes Octant ask again the next time that tool runs."
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
          No remembered tool approvals. Choose “Always allow in this Project” on a tool request and
          it appears here.
        </SettingsState>
      ) : (
        byProject.map((group, groupIndex) => (
          <SettingGroup key={group.projectId} label={group.name}>
            {group.rows.map((grant, rowIndex) => {
              const plugin = pluginNameIn(snapshot, String(grant.packageId)) ?? UNNAMED_PLUGIN;
              const server = serverNameIn(
                snapshot,
                String(grant.packageId),
                String(grant.componentId),
              );
              return (
                <SettingRow
                  description={`From ${plugin}${server === undefined ? "" : `, server ${server}`}. Octant runs it in this Project without asking.`}
                  focused={
                    props.focusedSetting === "tool-approvals" && groupIndex === 0 && rowIndex === 0
                  }
                  key={String(grant.grantId)}
                  label={grant.mcpToolName}
                  scope="host"
                  settingId="tool-approvals"
                >
                  <OctantButton
                    aria-label={`Revoke ${grant.mcpToolName} in ${group.name}`}
                    disabled={revoking === String(grant.grantId)}
                    onClick={() => void revoke(grant)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Revoke
                  </OctantButton>
                </SettingRow>
              );
            })}
          </SettingGroup>
        ))
      )}
    </SettingsSection>
  );
}
