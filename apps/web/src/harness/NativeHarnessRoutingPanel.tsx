import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
  NativeHarnessJob,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { settingId } from "../settings/registry";
import { SurfaceEmpty } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import "./native-harness.css";
import { OctantAlert } from "../ui/base/OctantAlert";
import type { ModelToolVerification } from "../providers/useProviderController";

export interface NativeHarnessProviderOption {
  readonly instanceId: string;
  readonly label: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    /**
     * Octant sends tools to this model. False means Chat only until a person
     * verifies it; absent when the page cannot tell.
     */
    readonly toolsReady?: boolean;
    /** Set up by hand on the provider, rather than only listed by its endpoint. */
    readonly configured?: boolean;
  }>;
}

export interface NativeHarnessRoutingPanelProps {
  readonly client: Pick<NativeHarnessClient, "routing" | "updateRouting">;
  readonly hostId: string;
  /** Configured direct-endpoint providers. Without any, the editor explains why it is empty. */
  readonly providers: ReadonlyArray<NativeHarnessProviderOption>;
  readonly onOpenProviders?: () => void;
  /** One explicit request that proves whether a model calls tools; absent hides the action. */
  readonly onVerifyTools?: (
    providerInstanceId: string,
    modelId: string,
  ) => Promise<ModelToolVerification>;
}

const JOB_LABELS: Readonly<Record<NativeHarnessJob, string>> = {
  lead: "Lead",
  planner: "Planner",
  explorer: "Explorer",
  researcher: "Researcher",
  implementer: "Implementer",
  reviewer: "Reviewer",
  title: "Titles",
  summary: "Summaries",
  compaction: "Compaction",
  "image-understanding": "Image understanding",
  advisor: "Advisor",
  custom: "Custom",
};

/**
 * What each built-in slot is for, in the words the Jobs list uses. The meanings
 * follow the slot design: Planner on `plan`, Reviewer on `slow`, Explorer and
 * Researcher on `task`, titles, summaries and compaction on `smol`, image
 * understanding on `vision`, and the supervisor on `advisor`.
 */
const SLOT_PRESENTATION: Readonly<Record<string, { label: string; meaning: string }>> = {
  default: {
    label: "Main model",
    meaning:
      "Leads each thread and does the implementing. Roles with no model of their own use it.",
  },
  plan: { label: "Planning", meaning: "Works out the approach before the work starts." },
  slow: {
    label: "Careful review",
    meaning: "A stronger, slower model that reviews finished work.",
  },
  task: {
    label: "Research and tasks",
    meaning: "Helper agents that explore the code and look things up.",
  },
  smol: {
    label: "Quick jobs",
    meaning: "A small, fast model for titles, summaries, and shortening long context.",
  },
  vision: { label: "Images", meaning: "Reads screenshots and other images." },
  advisor: { label: "Advisor", meaning: "Reviews each reply and steps in when a turn goes wrong." },
};

function slotPresentation(id: string): { label: string; meaning: string } {
  return SLOT_PRESENTATION[id] ?? { label: id, meaning: "A custom role." };
}

/**
 * A slot's model row as the person edits it. Observed models are presentation
 * only and never choose for the person, so a new row, or one moved to another
 * provider, stays unset until they pick a model. The host refuses a candidate
 * without one, so unset rows live here and only chosen rows reach the draft.
 */
type CandidateRow =
  | { readonly kind: "chosen"; readonly candidate: NativeHarnessSlotCandidate }
  | { readonly kind: "unset"; readonly providerInstanceId: string | undefined };

/**
 * Settings → Octant Harness → Model slots. A slot is an ordered list of models; jobs
 * map onto slots. Every edit round-trips through the host with the version it
 * was read at, so two editors cannot silently overwrite each other.
 */
