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
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import "./native-harness.css";

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
 * Settings → Agents → Model slots. A slot is an ordered list of models; jobs
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
      <p className="native-harness-panel__error" role="alert">
        {message ?? "Model slots are unavailable."}
      </p>
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
  const firstProvider = props.providers[0];

  return (
    <section aria-label="Model slots" className="native-harness-panel">
      <div className="settings-card-section settings-card-section--open">
        <h2>Model slots</h2>
        <p className="native-harness-panel__lead">
          Each slot is an ordered list of models: the first is used, the rest are fallbacks. Jobs
          the harness performs pick a slot. A job whose slot is empty runs on <code>default</code>{" "}
          with a visible warning.
        </p>
        {props.providers.length === 0 ? (
          <p className="native-harness-panel__empty" role="status">
            Add an OpenAI-compatible or Anthropic-compatible provider first; slots can only name
            models the harness can drive.
          </p>
        ) : null}
        <div className="native-harness-slots">
          {slotIds.map((id) => {
            const slot = slotFor(id);
            return (
              <div className="native-harness-slot" key={id}>
                <div className="native-harness-slot__head">
                  <code>{id}</code>
                  <span className="native-harness-slot__count">
                    {slot === undefined
                      ? "unconfigured"
                      : `${slot.candidates.length} model${slot.candidates.length === 1 ? "" : "s"}`}
                  </span>
                  {firstProvider === undefined ? null : (
                    <OctantButton
                      onClick={() => {
                        const model = firstProvider.models[0];
                        if (model === undefined) return;
                        const candidate = {
                          hostId: props.hostId as never,
                          providerInstanceId: firstProvider.instanceId as never,
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
                      Add model
                    </OctantButton>
                  )}
                </div>
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
                        aria-label={`${id} model ${index + 1} provider`}
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
                        aria-label={`${id} model ${index + 1}`}
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
                        aria-label={`Remove ${id} model ${index + 1}`}
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
        <h3>Jobs</h3>
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
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      jobSlots: [
                        ...draft.jobSlots.filter((binding) => binding.job !== job),
                        { job, slotId: value as never },
                      ],
                    })
                  }
                  options={slotIds.map((id) => ({ id, label: id }))}
                  value={String(bound)}
                />
              </div>
            );
          })}
        </div>
        <div className="native-harness-panel__actions">
          <OctantButton disabled={!dirty || saving} onClick={() => void save()} variant="default">
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
    </section>
  );
}
