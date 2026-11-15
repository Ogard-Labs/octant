import { OctantEmpty } from "../ui/base/OctantEmpty";
import { ArrowDown, ArrowUp, X } from "../ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
  NativeHarnessJob,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSlot,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderReadiness,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import type { PickerGroup, PickerModel } from "@octant/domain";
import type { ModelToolVerification } from "../providers/useProviderController";
import { SettingsDisclosure, SettingsSection, useRevealedFocus } from "../settings/primitives";
import { settingId } from "../settings/registry";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { ModelRoleEditor } from "./ModelRoleEditor";
import { nativeHarnessReadinessById } from "./modelRoleOptions";
import {
  ADVISOR_ROLE,
  MODEL_ROLES,
  ROLE_FLAGS_NOTE,
  rolePresentation,
  slotWithCandidates,
} from "./modelRoles";
import "./native-harness.css";

/** A configured direct endpoint, whether or not it has listed models yet. */
export interface NativeHarnessProviderOption {
  readonly instanceId: string;
  readonly label: string;
  readonly modelCount: number;
  /** What the endpoint last reported; absent when it was never probed. */
  readonly readiness?: ProviderReadiness;
}

export interface NativeHarnessRoutingPanelProps {
  readonly client: Pick<NativeHarnessClient, "routing" | "updateRouting">;
  readonly hostId: string;
  /** Configured direct-endpoint providers. Without any, the section explains why it is empty. */
  readonly providers: ReadonlyArray<NativeHarnessProviderOption>;
  /** The harness endpoints' models as the compact model chooser lists them. */
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly onOpenModelEndpoints?: () => void;
  /** One explicit request that proves whether a model calls tools; absent hides the action. */
  readonly onVerifyTools?: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => Promise<ModelToolVerification>;
  /** A search result or link named Model roles: land on the Builder. */
  readonly focused?: boolean;
}

type EditableJob = Exclude<NativeHarnessJob, "lead">;

/**
 * Plain names for the jobs a role can take. The lead is left out: it runs on
 * the model picked in the thread's composer, and the Builder only takes over
 * when that model stops answering, so offering to rebind it here would
 * describe something the harness does not do.
 */
const JOB_LABELS: Readonly<Record<EditableJob, string>> = {
  planner: "Planning",
  explorer: "Exploring the code",
  researcher: "Research",
  implementer: "Implementing",
  reviewer: "Reviewing finished work",
  title: "Thread titles",
  summary: "Summaries",
  compaction: "Shortening long threads",
  "image-understanding": "Reading images",
  advisor: "Advisor",
  custom: "Custom helper agents",
};
// The advisor runs only on the Advisor role, so the role row's Off and
// "Turn the advisor off" are the whole truth; binding it to another role here
// would keep it running while the page says it is off.
const EDITABLE_JOBS = NativeHarnessJob.literals.filter(
  (job): job is EditableJob => job !== "lead" && job !== "advisor",
);

const STALE_MESSAGE = "Changed elsewhere. Reloaded; make your change again.";

/** The roles, by their Settings names, that list a model from this endpoint. */
export function nativeHarnessSlotsUsing(
  configuration: NativeHarnessRoutingConfiguration,
  providerInstanceId: string,
): ReadonlyArray<string> {
  return configuration.slots
    .filter(
      (slot) =>
        slot.candidates.some(
          (candidate) => String(candidate.providerInstanceId) === providerInstanceId,
        ) || String(slot.overflowPromotion?.providerInstanceId) === providerInstanceId,
    )
    .map((slot) => rolePresentation(String(slot.id)).label);
}

/**
 * Settings → Octant Harness → Model roles. A role (a slot, in the CLI and the
 * guide) is an ordered list of models: the main one, then fallbacks. Every
 * change is sent at once with the version it was read at, so two editors
 * cannot silently overwrite each other and nothing waits behind a Save step.
 */
