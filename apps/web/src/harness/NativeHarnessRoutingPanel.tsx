import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
  NativeHarnessJob,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { findPickerModel, type PickerGroup, type PickerModel } from "@octant/domain";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import type { ModelToolVerification } from "../providers/useProviderController";
import { SettingRow, SettingsDisclosure, SettingsSection } from "../settings/primitives";
import { settingId } from "../settings/registry";
import { SurfaceEmpty } from "../surface/SurfaceHeader";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import "./native-harness.css";

/** A configured direct endpoint, whether or not it has listed models yet. */
export interface NativeHarnessProviderOption {
  readonly instanceId: string;
  readonly label: string;
  readonly modelCount: number;
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
  /** A search result or link named Model roles: land on the main model. */
  readonly focused?: boolean;
}

type EditableJob = Exclude<NativeHarnessJob, "lead">;

/**
 * Plain names for the jobs a role can take. The lead is left out: it runs on
 * the model picked in the thread's composer, and the main model only takes
 * over when that model stops answering, so offering to rebind it here would
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
const EDITABLE_JOBS = NativeHarnessJob.literals.filter((job): job is EditableJob => job !== "lead");

/**
 * What each built-in slot is for. The CLI and the advanced guide still call
 * these slots; Settings names them by the job they do.
 */
const ROLE_PRESENTATION: Readonly<Record<string, { label: string; meaning: string }>> = {
  default: {
    label: "Main model",
    meaning: "Does the implementing, and takes over when a thread's own model stops answering.",
  },
  plan: { label: "Planning", meaning: "Works out the approach before work starts." },
  slow: { label: "Careful review", meaning: "A stronger model that checks finished work." },
  task: {
    label: "Research and lookups",
    meaning: "Helper agents that read code and look things up.",
  },
  smol: {
    label: "Quick jobs",
    meaning: "Titles, summaries and shortening long threads. A small, fast model is enough.",
  },
  vision: {
    label: "Reading images",
    meaning: "Screenshots and other images. Only models that accept images are offered.",
  },
  advisor: {
    label: "Advisor",
    meaning:
      "A second model reviews each turn and can pause the run for you. It costs one extra request per turn.",
  },
};

function rolePresentation(id: string): { label: string; meaning: string } {
  return ROLE_PRESENTATION[id] ?? { label: id, meaning: "A custom role." };
}

/** What an unset role does, in the words its chooser shows. */
function unsetLabel(id: string): string {
  if (id === "default") return "Choose model";
  // The advisor is off until chosen; every other role borrows the main model.
  if (id === "advisor") return "Off";
  return "Same as main model";
}

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
 * guide) is an ordered list of models: the first choice, then backups. Every
 * change is sent at once with the version it was read at, so two editors
 * cannot silently overwrite each other and nothing waits behind a Save step.
 */
