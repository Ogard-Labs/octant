import { useCallback, useEffect, useState } from "react";
import {
  MAX_NATIVE_HARNESS_SLOT_CANDIDATES,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessProjectRoutingOverride,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type ProviderReadiness,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import {
  MODEL_ROLE_NEEDS,
  suggestModelRoles,
  type PickerGroup,
  type RoleSuggestion,
} from "@octant/domain";
import { roomOf } from "../usage/providerRoom";
import { useProviderRooms } from "../usage/useProviderRooms";
import { ModelRoleEditor } from "../harness/ModelRoleEditor";
import { roleSuggestionModels } from "../harness/modelRoleOptions";
import { RoleSuggestionPreview } from "../harness/RoleSuggestionPreview";
import { MODEL_ROLES, rolePresentation, slotFromSuggestion } from "../harness/modelRoles";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSelectField } from "../ui/base/OctantSelect";

const USE_SETTINGS = "settings";
const CHOOSE = "project";
const STALE_MESSAGE = "Changed elsewhere. Reloaded; make your change again.";

export interface ProjectModelRolesSectionProps {
  readonly client: Pick<
    NativeHarnessClient,
    "routing" | "updateRouting" | "projectRoutingState" | "setProjectRouting"
  >;
  readonly projectId: string;
  readonly hostId: string;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly readiness?: ReadonlyMap<string, ProviderReadiness>;
  readonly disabled?: boolean;
}

interface Loaded {
  readonly host: NativeHarnessRoutingSettings;
  readonly override: NativeHarnessProjectRoutingOverride | null;
  readonly overrideVersion: number;
}

/**
 * The Project's choice per role. A role is Settings' own until the Project
 * chooses for itself; a chosen role may keep only models Settings lists for it
 * (the host refuses anything else), and a model Settings lacks can be added to
 * Settings in the same step. Every change asserts the version it was read at.
 */
