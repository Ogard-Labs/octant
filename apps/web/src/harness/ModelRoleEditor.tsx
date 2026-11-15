import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  nativeHarnessSlotCandidateKey,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderReadiness,
} from "@octant/contracts";
import { findPickerModel, type PickerGroup } from "@octant/domain";
import { ComposerModelPicker, isComposerReasoningOption } from "../providers/ComposerModelPicker";
import { isConstrained, roomOf } from "../usage/providerRoom";
import { useProviderRooms } from "../usage/useProviderRooms";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  emptyRoleLabel,
  hasCandidate,
  slotWithCandidates,
  slotWithFlag,
  slotWithReasoning,
  type ModelRolePresentation,
  type RoleFlag,
} from "./modelRoles";

const DEFAULT_REASONING = "__default__";

export interface ModelRoleEditorProps {
  readonly role: ModelRolePresentation;
  /** The role as it is being edited: Settings' own, or the Project's choice. */
  readonly slot: NativeHarnessSlot | undefined;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly hostId: string;
  /**
   * What each configured endpoint last reported about itself, by instance id.
   * The chooser lists only ready endpoints, so a model on a signed-out one
   * is told apart from one nobody offers only by this.
   */
  readonly readiness?: ReadonlyMap<string, ProviderReadiness>;
  readonly disabled?: boolean;
  readonly onChange: (slot: NativeHarnessSlot | undefined) => void;
  /** One explicit request that proves whether a model calls tools; absent hides the action. */
  readonly onVerifyTools?: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => Promise<"supported" | "unsupported" | "failed">;
  /**
   * A Project may pick only what Settings lists for this role. Set, a model
   * outside that list is offered as "Add in Settings too" instead of being
   * taken.
   */
  readonly settingsModels?: ReadonlyArray<NativeHarnessSlotCandidate>;
  readonly onAddInSettings?: (candidate: NativeHarnessSlotCandidate) => Promise<boolean>;
  /** A Project that is using Settings shows the role read-only. */
  readonly readOnly?: boolean;
  /** Sits at the end of the role's heading line: a Project's Use Settings choice. */
  readonly headAction?: ReactNode;
}