export function NativeHarnessRoutingPanel(props: NativeHarnessRoutingPanelProps) {
  const [settings, setSettings] = useState<NativeHarnessRoutingSettings>();
  // The change being sent, shown at once so a choice never snaps back while it saves.
  const [pending, setPending] = useState<NativeHarnessRoutingConfiguration>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>();
  const [verifying, setVerifying] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  // A backup row the person added but has not chosen a model for. The host
  // refuses a candidate without a model, so it lives here until chosen.
  const [addingBackup, setAddingBackup] = useState<string>();

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

  const verifyTools = (candidate: NativeHarnessSlotCandidate, name: string) => {
    if (props.onVerifyTools === undefined || verifying !== undefined) return;
    setVerifying(nativeHarnessSlotCandidateKey(candidate));
    setMessage(undefined);
    void props
      .onVerifyTools(candidate.providerInstanceId, candidate.modelId)
      .then((outcome) => {
        if (outcome === "supported") setMessage(`${name} can use Octant's tools.`);
        else if (outcome === "unsupported") {
          setMessage(`${name} did not call the test tool, so it stays Chat only.`);
        } else setMessage(`Could not verify tools for ${name}.`);
      })
      .finally(() => setVerifying(undefined));
  };

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
  const slotIds = [
    ...new Set([
      ...NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
      ...configuration.slots.map((slot) => String(slot.id)),
    ]),
  ];
  const slotFor = (id: string) => configuration.slots.find((slot) => String(slot.id) === id);
  const candidatesFor = (id: string): ReadonlyArray<NativeHarnessSlotCandidate> =>
    slotFor(id)?.candidates ?? [];
  const withCandidates = (
    id: string,
    candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
  ): NativeHarnessRoutingConfiguration => {
    const saved = slotFor(id);
    // A role keeps the settings this page does not show, such as its overflow
    // promotion, while its models change; emptied, it is no longer configured.
    const next: NativeHarnessSlot | undefined =
      candidates.length === 0 ? undefined : { ...(saved ?? { id: id as never }), candidates };
    return {
      ...configuration,
      slots: [
        ...configuration.slots.filter((slot) => String(slot.id) !== id),
        ...(next === undefined ? [] : [next]),
      ],
    };
  };
  const candidateFrom = (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }): NativeHarnessSlotCandidate => ({
    hostId: props.hostId as never,
    providerInstanceId: selection.providerInstanceId,
    modelId: selection.modelId,
  });
  const pickerModelFor = (candidate: NativeHarnessSlotCandidate) =>
    findPickerModel(props.groups, {
      providerInstanceId: candidate.providerInstanceId,
      modelId: candidate.modelId,
    });
  const nameOf = (candidate: NativeHarnessSlotCandidate) =>
    pickerModelFor(candidate)?.model.displayName ?? String(candidate.modelId);
  const sourceOf = (candidate: NativeHarnessSlotCandidate) =>
    props.groups.find((group) => String(group.instance.id) === String(candidate.providerInstanceId))
      ?.instance.displayName;
  // Only models that accept images can read them, so that role offers no others.
  const groupsFor = (id: string): ReadonlyArray<PickerGroup> =>
    id !== "vision"
      ? props.groups
      : props.groups
          .map((group) => ({
            ...group,
            sections: group.sections
              .map((section) => ({
                ...section,
                models: section.models.filter((picker) =>
                  picker.model.inputModalities.includes("image"),
                ),
              }))
              .filter((section) => section.models.length > 0),
          }))
          .filter((group) => group.sections.length > 0);

  const modelsOf = (group: PickerGroup) => group.sections.flatMap((section) => section.models);
  const hasModels = props.groups.some((group) => modelsOf(group).length > 0);
  const waitingProviders = props.providers.filter((option) => option.modelCount === 0);
  // Octant never picks a model by itself. With exactly one endpoint ready and
  // no main model, it offers one, and the person decides.
  const readyGroups = props.groups.filter(
    (group) => group.readiness === "ready" && modelsOf(group).length > 0,
  );
  const suggestedGroup =
    readyGroups.length === 1 && candidatesFor("default").length === 0 ? readyGroups[0] : undefined;
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

  const chooser = (input: {
    readonly id: string;
    readonly ariaLabel: string;
    readonly candidate: NativeHarnessSlotCandidate | undefined;
    readonly unselected: string;
    readonly onSelect: (candidate: NativeHarnessSlotCandidate) => void;
  }) => {
    const groups = groupsFor(input.id);
    // With nothing to choose from, a saved choice still reads as itself
    // rather than as "No provider ready".
    if (groups.length === 0) {
      return (
        <span className="native-harness-role__chosen">
          {input.candidate === undefined ? input.unselected : nameOf(input.candidate)}
        </span>
      );
    }
    return (
      <ComposerModelPicker
        ariaLabel={input.ariaLabel}
        disabled={saving}
        groups={groups}
        menuSide="bottom"
        onSelect={(selection) => input.onSelect(candidateFrom(selection))}
        rememberChoice={false}
        selectedModelId={input.candidate?.modelId}
        selectedProviderInstanceId={input.candidate?.providerInstanceId}
        unselectedLabel={input.unselected}
      />
    );
  };

  return (
    <section aria-label="Model roles" className="native-harness-panel">
      <SettingsSection
        description="A thread runs on the model you pick in its composer. These roles cover the rest of the work."
        title="Model roles"
      >
        {props.providers.length === 0 && !hasSavedRouting ? (
          <SurfaceEmpty
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
                aria-label="Choose a main model to start"
                className="native-harness-suggestion"
                role="group"
              >
                <div className="native-harness-suggestion__copy">
                  <span className="setrow-label">Choose a main model to start</span>
                  <p className="setrow-hint">
                    {suggestedGroup.instance.displayName} has {suggestedCount} model
                    {suggestedCount === 1 ? "" : "s"}. Every role uses the main model until you give
                    it its own.
                  </p>
                </div>
                <OctantButton
                  disabled={saving}
                  onClick={() =>
                    void commit(
                      withCandidates("default", [
                        candidateFrom({
                          providerInstanceId: suggestedGroup.instance.id,
                          modelId: suggestedModel.model.id,
                        }),
                      ]),
                    )
                  }
                  size="sm"
                  variant="default"
                >
                  Use {suggestedModel.model.displayName} as the main model
                </OctantButton>
              </div>
            )}
            {slotIds.map((id) => {
              const candidates = candidatesFor(id);
              const first = candidates[0];
              const backups = candidates.slice(1);
              const { label, meaning } = rolePresentation(id);
              const open = expanded === id && first !== undefined;
              const editorId = `native-harness-role-${id}-models`;
              const chatOnly = candidates.filter(
                (candidate) => pickerModelFor(candidate)?.toolsVerifiable === true,
              );
              const source = first === undefined ? undefined : sourceOf(first);
              const replaceAt = (index: number, candidate: NativeHarnessSlotCandidate) => {
                const duplicate = candidates.some(
                  (existing, at) =>
                    at !== index &&
                    nativeHarnessSlotCandidateKey(existing) ===
                      nativeHarnessSlotCandidateKey(candidate),
                );
                if (duplicate) {
                  setMessage(`${nameOf(candidate)} is already in ${label}.`);
                  return;
                }
                const next = [...candidates];
                next[index] = candidate;
                if (index >= candidates.length) setAddingBackup(undefined);
                void commit(withCandidates(id, next));
              };
              const move = (index: number, by: -1 | 1) => {
                const next = [...candidates];
                const [moved] = next.splice(index, 1);
                if (moved === undefined) return;
                next.splice(index + by, 0, moved);
                void commit(withCandidates(id, next));
              };
              return (
                <div className="native-harness-role" key={id}>
                  <SettingRow
                    description={meaning}
                    focused={id === "default" && props.focused === true}
                    label={label}
                    scope="host"
                    settingId={settingId(`harness-slot-${id}`)}
                  >
                    <div className="native-harness-role__control">
                      {chooser({
                        id,
                        ariaLabel: `${label} model`,
                        candidate: first,
                        unselected: unsetLabel(id),
                        onSelect: (candidate) => replaceAt(0, candidate),
                      })}
                      {first === undefined || id === "default" ? null : (
                        <OctantButton
                          aria-label={
                            id === "advisor" ? "Turn the advisor off" : `${label}: use main model`
                          }
                          disabled={saving}
                          onClick={() => {
                            setExpanded(undefined);
                            void commit(withCandidates(id, []));
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {id === "advisor" ? "Turn off" : "Use main model"}
                        </OctantButton>
                      )}
                      {first === undefined ? null : (
                        <OctantButton
                          aria-controls={editorId}
                          aria-expanded={open}
                          aria-label={`${label} backups`}
                          onClick={() => {
                            setExpanded(open ? undefined : id);
                            setAddingBackup(undefined);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {backups.length === 0
                            ? "Add backup"
                            : `${backups.length} backup${backups.length === 1 ? "" : "s"}`}
                        </OctantButton>
                      )}
                    </div>
                    {first === undefined ? null : (
                      <span className="oct-meta native-harness-role__source">
                        {[
                          source ?? "Not offered by a ready endpoint",
                          backups[0] === undefined ? undefined : `Backup: ${nameOf(backups[0])}`,
                        ]
                          .filter((part): part is string => part !== undefined)
                          .join(" · ")}
                      </span>
                    )}
                    {/* Endpoints that do not report image input (an OpenAI-compatible
                        endpoint reports text only) leave this role nothing to offer;
                        saying so beats a chooser that silently lists no models. */}
                    {first !== undefined || !hasModels || groupsFor(id).length > 0 ? null : (
                      <span className="oct-meta native-harness-role__source">
                        No ready model says it accepts images.
                      </span>
                    )}
                  </SettingRow>
                  {chatOnly.length === 0 ? null : (
                    <div className="native-harness-role__notes">
                      {chatOnly.map((candidate) => (
                        <p className="oct-meta" key={nativeHarnessSlotCandidateKey(candidate)}>
                          {nameOf(candidate)} hasn't shown it can use Octant's tools, so it would
                          answer without them.{" "}
                          {props.onVerifyTools === undefined ? null : (
                            <OctantButton
                              aria-label={`Verify tools for ${nameOf(candidate)} (1 request)`}
                              disabled={verifying !== undefined}
                              onClick={() => verifyTools(candidate, nameOf(candidate))}
                              size="sm"
                              title="Sends one request to the endpoint, which it may bill."
                              variant="ghost"
                            >
                              {verifying === nativeHarnessSlotCandidateKey(candidate)
                                ? "Verifying…"
                                : "Verify tools (1 request)"}
                            </OctantButton>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                  {!open ? null : (
                    <div
                      aria-label={`${label} models`}
                      className="native-harness-backups"
                      id={editorId}
                      role="group"
                    >
                      {candidates.map((candidate, index) => {
                        const rank = index === 0 ? "First choice" : `Backup ${index}`;
                        const name = nameOf(candidate);
                        return (
                          <div
                            className="native-harness-backups__row"
                            key={nativeHarnessSlotCandidateKey(candidate)}
                          >
                            <span className="native-harness-backups__rank">{rank}</span>
                            {chooser({
                              id,
                              ariaLabel: `${label}, ${rank.toLowerCase()}`,
                              candidate,
                              unselected: "Choose model",
                              onSelect: (next) => replaceAt(index, next),
                            })}
                            <span className="native-harness-backups__actions">
                              <OctantButton
                                aria-label={`Move ${name} up`}
                                disabled={saving || index === 0}
                                onClick={() => move(index, -1)}
                                size="icon"
                                variant="ghost"
                              >
                                <ArrowUp aria-hidden="true" size={14} strokeWidth={1.7} />
                              </OctantButton>
                              <OctantButton
                                aria-label={`Move ${name} down`}
                                disabled={saving || index === candidates.length - 1}
                                onClick={() => move(index, 1)}
                                size="icon"
                                variant="ghost"
                              >
                                <ArrowDown aria-hidden="true" size={14} strokeWidth={1.7} />
                              </OctantButton>
                              <OctantButton
                                aria-label={`Remove ${name} from ${label}`}
                                disabled={saving}
                                onClick={() => {
                                  if (candidates.length === 1) setExpanded(undefined);
                                  void commit(
                                    withCandidates(
                                      id,
                                      candidates.filter((_, at) => at !== index),
                                    ),
                                  );
                                }}
                                size="icon"
                                variant="ghost"
                              >
                                <X aria-hidden="true" size={14} strokeWidth={1.7} />
                              </OctantButton>
                            </span>
                          </div>
                        );
                      })}
                      {addingBackup === id ? (
                        <div className="native-harness-backups__row">
                          <span className="native-harness-backups__rank">
                            Backup {candidates.length}
                          </span>
                          {chooser({
                            id,
                            ariaLabel: `${label}, new backup`,
                            candidate: undefined,
                            unselected: "Choose model",
                            onSelect: (next) => replaceAt(candidates.length, next),
                          })}
                          <span className="native-harness-backups__actions">
                            <OctantButton
                              aria-label={`Cancel the new backup for ${label}`}
                              onClick={() => setAddingBackup(undefined)}
                              size="icon"
                              variant="ghost"
                            >
                              <X aria-hidden="true" size={14} strokeWidth={1.7} />
                            </OctantButton>
                          </span>
                        </div>
                      ) : null}
                      <div className="native-harness-backups__add">
                        <OctantButton
                          aria-label={`Add a backup for ${label}`}
                          disabled={saving || addingBackup === id || groupsFor(id).length === 0}
                          onClick={() => setAddingBackup(id)}
                          size="sm"
                          variant="ghost"
                        >
                          Add backup
                        </OctantButton>
                        <span className="oct-meta">
                          A backup is used when the model before it is rate-limited, down or timing
                          out.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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
