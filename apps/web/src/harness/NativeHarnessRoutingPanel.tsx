import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
  NativeHarnessJob,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSlot,
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

export interface NativeHarnessProviderOption {
  readonly instanceId: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface NativeHarnessRoutingPanelProps {
  readonly client: Pick<NativeHarnessClient, "routing" | "updateRouting">;
  readonly hostId: string;
  /** Configured direct-endpoint providers. Without any, the editor explains why it is empty. */
  readonly providers: ReadonlyArray<NativeHarnessProviderOption>;
  readonly onOpenProviders?: () => void;
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

  const load = useCallback(async () => {
    try {
      const current = await props.client.routing();
      setSettings(current);
      setDraft(current.configuration);
      setStatus("ready");
    } catch (error) {
      setMessage(
        error instanceof NativeHarnessClientFailure
          ? error.message
          : "Model slots are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client]);

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
        setDraft(result.settings.configuration);
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
  }, [props.client, settings, draft, saving, load]);

  if (status === "loading") return <p role="status">Loading model slots…</p>;
  if (status === "error" || draft === undefined) {
    return (
      <OctantAlert className="native-harness-panel__error" tone="danger">
        {message ?? "Model slots are unavailable."}
      </OctantAlert>
    );
  }

  const slotIds = [
    ...NATIVE_HARNESS_BUILT_IN_SLOT_IDS,
    ...draft.slots
      .map((slot) => String(slot.id))
      .filter((id) => !(NATIVE_HARNESS_BUILT_IN_SLOT_IDS as ReadonlyArray<string>).includes(id)),
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
  // A provider with no observed models cannot fill a slot, so it must not be
  // the reason a button silently does nothing.
  const assignableProvider = props.providers.find((option) => option.models.length > 0);
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
                        props.onOpenProviders === undefined ? null : (
                          <OctantButton
                            onClick={props.onOpenProviders}
                            size="sm"
                            variant="secondary"
                          >
                            Connect a provider
                          </OctantButton>
                        )
                      ) : (
                        <OctantButton
                          aria-label={
                            slot === undefined || slot.candidates.length === 0
                              ? `Choose a model for ${label}`
                              : `Add a fallback model for ${label}`
                          }
                          onClick={() => {
                            const model = assignableProvider.models[0];
                            if (model === undefined) return;
                            const candidate = {
                              hostId: props.hostId as never,
                              providerInstanceId: assignableProvider.instanceId as never,
                              modelId: model.id as never,
                            };
                            setSlot(id, {
                              id: id as never,
                              candidates: [...(slot?.candidates ?? []), candidate],
                            });
                          }}
                          size="sm"
                          variant="secondary"
                        >
                          {slot === undefined || slot.candidates.length === 0
                            ? "Choose model"
                            : "Add fallback"}
                        </OctantButton>
                      )}
                    </SettingRow>
                    {(slot?.candidates ?? []).map((candidate, index) => {
                      const provider = props.providers.find(
                        (option) => option.instanceId === String(candidate.providerInstanceId),
                      );
                      return (
                        <div className="native-harness-candidate" key={`${id}-${index}`}>
                          <span className="native-harness-candidate__rank">
                            {index === 0 ? "primary" : `fallback ${index}`}
                          </span>
                          <OctantSelectField
                            aria-label={`${label}, model ${index + 1} provider`}
                            onValueChange={(value) => {
                              const next = props.providers.find(
                                (option) => option.instanceId === value,
                              );
                              if (next === undefined || slot === undefined) return;
                              const model = next.models[0];
                              if (model === undefined) return;
                              setSlot(id, {
                                ...slot,
                                candidates: slot.candidates.map((entry, at) =>
                                  at === index
                                    ? {
                                        ...entry,
                                        providerInstanceId: next.instanceId as never,
                                        modelId: model.id as never,
                                      }
                                    : entry,
                                ),
                              });
                            }}
                            options={props.providers.map((option) => ({
                              id: option.instanceId,
                              label: option.label,
                            }))}
                            value={String(candidate.providerInstanceId)}
                          />
                          <OctantSelectField
                            aria-label={`${label}, model ${index + 1}`}
                            onValueChange={(value) => {
                              if (slot === undefined) return;
                              setSlot(id, {
                                ...slot,
                                candidates: slot.candidates.map((entry, at) =>
                                  at === index ? { ...entry, modelId: value as never } : entry,
                                ),
                              });
                            }}
                            options={(
                              provider?.models ?? [
                                { id: String(candidate.modelId), label: String(candidate.modelId) },
                              ]
                            ).map((model) => ({ id: model.id, label: model.label }))}
                            value={String(candidate.modelId)}
                          />
                          <OctantButton
                            aria-label={`Remove ${label}, model ${index + 1}`}
                            onClick={() => {
                              if (slot === undefined) return;
                              const candidates = slot.candidates.filter((_, at) => at !== index);
                              setSlot(
                                id,
                                candidates.length === 0 ? undefined : { ...slot, candidates },
                              );
                            }}
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
                disabled={!dirty || saving}
                onClick={() => void save()}
                variant="default"
              >
                {saving ? "Saving…" : "Save slots"}
              </OctantButton>
              {dirty ? (
                <OctantButton onClick={() => setDraft(settings?.configuration)} variant="ghost">
                  Discard
                </OctantButton>
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