function when(isoTime: string | undefined): string | undefined {
  if (isoTime === undefined) return undefined;
  const at = new Date(isoTime);
  return Number.isNaN(at.getTime())
    ? undefined
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * One role: its main model, the fallbacks behind it, and the two choices that
 * ride with the role. Used for Settings and for a Project that chose its own.
 */
export function ModelRoleEditor(props: ModelRoleEditorProps) {
  const rooms = useProviderRooms();
  const [adding, setAdding] = useState(false);
  const [needsSettings, setNeedsSettings] = useState<{
    readonly candidate: NativeHarnessSlotCandidate;
    readonly index: number;
  }>();
  const [note, setNote] = useState<string>();
  const [verifying, setVerifying] = useState<string>();
  const { role, slot } = props;
  const candidates = slot?.candidates ?? [];
  const readOnly = props.readOnly === true;
  const busy = props.disabled === true;
  const visionOnly = role.id === "vision";
  const groups = visionOnly
    ? props.groups
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
        .filter((group) => group.sections.length > 0)
    : props.groups;

  const candidateFrom = (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }): NativeHarnessSlotCandidate => ({
    hostId: props.hostId as never,
    providerInstanceId: selection.providerInstanceId,
    modelId: selection.modelId,
  });
  const pickerOf = (candidate: NativeHarnessSlotCandidate) =>
    findPickerModel(props.groups, {
      providerInstanceId: candidate.providerInstanceId,
      modelId: candidate.modelId,
    });
  const nameOf = (candidate: NativeHarnessSlotCandidate) =>
    pickerOf(candidate)?.model.displayName ?? String(candidate.modelId);

  const commit = (next: ReadonlyArray<NativeHarnessSlotCandidate>) => {
    setNote(undefined);
    props.onChange(slotWithCandidates(role.id, slot, next));
  };
  // A model goes in only when it is not already in the role, and a Project
  // takes only models Settings lists for the role.
  const place = (index: number, candidate: NativeHarnessSlotCandidate) => {
    const others = candidates.filter((_, at) => at !== index);
    if (hasCandidate(others, candidate)) {
      setNote(`${nameOf(candidate)} is already in ${role.label}.`);
      return;
    }
    if (props.settingsModels !== undefined && !hasCandidate(props.settingsModels, candidate)) {
      setNeedsSettings({ candidate, index });
      return;
    }
    const next = [...candidates];
    next[index] = candidate;
    setAdding(false);
    setNeedsSettings(undefined);
    commit(next);
  };
  const addInSettings = async (pending: {
    candidate: NativeHarnessSlotCandidate;
    index: number;
  }) => {
    if (props.onAddInSettings === undefined) return;
    const added = await props.onAddInSettings(pending.candidate);
    if (!added) return;
    // The model lands where the person picked it, not at the end.
    const next = [...candidates];
    next[pending.index] = pending.candidate;
    setNeedsSettings(undefined);
    setAdding(false);
    commit(next);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...candidates];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + by, 0, moved);
    commit(next);
  };
  const setFlag = (flag: RoleFlag, value: boolean) => {
    if (slot === undefined) return;
    props.onChange(slotWithFlag(slot, flag, value));
  };
  const verify = (candidate: NativeHarnessSlotCandidate) => {
    if (props.onVerifyTools === undefined || verifying !== undefined) return;
    const name = nameOf(candidate);
    setVerifying(nativeHarnessSlotCandidateKey(candidate));
    setNote(undefined);
    void props
      .onVerifyTools(candidate.providerInstanceId, candidate.modelId)
      .then((outcome) => {
        if (outcome === "supported") setNote(`${name} can use Octant's tools.`);
        else if (outcome === "unsupported") {
          setNote(`${name} did not call the test tool, so it stays Chat only.`);
        } else setNote(`Could not verify tools for ${name}.`);
      })
      .finally(() => setVerifying(undefined));
  };

  const chooser = (input: {
    readonly ariaLabel: string;
    readonly candidate: NativeHarnessSlotCandidate | undefined;
    readonly unselected: string;
    readonly onSelect: (candidate: NativeHarnessSlotCandidate) => void;
  }) => {
    if (groups.length === 0 || readOnly) {
      // With nothing to choose from, a saved choice still reads as itself.
      return (
        <span className="model-role__chosen">
          {input.candidate === undefined ? input.unselected : nameOf(input.candidate)}
        </span>
      );
    }
    return (
      <ComposerModelPicker
        ariaLabel={input.ariaLabel}
        disabled={busy}
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

  const tags = (candidate: NativeHarnessSlotCandidate) => {
    const picker = pickerOf(candidate);
    const group = props.groups.find(
      (entry) => String(entry.instance.id) === String(candidate.providerInstanceId),
    );
    const out: Array<{ readonly key: string; readonly text: string }> = [];
    const readiness =
      props.readiness?.get(String(candidate.providerInstanceId)) ?? group?.readiness;
    const unready =
      readiness === "unauthenticated"
        ? "Not signed in"
        : readiness === "unavailable" || readiness === "incompatible"
          ? "Not ready"
          : undefined;
    if (picker === undefined && unready === undefined) {
      out.push({ key: "missing", text: "Not offered by a ready endpoint" });
    }
    if (picker?.model.inputModalities.includes("image")) {
      out.push({ key: "images", text: "Reads images" });
    }
    if (unready !== undefined) out.push({ key: "unready", text: unready });
    const room = roomOf(rooms, String(candidate.providerInstanceId));
    if (room.standing === "limited") {
      const until = when(room.resetsAt);
      out.push({
        key: "limit",
        text: until === undefined ? "At usage limit" : `At usage limit until ${until}`,
      });
    } else if (isConstrained(room)) {
      out.push({ key: "near", text: "Near its usage limit" });
    }
    return out;
  };

  const reasoningOf = (candidate: NativeHarnessSlotCandidate, index: number) => {
    const option = pickerOf(candidate)?.model.options.find(
      (entry) => entry.kind === "selection" && isComposerReasoningOption(entry),
    );
    if (option === undefined || option.kind !== "selection") return null;
    return (
      <OctantSelectField
        aria-label={`${nameOf(candidate)} reasoning`}
        className="model-role__reasoning"
        disabled={busy || readOnly}
        onValueChange={(value) => {
          if (slot === undefined) return;
          props.onChange(
            slotWithReasoning(slot, index, value === DEFAULT_REASONING ? undefined : value),
          );
        }}
        options={[
          { id: DEFAULT_REASONING, label: "Reasoning: default" },
          ...option.values.map((value) => ({ id: value, label: `Reasoning: ${value}` })),
        ]}
        value={candidate.reasoning ?? DEFAULT_REASONING}
      />
    );
  };

  const headingId = `model-role-${role.id}`;
  return (
    <div aria-labelledby={headingId} className="model-role" role="group">
      <div className="model-role__head">
        <span className="model-role__name" id={headingId}>
          {role.label}
        </span>
        <span className="oct-meta">{role.meaning}</span>
        {props.headAction === undefined ? null : (
          <span className="model-role__head-action">{props.headAction}</span>
        )}
      </div>
      {candidates.length === 0 ? (
        <div className="model-role__empty">
          {chooser({
            ariaLabel: `${role.label} model`,
            candidate: undefined,
            unselected: emptyRoleLabel(role.id),
            onSelect: (candidate) => place(0, candidate),
          })}
          {role.id === "vision" && groups.length === 0 && props.groups.length > 0 ? (
            <span className="oct-meta">No ready model says it accepts images.</span>
          ) : null}
        </div>
      ) : (
        <ol aria-label={`${role.label} models`} className="model-role__chips">
          {candidates.map((candidate, index) => {
            const rank = index === 0 ? "Main" : `Fallback ${index}`;
            const name = nameOf(candidate);
            const chatOnly = pickerOf(candidate)?.toolsVerifiable === true;
            return (
              <li className="model-role__chip" key={nativeHarnessSlotCandidateKey(candidate)}>
                <span className="model-role__rank">{rank}</span>
                {chooser({
                  ariaLabel: `${role.label}, ${rank.toLowerCase()}`,
                  candidate,
                  unselected: "Choose model",
                  onSelect: (next) => place(index, next),
                })}
                {reasoningOf(candidate, index)}
                <span className="model-role__tags">
                  {tags(candidate).map((tag) => (
                    <span className="model-role__tag" key={tag.key}>
                      {tag.text}
                    </span>
                  ))}
                  {chatOnly ? (
                    <span className="model-role__tag">
                      Chat only
                      {props.onVerifyTools === undefined ? null : (
                        <>
                          {" · "}
                          <OctantButton
                            aria-label={`Verify tools for ${name} (1 request)`}
                            disabled={verifying !== undefined || busy || readOnly}
                            onClick={() => verify(candidate)}
                            size="sm"
                            title="Sends one request to the endpoint, which it may bill."
                            variant="ghost"
                          >
                            {verifying === nativeHarnessSlotCandidateKey(candidate)
                              ? "Verifying…"
                              : "Verify tools"}
                          </OctantButton>
                        </>
                      )}
                    </span>
                  ) : null}
                </span>
                {readOnly ? null : (
                  <span className="model-role__actions">
                    <OctantButton
                      aria-label={`Move ${name} up`}
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                      size="icon"
                      variant="ghost"
                    >
                      <ArrowUp aria-hidden="true" size={14} />
                    </OctantButton>
                    <OctantButton
                      aria-label={`Move ${name} down`}
                      disabled={busy || index === candidates.length - 1}
                      onClick={() => move(index, 1)}
                      size="icon"
                      variant="ghost"
                    >
                      <ArrowDown aria-hidden="true" size={14} />
                    </OctantButton>
                    <OctantButton
                      aria-label={`Remove ${name} from ${role.label}`}
                      disabled={busy}
                      onClick={() => commit(candidates.filter((_, at) => at !== index))}
                      size="icon"
                      variant="ghost"
                    >
                      <X aria-hidden="true" size={14} />
                    </OctantButton>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {candidates.length === 1 ? <span className="oct-meta">No fallback</span> : null}
      {adding ? (
        <div className="model-role__chip">
          <span className="model-role__rank">Fallback {candidates.length}</span>
          {chooser({
            ariaLabel: `${role.label}, new fallback`,
            candidate: undefined,
            unselected: "Choose model",
            onSelect: (next) => place(candidates.length, next),
          })}
          <OctantButton
            aria-label={`Cancel the new fallback for ${role.label}`}
            onClick={() => {
              setAdding(false);
              setNeedsSettings(undefined);
            }}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} />
          </OctantButton>
        </div>
      ) : null}
      {needsSettings === undefined ? null : (
        <div
          className="model-role__notice"
          role="group"
          aria-label={`Add ${nameOf(needsSettings.candidate)} in Settings`}
        >
          <span className="oct-meta">
            {nameOf(needsSettings.candidate)} is not in Settings for {role.label}. A Project can use
            only the models Settings lists.
          </span>
          {props.onAddInSettings === undefined ? null : (
            <OctantButton
              onClick={() => void addInSettings(needsSettings)}
              size="sm"
              variant="secondary"
            >
              Add in Settings too
            </OctantButton>
          )}
          <OctantButton onClick={() => setNeedsSettings(undefined)} size="sm" variant="ghost">
            Cancel
          </OctantButton>
        </div>
      )}
      {readOnly || candidates.length === 0 || groups.length === 0 ? null : (
        <div className="model-role__add">
          <OctantButton
            aria-label={`Add a fallback for ${role.label}`}
            disabled={busy || adding || candidates.length >= 16}
            onClick={() => setAdding(true)}
            size="sm"
            variant="ghost"
          >
            <Plus aria-hidden="true" size={14} />
            Add fallback
          </OctantButton>
        </div>
      )}
      {slot === undefined ? null : (
        <div className="model-role__checks">
          <label className="model-role__check">
            <OctantCheckbox
              checked={slot.askBeforeUsing === true}
              disabled={busy || readOnly}
              onChange={(event) => setFlag("askBeforeUsing", event.currentTarget.checked)}
            />
            <span>Ask before using</span>
          </label>
          <label className="model-role__check">
            <OctantCheckbox
              checked={slot.continueOnFallback !== false}
              disabled={busy || readOnly}
              onChange={(event) => setFlag("continueOnFallback", event.currentTarget.checked)}
            />
            <span>Continue on the fallback if the model stops</span>
          </label>
        </div>
      )}
      {note === undefined ? null : (
        <p className="oct-meta" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
