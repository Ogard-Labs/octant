import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { CodeSettings } from "@octant/contracts/code";
import type { PermissionMode } from "@octant/contracts/providers";
import {
  permissionModeOf,
  permissionModeOfWorkAccess,
  threadAccessOf,
  workAccessOfPermissionMode,
} from "@octant/domain/guardrail-policy";
import { useEffect, useState } from "react";
import { useFullAccessWarning } from "../code/FullAccessWarning";
import { PERMISSION_MODE_OPTIONS } from "../code/PermissionModePicker";
import { ProjectPermissionModeSection } from "../projects/ProjectPermissionModeSection";
import { useProjectController } from "../projects/useProjectController";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { useWorkSettings } from "../work/useWorkSettings";

const CODE_MODE_OPTIONS = PERMISSION_MODE_OPTIONS.map((option) => ({
  id: option.id,
  label: option.label,
}));
// Work shares Code's levels and has no Plan overlay.
const WORK_MODE_OPTIONS = CODE_MODE_OPTIONS.filter((option) => option.id !== "plan");

export interface RemoteAccessDefaultsProps {
  readonly codeClient: Pick<CodeClient, "bootstrap" | "execute">;
  readonly workThreadClient: Pick<WorkThreadClient, "bootstrap" | "execute">;
  readonly projectClient: ProjectClient;
  readonly mode: "work" | "code";
  /** False while the session is stale: the host would not hear a change. */
  readonly connected: boolean;
}

/**
 * The mode new threads start in, for this host and for each of the mode's
 * Projects, on a browser the host's own person paired. Such a device sets a
 * level as a local window does (maintainer decision, 2026-11-12), so the same
 * choices and the same one-time Full access warning are shown and nothing asks
 * for an unlock first. The shell mounts this for no other session: the host
 * refuses these commands from a restricted one.
 */
export function RemoteAccessDefaults(props: RemoteAccessDefaultsProps) {
  const projects = useProjectController({ activeMode: props.mode, client: props.projectClient });
  const boundProjects = projects.projects.filter((project) => project.type !== "chat");

  return (
    <section aria-label="Default modes" className="remote-shell__device-panel">
      <h2 className="remote-shell__section-title">Default modes</h2>
      <span className="text-xs text-muted-foreground">New threads on this host</span>
      {props.mode === "code" ? (
        <CodeDefaultMode client={props.codeClient} connected={props.connected} />
      ) : (
        <WorkDefaultMode client={props.workThreadClient} connected={props.connected} />
      )}
      {boundProjects.map((project) => (
        <div className="flex flex-col gap-1" key={String(project.id)}>
          <span className="text-xs text-muted-foreground">{project.name}</span>
          <ProjectPermissionModeSection
            disabled={!props.connected}
            onChange={(mode, fullAccessSandbox) =>
              projects.setCodePermissionMode(project.id, mode, fullAccessSandbox ?? "keep")
            }
            project={project}
          />
        </div>
      ))}
      {projects.errorMessage === undefined ? null : (
        <OctantAlert tone="warning">{projects.errorMessage}</OctantAlert>
      )}
    </section>
  );
}

function DefaultModeSelect(props: {
  readonly options: ReadonlyArray<{ readonly id: PermissionMode; readonly label: string }>;
  readonly value: PermissionMode | undefined;
  readonly disabled: boolean;
  readonly message: string | undefined;
  readonly onChange: (mode: PermissionMode) => void;
}) {
  const warning = useFullAccessWarning("machine");
  return (
    <>
      <OctantSelectField
        aria-label="Default mode for new threads"
        disabled={props.disabled || props.value === undefined}
        onValueChange={(next) => {
          const option = props.options.find((candidate) => candidate.id === next);
          if (option === undefined) return;
          warning.guard(option.id, () => props.onChange(option.id));
        }}
        options={props.options}
        value={props.value ?? ""}
      />
      {props.message === undefined ? null : (
        <OctantAlert tone="warning">{props.message}</OctantAlert>
      )}
      {warning.dialog}
    </>
  );
}

function WorkDefaultMode(props: {
  readonly client: Pick<WorkThreadClient, "bootstrap" | "execute">;
  readonly connected: boolean;
}) {
  const work = useWorkSettings(props.client);
  return (
    <DefaultModeSelect
      disabled={!props.connected || work.busy}
      message={work.message}
      onChange={(mode) => {
        const defaultAccess = workAccessOfPermissionMode(mode);
        if (defaultAccess !== undefined) void work.update({ defaultAccess });
      }}
      options={WORK_MODE_OPTIONS}
      value={
        work.settings === undefined
          ? undefined
          : permissionModeOfWorkAccess(work.settings.defaultAccess)
      }
    />
  );
}

function CodeDefaultMode(props: {
  readonly client: Pick<CodeClient, "bootstrap" | "execute">;
  readonly connected: boolean;
}) {
  const { client } = props;
  const [settings, setSettings] = useState<CodeSettings>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let current = true;
    void client
      .bootstrap()
      .then((bootstrap) => {
        if (current) setSettings(bootstrap.settings);
      })
      .catch(() => {
        if (current) setMessage("The default mode could not be read from the host.");
      });
    return () => {
      current = false;
    };
  }, [client]);

  async function change(mode: PermissionMode) {
    if (settings === undefined) return;
    const access = threadAccessOf(mode);
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await client.execute({
        kind: "update-code-settings",
        expectedVersion: settings.version,
        defaultExecutionPolicy: access.executionPolicy,
        defaultPermissionPersistence: settings.defaultPermissionPersistence,
        defaultAutoApprove: access.autoApprove,
      });
      if (result.kind === "settings-updated") setSettings(result.settings);
      else setMessage("The host did not change the default mode.");
    } catch {
      // A refusal, or a version another window moved on from: read what the
      // host holds now, so the select shows the truth and the next pick is
      // sent against it.
      setMessage("The host did not change the default mode.");
      await client
        .bootstrap()
        .then((bootstrap) => setSettings(bootstrap.settings))
        .catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DefaultModeSelect
      disabled={!props.connected || saving}
      message={message}
      onChange={(mode) => void change(mode)}
      options={CODE_MODE_OPTIONS}
      value={
        settings === undefined
          ? undefined
          : permissionModeOf({
              executionPolicy: settings.defaultExecutionPolicy,
              autoApprove: settings.defaultAutoApprove,
            })
      }
    />
  );
}