export function NativeHarnessRoutingPanel(props: NativeHarnessRoutingPanelProps) {
  const [settings, setSettings] = useState<NativeHarnessRoutingSettings>();
  const [draft, setDraft] = useState<NativeHarnessRoutingConfiguration>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<string>();
  // Rows of slots edited since the draft was last reset; untouched slots read
  // their rows straight from the draft.
  const [editedRows, setEditedRows] = useState<
    Readonly<Record<string, ReadonlyArray<CandidateRow>>>
  >({});

  const resetDraft = useCallback((configuration: NativeHarnessRoutingConfiguration) => {
    setDraft(configuration);
    setEditedRows({});
  }, []);

  const load = useCallback(async () => {
    try {
      const current = await props.client.routing();
      setSettings(current);
      resetDraft(current.configuration);
      setStatus("ready");
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Model slots are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client, resetDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () =>
      settings !== undefined && JSON.stringify(settings.configuration) !== JSON.stringify(draft),
    [settings, draft],
  );

  const save = useCallback(async () => {
    if (settings === undefined || draft === undefined || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await props.client.updateRouting({
        configuration: draft,
        expectedVersion: settings.version,
      });
      if (result.kind === "routing-settings") {
        setSettings(result.settings);
        resetDraft(result.settings.configuration);
      } else if (result.kind === "routing-refused" && result.reason === "stale-version") {
        setMessage(
          "Model slots changed elsewhere. Reloaded the current table; apply your edit again.",
        );
        await load();
      } else if (result.kind === "routing-refused") {
        setMessage(result.message);
      }
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure ? error.message : "Saving model slots failed.",
      );
    } finally {
      setSaving(false);
    }
  }, [props.client, settings, draft, saving, load, resetDraft]);

  const verifyTools = (providerId: string, modelId: string) => {
    if (props.onVerifyTools === undefined || verifying !== undefined) return;
    setVerifying(`${providerId}:${modelId}`);
    setMessage(undefined);
    void props
      .onVerifyTools(providerId, modelId)
      .then((outcome) => {
        if (outcome === "supported") setMessage(`${modelId} supports Octant tools.`);
        else if (outcome === "unsupported") {
          setMessage(`${modelId} did not call the test tool, so it stays Chat only.`);
        } else setMessage(`Could not verify tools for ${modelId}.`);
      })
      .finally(() => setVerifying(undefined));
  };

  if (status === "loading") return <p role="status">Loading model slots…</p>;
  if (status === "error" || draft === undefined) {
    return (
      <OctantAlert className="native-harness-panel__error" tone="danger">
        {message ?? "Model slots are unavailable."}
      </OctantAlert>
    );
  }

  // A slot whose only row is unset is out of the draft, but its row is still on
  // screen, so a custom slot stays listed while it has edited rows.
  const slotIds = [
    ...new Set([
      ...NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
      ...draft.slots.map((slot) => String(slot.id)),
      ...Object.keys(editedRows),
    ]),
  ];
  const slotFor = (id: string) => draft.slots.find((slot) => String(slot.id) === id);
  const setSlot = (id: string, next: NativeHarnessSlot | undefined) =>
    setDraft({
      ...draft,
      slots: [
        ...draft.slots.filter((slot) => String(slot.id) !== id),
        ...(next === undefined ? [] : [next]),
      ],
    });
  const rowsFor = (id: string): ReadonlyArray<CandidateRow> =>
    editedRows[id] ??
    (slotFor(id)?.candidates ?? []).map((candidate) => ({ kind: "chosen", candidate }));
  const setRows = (id: string, rows: ReadonlyArray<CandidateRow>) => {
    setEditedRows({ ...editedRows, [id]: rows });
    const candidates = rows.flatMap((row) => (row.kind === "chosen" ? [row.candidate] : []));
    // Leaving the draft while a row is unset must not lose settings this page
    // does not show, such as the overflow promotion, so fall back to the saved slot.
    const slot =
      slotFor(id) ?? settings?.configuration.slots.find((saved) => String(saved.id) === id);
    setSlot(
      id,
      candidates.length === 0 ? undefined : { ...(slot ?? { id: id as never }), candidates },
    );
  };
  const hasUnsetRow = Object.values(editedRows).some((rows) =>
    rows.some((row) => row.kind === "unset"),
  );
  // A provider with no observed models cannot fill a slot. While one is being
  // checked, or cannot list its models, the page still says it exists, so the
  // way out is its connection check rather than "Connect a provider".
  const assignableProvider = props.providers.find((option) => option.models.length > 0);
  const waitingProviders = props.providers.filter((option) => option.models.length === 0);
  const hasSavedRouting =
    draft.slots.some((slot) => slot.candidates.length > 0) || draft.jobSlots.length > 0;

  return (
    <section aria-label="Model slots" className="native-harness-panel">
      <SettingsSection title="Model slots">
        {props.providers.length === 0 && !hasSavedRouting ? (
          <SurfaceEmpty
            action={
              props.onOpenProviders === undefined ? null : (
                <OctantButton onClick={props.onOpenProviders} size="sm" variant="secondary">
                  Open Providers &amp; Models
                </OctantButton>
              )
            }
            detail="Connect an OpenAI-compatible or Anthropic-compatible provider in Providers & Models to assign models here."
            title="No direct-endpoint provider yet"
            tone="page"
          />
        ) : (
          <div className="settings-panel__body">
            <p className="native-harness-panel__lead">
              Each role is a list of models: the first is preferred and the rest are fallbacks. A
              role with no model uses the {slotPresentation("default").label} and shows a warning.
            </p>
            <div className="native-harness-slots">
              {slotIds.map((id) => {
                const slot = slotFor(id);
                const rows = rowsFor(id);
                const { label, meaning } = slotPresentation(id);
                return (
                  <div className="native-harness-slot" key={id}>
                    <SettingRow
                      description={
                        id === "default" || slot !== undefined
                          ? meaning
                          : `${meaning} Until set, it uses the ${slotPresentation("default").label}.`
                      }
                      label={label}
                      scope="app"
                      settingId={settingId(`harness-slot-${id}`)}
                    >
                      <span className="oct-meta native-harness-slot__count">
                        {slot === undefined || slot.candidates.length === 0
                          ? "Not set"
                          : `${slot.candidates.length} model${slot.candidates.length === 1 ? "" : "s"}`}
                      </span>
                      {assignableProvider === undefined ? (
                        <>
                          {waitingProviders.length === 0 ? null : (
                            <span className="oct-meta">
                              No models from{" "}
                              {waitingProviders.map((option) => option.label).join(", ")} yet.
                            </span>
                          )}
                          {props.onOpenProviders === undefined ? null : (
                            <OctantButton
                              onClick={props.onOpenProviders}
                              size="sm"
                              variant="secondary"
                            >
                              {waitingProviders.length === 0
                                ? "Connect a provider"
                                : "Open Providers & Models"}
                            </OctantButton>
                          )}
                        </>
                      ) : (
                        <OctantButton
                          aria-label={
                            rows.length === 0
                              ? `Choose a model for ${label}`
                              : `Add a fallback model for ${label}`
                          }
                          onClick={() =>
                            setRows(id, [...rows, { kind: "unset", providerInstanceId: undefined }])
                          }
                          size="sm"
                          variant="secondary"
                        >
                          {rows.length === 0 ? "Choose model" : "Add fallback"}
                        </OctantButton>
                      )}
                    </SettingRow>
                    {rows.map((row, index) => {
                      const providerId =
                        row.kind === "chosen"
                          ? String(row.candidate.providerInstanceId)
                          : row.providerInstanceId;
                      const provider = props.providers.find(
                        (option) => option.instanceId === providerId,
                      );
                      const providerOptions = props.providers
                        .filter(
                          (option) => option.models.length > 0 || option.instanceId === providerId,
                        )
                        .map((option) => ({ id: option.instanceId, label: option.label }));
                      // An endpoint that lists every model it hosts (an Azure
                      // resource lists hundreds that are not deployments) shows
                      // the models the person configured first, under their
                      // own heading, so a deployment is not buried.
                      const separatesConfigured = (provider?.models ?? []).some(
                        (model) => model.configured === true,
                      );
                      const modelOptions: Array<{ id: string; label: string; group?: string }> = [
                        ...(provider?.models ?? [])
                          .filter((model) => !separatesConfigured || model.configured === true)
                          .map((model) => ({
                            id: model.id,
                            label: model.label,
                            ...(separatesConfigured ? { group: "Configured models" } : {}),
                          })),
                        ...(provider?.models ?? [])
                          .filter((model) => separatesConfigured && model.configured !== true)
                          .map((model) => ({
                            id: model.id,
                            label: model.label,
                            group: "Discovered on the endpoint",
                          })),
                      ];
                      // A saved choice stays readable when its provider or model is
                      // no longer observed, rather than looking unset.
                      if (row.kind === "chosen") {
                        if (provider === undefined && providerId !== undefined) {
                          providerOptions.push({ id: providerId, label: providerId });
                        }
                        const modelId = String(row.candidate.modelId);
                        if (!modelOptions.some((model) => model.id === modelId)) {
                          modelOptions.push({ id: modelId, label: modelId });
                        }
                      }
                      const chosenModelId =
                        row.kind === "chosen" ? String(row.candidate.modelId) : "";
                      const chatOnly =
                        row.kind === "chosen" &&
                        provider?.models.find((model) => model.id === chosenModelId)?.toolsReady ===
                          false;
                      return (
                        <div className="native-harness-candidate" key={`${id}-${index}`}>
                          <span className="native-harness-candidate__rank">
                            {index === 0 ? "primary" : `fallback ${index}`}
                          </span>
                          <OctantSelectField
                            aria-label={`${label}, model ${index + 1} provider`}
                            onValueChange={(value) => {
                              if (value === providerId) return;
                              setRows(
                                id,
                                rows.map((entry, at) =>
                                  at === index
                                    ? { kind: "unset", providerInstanceId: value }
                                    : entry,
                                ),
                              );
                            }}
                            options={providerOptions}
                            placeholder="Choose a provider"
                            value={providerId ?? ""}
                          />
                          <OctantSelectField
                            aria-label={`${label}, model ${index + 1}`}
                            disabled={providerId === undefined}
                            onValueChange={(value) => {
                              if (providerId === undefined) return;
                              const candidate: NativeHarnessSlotCandidate =
                                row.kind === "chosen"
                                  ? { ...row.candidate, modelId: value as never }
                                  : {
                                      hostId: props.hostId as never,
                                      providerInstanceId: providerId as never,
                                      modelId: value as never,
                                    };
                              setRows(
                                id,
                                rows.map((entry, at) =>
                                  at === index ? { kind: "chosen", candidate } : entry,
                                ),
                              );
                            }}
                            options={modelOptions}
                            placeholder="Choose a model"
                            value={row.kind === "chosen" ? String(row.candidate.modelId) : ""}
                          />
                          {chatOnly ? (
                            <span className="native-harness-candidate__tools">
                              <span className="oct-meta">Chat only: tools not verified.</span>
                              {props.onVerifyTools === undefined ||
                              providerId === undefined ? null : (
                                <OctantButton
                                  aria-label={`Verify tools for ${label}, model ${index + 1}`}
                                  disabled={verifying !== undefined}
                                  onClick={() => verifyTools(providerId, chosenModelId)}
                                  size="sm"
                                  variant="outline"
                                >
                                  {verifying === `${providerId}:${chosenModelId}`
                                    ? "Verifying…"
                                    : "Verify tools"}
                                </OctantButton>
                              )}
                            </span>
                          ) : null}
                          <OctantButton
                            aria-label={`Remove ${label}, model ${index + 1}`}
                            onClick={() =>
                              setRows(
                                id,
                                rows.filter((_, at) => at !== index),
                              )
                            }
                            size="sm"
                            variant="ghost"
                          >
                            Remove
                          </OctantButton>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <h3 className="oct-section-label">Jobs</h3>
            <div className="native-harness-jobs">
              {NativeHarnessJob.literals.map((job) => {
                const bound =
                  draft.jobSlots.find((binding) => binding.job === job)?.slotId ??
                  DEFAULT_NATIVE_HARNESS_JOB_SLOTS.find((binding) => binding.job === job)?.slotId ??
                  "default";
                return (
                  <div className="native-harness-job" key={job}>
                    <span>{JOB_LABELS[job]}</span>
                    <OctantSelectField
                      aria-label={`${JOB_LABELS[job]} slot`}
                      className="settings-view__select"
                      onValueChange={(value) =>
                        setDraft({
                          ...draft,
                          jobSlots: [
                            ...draft.jobSlots.filter((binding) => binding.job !== job),
                            { job, slotId: value as never },
                          ],
                        })
                      }
                      options={slotIds.map((id) => ({ id, label: slotPresentation(id).label }))}
                      value={String(bound)}
                    />
                  </div>
                );
              })}
            </div>
            <div className="native-harness-panel__actions">
              <OctantButton
                disabled={!dirty || saving || hasUnsetRow}
                onClick={() => void save()}
                variant="default"
              >
                {saving ? "Saving…" : "Save slots"}
              </OctantButton>
              {(dirty || hasUnsetRow) && settings !== undefined ? (
                <OctantButton onClick={() => resetDraft(settings.configuration)} variant="ghost">
                  Discard
                </OctantButton>
              ) : null}
              {hasUnsetRow ? (
                <span className="oct-meta">
                  Choose a model in every row, or remove it, to save.
                </span>
              ) : null}
            </div>
            {message === undefined ? null : (
              <p className="native-harness-panel__message" role="status">
                {message}
              </p>
            )}
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
