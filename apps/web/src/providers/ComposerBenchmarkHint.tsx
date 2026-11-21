import { useContext, useEffect, useState } from "react";
import type {
  BenchmarkAdviceRequest,
  BenchmarkAdviceResponse,
  ProviderModelOptionValues,
} from "@octant/contracts";
import {
  findPickerModel,
  isDraftSelectionSelectable,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { BenchmarkAdviceContext } from "../usage/benchmarks/BenchmarkAdviceContext";
import { findSupportedReasoningOption } from "./composerReasoningOption";

type Scope = Extract<BenchmarkAdviceRequest, { readonly projectId: unknown }>;

export type ComposerBenchmarkScope = Scope;

function dismissalKey(projectId: Scope["projectId"]): string {
  return `octant:benchmark-hint-dismissed:${projectId}`;
}

function wasDismissed(projectId: Scope["projectId"]): boolean {
  try {
    return globalThis.localStorage.getItem(dismissalKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function ComposerBenchmarkHint(props: {
  readonly scope: ComposerBenchmarkScope;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selected: ModelPickerSelection;
  readonly onSelect: (selection: ModelPickerSelection) => void;
}) {
  const { projectId, kind } = props.scope;
  const client = useContext(BenchmarkAdviceContext)?.client;
  const [dismissed, setDismissed] = useState(() => wasDismissed(projectId));
  const [answer, setAnswer] = useState<BenchmarkAdviceResponse>();
  useEffect(() => {
    if (dismissed || client === undefined) return;
    let live = true;
    void client.advice({ projectId, kind }).then(
      (value) => {
        if (live) setAnswer(value);
      },
      () => {
        if (live) setAnswer(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [client, dismissed, kind, projectId]);
  if (dismissed) return null;
  for (const suite of answer?.suites ?? []) {
    const ranked = suite.models.flatMap((model) => {
      const picker = findPickerModel(props.groups, model);
      return picker === undefined || !isDraftSelectionSelectable(props.groups, model)
        ? []
        : [{ model, picker }];
    });
    const best = ranked[0];
    const selectedRank = ranked.findIndex(
      ({ model }) =>
        String(model.providerInstanceId) === String(props.selected.providerInstanceId) &&
        String(model.modelId) === String(props.selected.modelId),
    );
    if (best === undefined || selectedRank < 1) continue;
    const { model, picker } = best;
    const supportedReasoning = findSupportedReasoningOption(picker.model.options, model.effort);
    // Always pass an explicit option map so switching to a default-effort or
    // unsupported-effort suggestion clears any reasoning effort carried over
    // from the previous model instead of inheriting it.
    const modelOptionValues: ProviderModelOptionValues =
      supportedReasoning === undefined ? {} : { [supportedReasoning.id]: supportedReasoning.value };
    return (
      <div className="composer-model-picker__benchmark-hint">
        <span className="oct-meta">
          {model.costPerPass === undefined
            ? `Passed your ${suite.name} suite: ${picker.model.displayName} (cost not reported).`
            : `Passed your ${suite.name} suite at the lowest cost: ${picker.model.displayName}.`}{" "}
          {model.effort === undefined ? "" : `Effort: ${model.effort}. `}
          {model.runAt.slice(0, 10)}
          {model.stale ? " · Stale" : ""}
        </span>
        <OctantButton
          onClick={() =>
            props.onSelect({
              providerInstanceId: model.providerInstanceId,
              modelId: model.modelId,
              modelOptionValues,
            })
          }
          size="sm"
          variant="ghost"
        >
          Use model
        </OctantButton>
        <OctantButton
          onClick={() => {
            try {
              globalThis.localStorage.setItem(dismissalKey(projectId), "1");
            } catch {
              // Dismiss for this view when storage is unavailable.
            }
            setDismissed(true);
          }}
          size="sm"
          variant="ghost"
        >
          Dismiss for this Project
        </OctantButton>
      </div>
    );
  }
  return null;
}