export function ProjectModelRolesSection(props: ProjectModelRolesSectionProps) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Roles the person switched to "Choose for this Project" that hold no model
  // yet; the host refuses a role without one, so they live here until a model
  // is picked.
  const [choosing, setChoosing] = useState<ReadonlySet<string>>(new Set());
  const rooms = useProviderRooms();
  // The suggestion being previewed for one role. Nothing is saved until accepted.
  const [preview, setPreview] = useState<RoleSuggestion>();

  const load = useCallback(async () => {
    try {
      const [host, state] = await Promise.all([
        props.client.routing(),
        props.client.projectRoutingState(props.projectId),
      ]);
      setLoaded({ host, override: state.override, overrideVersion: state.version });
      setStatus("ready");
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Model roles are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client, props.projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading") return <p role="status">Loading model roles…</p>;
  if (status === "error" || loaded === undefined) {
    return <OctantAlert tone="danger">{message ?? "Model roles are unavailable."}</OctantAlert>;
  }

  const hostSlot = (id: string): NativeHarnessSlot | undefined =>
    loaded.host.configuration.slots.find((slot) => String(slot.id) === id);
  const projectSlot = (id: string): NativeHarnessSlot | undefined =>
    loaded.override?.configuration.slots.find((slot) => String(slot.id) === id);
  const locked = props.disabled === true || saving;

  const saveOverride = async (
    id: string,
    next: NativeHarnessSlot | undefined,
  ): Promise<boolean> => {
    const current: NativeHarnessRoutingConfiguration = loaded.override?.configuration ?? {
      slots: [],
      jobSlots: [],
    };
    const configuration: NativeHarnessRoutingConfiguration = {
      ...current,
      slots: [
        ...current.slots.filter((slot) => String(slot.id) !== id),
        ...(next === undefined ? [] : [next]),
      ],
    };
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await props.client.setProjectRouting(props.projectId, {
        configuration,
        expectedVersion: loaded.overrideVersion,
      });
      if (result.kind === "project-routing-override") {
        setLoaded((now) =>
          now === undefined
            ? now
            : { ...now, override: result.override, overrideVersion: result.override.version },
        );
        return true;
      }
      if (result.kind === "routing-refused" && result.reason === "stale-version") {
        setMessage(STALE_MESSAGE);
        await load();
      } else if (result.kind === "routing-refused") {
        setMessage(result.message);
      }
      return false;
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Saving the Project's model roles failed.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addInSettings = async (
    id: string,
    candidate: NativeHarnessSlotCandidate,
  ): Promise<boolean> => {
    const saved = hostSlot(id);
    if ((saved?.candidates.length ?? 0) >= MAX_NATIVE_HARNESS_SLOT_CANDIDATES) {
      setMessage("Settings already lists as many models as a role can hold.");
      return false;
    }
    const slot: NativeHarnessSlot = saved
      ? { ...saved, candidates: [...saved.candidates, candidate] }
      : { id: id as never, candidates: [candidate] };
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await props.client.updateRouting({
        configuration: {
          ...loaded.host.configuration,
          slots: [
            ...loaded.host.configuration.slots.filter((entry) => String(entry.id) !== id),
            slot,
          ],
        },
        expectedVersion: loaded.host.version,
      });
      if (result.kind === "routing-settings") {
        setLoaded((now) => (now === undefined ? now : { ...now, host: result.settings }));
        return true;
      }
      if (result.kind === "routing-refused" && result.reason === "stale-version") {
        setMessage(STALE_MESSAGE);
        await load();
      } else if (result.kind === "routing-refused") setMessage(result.message);
      return false;
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Saving model roles in Settings failed.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  // A Project may use only what Settings lists for the role, so a suggestion
  // is drawn from that list alone.
  const suggestFor = (roleId: string) => {
    const allowed = new Set(
      (hostSlot(roleId)?.candidates ?? []).map(nativeHarnessSlotCandidateKey),
    );
    const models = roleSuggestionModels(
      props.groups,
      (instanceId) => roomOf(rooms, instanceId).standing === "limited",
    ).filter((model) =>
      allowed.has(`${props.hostId}:${model.providerInstanceId}:${model.modelId}`),
    );
    const builder = (projectSlot("default") ?? hostSlot("default"))?.candidates[0];
    const builderKind =
      builder === undefined
        ? undefined
        : props.groups.find(
            (group) => String(group.instance.id) === String(builder.providerInstanceId),
          )?.instance.driverKind;
    const [suggestion] = suggestModelRoles({
      models,
      roleIds: [roleId],
      ...(builderKind === undefined ? {} : { builderMain: { providerKind: builderKind } }),
    });
    if (suggestion !== undefined) setPreview(suggestion);
  };
  const useSuggestion = () => {
    if (preview === undefined) return;
    const roleId = preview.roleId;
    const slot = slotFromSuggestion(roleId, projectSlot(roleId), preview, props.hostId);
    setPreview(undefined);
    if (slot === undefined) return;
    void saveOverride(roleId, slot).then((saved) => {
      if (saved) setChoosing(new Set([...choosing].filter((id) => id !== roleId)));
    });
  };

  return (
    <div className="project-model-roles">
      <p className="oct-meta">
        Each role uses Settings unless this Project picks its own. A Project can pick only models
        Settings lists for the role.
      </p>
      {message === undefined ? null : (
        <p className="oct-meta" role="status">
          {message}
        </p>
      )}
      {MODEL_ROLES.map((role) => {
        const own = projectSlot(role.id);
        const chosen = own !== undefined || choosing.has(role.id);
        return (
          <div className="project-model-roles__role" key={role.id}>
            <ModelRoleEditor
              disabled={locked}
              groups={props.groups}
              hostId={props.hostId}
              {...(props.readiness === undefined ? {} : { readiness: props.readiness })}
              onChange={(next) => {
                void saveOverride(role.id, next).then((saved) => {
                  if (saved) setChoosing(new Set([...choosing].filter((id) => id !== role.id)));
                });
              }}
              headAction={
                <OctantSelectField
                  aria-label={`${role.label} for this Project`}
                  className="project-model-roles__choice"
                  disabled={locked}
                  onValueChange={(value) => {
                    if (value === CHOOSE && !chosen) {
                      const base = hostSlot(role.id);
                      if (base === undefined) {
                        setChoosing(new Set([...choosing, role.id]));
                      } else void saveOverride(role.id, base);
                    } else if (value === USE_SETTINGS && chosen) {
                      setChoosing(new Set([...choosing].filter((id) => id !== role.id)));
                      if (own !== undefined) void saveOverride(role.id, undefined);
                    }
                  }}
                  options={[
                    { id: USE_SETTINGS, label: "Use Settings" },
                    { id: CHOOSE, label: "Choose for this Project" },
                  ]}
                  value={chosen ? CHOOSE : USE_SETTINGS}
                />
              }
              {...(chosen && MODEL_ROLE_NEEDS.some((need) => need.roleId === role.id)
                ? { onSuggest: () => suggestFor(role.id) }
                : {})}
              readOnly={!chosen}
              role={role}
              slot={chosen ? own : hostSlot(role.id)}
              {...(chosen
                ? {
                    onAddInSettings: (candidate: NativeHarnessSlotCandidate) =>
                      addInSettings(role.id, candidate),
                    settingsModels: hostSlot(role.id)?.candidates ?? [],
                  }
                : {})}
            />
          </div>
        );
      })}
      {preview === undefined ? null : (
        <RoleSuggestionPreview
          onCancel={() => setPreview(undefined)}
          onUse={useSuggestion}
          suggestions={[{ label: rolePresentation(preview.roleId).label, suggestion: preview }]}
        />
      )}
    </div>
  );
}