export function NativeHarnessRoutingPanel(props: NativeHarnessRoutingPanelProps) {
  const [settings, setSettings] = useState<NativeHarnessRoutingSettings>();
  // The change being sent, shown at once so a choice never snaps back while it saves.
  const [pending, setPending] = useState<NativeHarnessRoutingConfiguration>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>();
  const landing = useRef<HTMLDivElement>(null);
  useRevealedFocus(landing, props.focused === true && status === "ready");

  const load = useCallback(async () => {
    try {
      const current = await props.client.routing();
      setSettings(current);
      setStatus("ready");
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Model roles are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(
    async (configuration: NativeHarnessRoutingConfiguration) => {
      if (settings === undefined || pending !== undefined) return;
      setPending(configuration);
      setMessage(undefined);
      try {
        const result = await props.client.updateRouting({
          configuration,
          expectedVersion: settings.version,
        });
        if (result.kind === "routing-settings") {
          setSettings(result.settings);
        } else if (result.kind === "routing-refused" && result.reason === "stale-version") {
          setMessage(STALE_MESSAGE);
          await load();
        } else if (result.kind === "routing-refused") {
          setMessage(result.message);
        }
      } catch (error) {
        setMessage(
          error instanceof NativeHarnessClientFailure
            ? error.message
            : "Saving model roles failed.",
        );
      } finally {
        setPending(undefined);
      }
    },
    [props.client, settings, pending, load],
  );

  if (status === "loading") return <p role="status">Loading model roles…</p>;
  if (status === "error" || settings === undefined) {
    return (
      <OctantAlert className="native-harness-panel__error" tone="danger">
        {message ?? "Model roles are unavailable."}
      </OctantAlert>
    );
  }

  const configuration = pending ?? settings.configuration;
  const saving = pending !== undefined;
  const shownIds = new Set<string>([...MODEL_ROLES.map((role) => role.id), ADVISOR_ROLE.id]);
  // A role this page has no name for (a custom slot, saved from the CLI) still
  // shows, under Other roles, so it cannot hide a model Octant would use.
  const otherRoles = [
    ADVISOR_ROLE,
    ...configuration.slots
      .map((slot) => String(slot.id))
      .filter((id) => !shownIds.has(id))
      .map(rolePresentation),
  ];
  const slotIds = [
    ...new Set([
      ...NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
      ...configuration.slots.map((slot) => String(slot.id)),
    ]),
  ];
  const slotFor = (id: string) => configuration.slots.find((slot) => String(slot.id) === id);
  const withSlot = (
    id: string,
    next: NativeHarnessSlot | undefined,
  ): NativeHarnessRoutingConfiguration => ({
    ...configuration,
    slots: [
      ...configuration.slots.filter((slot) => String(slot.id) !== id),
      ...(next === undefined ? [] : [next]),
    ],
  });

  const modelsOf = (group: PickerGroup) => group.sections.flatMap((section) => section.models);
  const hasModels = props.groups.some((group) => modelsOf(group).length > 0);
  const waitingProviders = props.providers.filter((option) => option.modelCount === 0);
  // Octant never picks a model by itself. With exactly one endpoint ready and
  // no Builder, it offers one, and the person decides.
  const readyGroups = props.groups.filter(
    (group) => group.readiness === "ready" && modelsOf(group).length > 0,
  );
  const suggestedGroup =
    readyGroups.length === 1 && (slotFor("default")?.candidates.length ?? 0) === 0
      ? readyGroups[0]
      : undefined;
  const suggestedModel: PickerModel | undefined =
    suggestedGroup === undefined
      ? undefined
      : (modelsOf(suggestedGroup).find((picker) => picker.toolsVerifiable !== true) ??
        modelsOf(suggestedGroup)[0]);
  const suggestedCount = suggestedGroup === undefined ? 0 : modelsOf(suggestedGroup).length;

  const standardSlot = (job: NativeHarnessJob) =>
    String(DEFAULT_NATIVE_HARNESS_JOB_SLOTS.find((binding) => binding.job === job)?.slotId);
  const boundSlot = (job: NativeHarnessJob) => {
    const explicit = configuration.jobSlots.find((binding) => binding.job === job)?.slotId;
    return explicit === undefined ? standardSlot(job) : String(explicit);
  };
  const standardJobs = EDITABLE_JOBS.every((job) => boundSlot(job) === standardSlot(job));
  // A fresh host stores the standard bindings, so only a chosen model or a
  // changed binding counts as routing someone saved.
  const hasSavedRouting =
    configuration.slots.some((slot) => slot.candidates.length > 0) || !standardJobs;

  const readiness = nativeHarnessReadinessById(props.providers);
  const editor = (role: {
    readonly id: string;
    readonly label: string;
    readonly meaning: string;
  }) => (
    <ModelRoleEditor
      disabled={saving}
      groups={props.groups}
      hostId={props.hostId}
      key={role.id}
      onChange={(next) => void commit(withSlot(role.id, next))}
      readiness={readiness}
      {...(props.onVerifyTools === undefined ? {} : { onVerifyTools: props.onVerifyTools })}
      role={role}
      slot={slotFor(role.id)}
    />
  );

  return (
    <section aria-label="Model roles" className="native-harness-panel">
      <SettingsSection
        description="Coordinator workers and helper agents use these roles. A thread you start yourself runs on the model you pick in its composer."
        title="Model roles"
      >
        {props.providers.length === 0 && !hasSavedRouting ? (
          <OctantEmpty
            layout="line"
            action={
              props.onOpenModelEndpoints === undefined ? null : (
                <OctantButton onClick={props.onOpenModelEndpoints} size="sm" variant="secondary">
                  Open Model endpoints
                </OctantButton>
              )
            }
            detail="Add a model endpoint above, then choose which of its models does which job."
            title="No model endpoint yet"
            tone="page"
          />
        ) : (
          <div className="setgroup native-harness-roles">
            {/* The outcome of the last change sits above the roles, where it is
                seen whichever row was changed. */}
            {message === undefined ? null : (
              <p className="native-harness-panel__message" role="status">
                {message}
              </p>
            )}
            {hasModels ? null : (
              <div className="native-harness-roles__notice">
                <span className="oct-meta">
                  {waitingProviders.length === 0
                    ? "No model endpoint is ready."
                    : `No models from ${waitingProviders.map((option) => option.label).join(", ")} yet.`}
                </span>
                {props.onOpenModelEndpoints === undefined ? null : (
                  <OctantButton onClick={props.onOpenModelEndpoints} size="sm" variant="secondary">
                    {props.providers.length === 0 ? "Add a model endpoint" : "Open Model endpoints"}
                  </OctantButton>
                )}
              </div>
            )}
            {suggestedGroup === undefined || suggestedModel === undefined ? null : (
              <div
                aria-label="Choose a Builder to start"
                className="native-harness-suggestion"
                role="group"
              >
                <div className="native-harness-suggestion__copy">
                  <span className="setrow-label">Choose a Builder to start</span>
                  <p className="setrow-hint">
                    {suggestedGroup.instance.displayName} has {suggestedCount} model
                    {suggestedCount === 1 ? "" : "s"}. Every role uses the Builder until you give it
                    its own.
                  </p>
                </div>
                <OctantButton
                  disabled={saving}
                  onClick={() =>
                    void commit(
                      withSlot(
                        "default",
                        slotWithCandidates("default", slotFor("default"), [
                          {
                            hostId: props.hostId as never,
                            providerInstanceId: suggestedGroup.instance.id,
                            modelId: suggestedModel.model.id,
                          },
                        ]),
                      ),
                    )
                  }
                  size="sm"
                  variant="default"
                >
                  Use {suggestedModel.model.displayName} as the Builder
                </OctantButton>
              </div>
            )}
            <p className="oct-meta native-harness-roles__flags">{ROLE_FLAGS_NOTE}</p>
            {MODEL_ROLES.map((role) =>
              role.id === "default" ? (
                <div
                  className="native-harness-role"
                  data-focused={props.focused === true ? "true" : "false"}
                  data-setting-id={settingId("model-roles")}
                  key={role.id}
                  ref={landing}
                >
                  {editor(role)}
                </div>
              ) : (
                <div className="native-harness-role" key={role.id}>
                  {editor(role)}
                </div>
              ),
            )}
            <SettingsDisclosure
              className="native-harness-jobs"
              title="Other roles"
              variant="inline"
            >
              {otherRoles.map((role) => (
                <div className="native-harness-role" key={role.id}>
                  {editor(role)}
                </div>
              ))}
            </SettingsDisclosure>
            <SettingsDisclosure
              className="native-harness-jobs"
              title={`Which job uses which role · ${standardJobs ? "standard" : "changed"}`}
              variant="inline"
            >
              {EDITABLE_JOBS.map((job) => (
                <div className="native-harness-job" key={job}>
                  <span>{JOB_LABELS[job]}</span>
                  <OctantSelectField
                    aria-label={`${JOB_LABELS[job]} role`}
                    className="settings-view__select"
                    disabled={saving}
                    onValueChange={(value) => {
                      if (value === boundSlot(job)) return;
                      void commit({
                        ...configuration,
                        jobSlots: [
                          ...configuration.jobSlots.filter((binding) => binding.job !== job),
                          { job, slotId: value as never },
                        ],
                      });
                    }}
                    options={slotIds.map((id) => ({ id, label: rolePresentation(id).label }))}
                    value={boundSlot(job)}
                  />
                </div>
              ))}
            </SettingsDisclosure>
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
