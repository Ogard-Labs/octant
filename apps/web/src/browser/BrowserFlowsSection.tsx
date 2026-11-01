import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserFlowSummary } from "@octant/contracts/browser-flows";
import { useCallback, useEffect, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";

export interface BrowserFlowsSectionProps {
  readonly client: Pick<BrowserAutomationClient, "manageFlows">;
  readonly focusedSetting?: string | undefined;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly flows: ReadonlyArray<BrowserFlowSummary> }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Settings › Data & privacy › Browser flows: the checks an agent saved in a
 * Project, each with its step count and where it starts, and a way to delete
 * it. The agent runs a flow by name; deleting is the person's, from here.
 */
export function BrowserFlowsSection(props: BrowserFlowsSectionProps) {
  const { client } = props;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [confirming, setConfirming] = useState<BrowserFlowSummary>();
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const manage = client.manageFlows;

  const refresh = useCallback(async () => {
    if (manage === undefined) {
      setLoaded({ kind: "unavailable", message: "Browser flows are not available here." });
      return;
    }
    try {
      const result = await manage.call(client, { kind: "list" });
      setLoaded(
        result.kind === "browser-flows"
          ? { kind: "ready", flows: result.flows }
          : {
              kind: "unavailable",
              message: result.kind === "browser-flows-refused" ? result.message : "",
            },
      );
    } catch {
      setLoaded({ kind: "unavailable", message: "Browser flows are unavailable." });
    }
  }, [client, manage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(flow: BrowserFlowSummary): Promise<void> {
    if (manage === undefined) return;
    setDeleting(true);
    try {
      const result = await manage.call(client, {
        kind: "delete",
        projectId: flow.projectId,
        name: flow.name,
      });
      setNotice(
        result.kind === "browser-flows-refused" ? result.message : `Deleted “${flow.name}”.`,
      );
    } catch {
      setNotice("The flow could not be deleted.");
    } finally {
      setDeleting(false);
      setConfirming(undefined);
      await refresh();
    }
  }

  return (
    <SettingsSection
      description="Checks an agent recorded in a Project and can replay by name. A flow holds fixed steps, never a script, and no page text."
      title="Browser flows"
    >
      {loaded.kind === "loading" ? <SettingsState kind="loading">Loading…</SettingsState> : null}
      {loaded.kind === "unavailable" ? (
        <SettingsState kind="empty">{loaded.message}</SettingsState>
      ) : null}
      {loaded.kind === "ready" && loaded.flows.length === 0 ? (
        <SettingsState kind="empty">
          No saved flows. Ask an agent to save a Browser check as a flow.
        </SettingsState>
      ) : null}
      {loaded.kind === "ready" && loaded.flows.length > 0 ? (
        <div className="setgroup">
          {loaded.flows.map((flow, index) => (
            <SettingRow
              description={`${flow.projectLabel} · ${flow.stepCount} ${
                flow.stepCount === 1 ? "step" : "steps"
              }${flow.firstAddress === undefined ? "" : ` · starts at ${flow.firstAddress}`}`}
              focused={props.focusedSetting === "browser-flows" && index === 0}
              key={`${flow.projectId}:${flow.name}`}
              label={flow.name}
              scope="host"
              settingId="browser-flows"
            >
              <div className="host-settings__controls">
                <OctantButton
                  aria-label={`Delete flow ${flow.name}`}
                  onClick={() => setConfirming(flow)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Delete…
                </OctantButton>
              </div>
            </SettingRow>
          ))}
        </div>
      ) : null}
      {notice === undefined ? null : <SettingsState kind="empty">{notice}</SettingsState>}
      {confirming === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Delete"
          destructive
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => void remove(confirming)}
          pending={deleting}
          title={`Delete “${confirming.name}”?`}
        >
          The agent can no longer replay this flow in {confirming.projectLabel}. You can ask it to
          record the check again.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
