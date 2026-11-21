import { useEffect, useState } from "react";
import type { BenchmarksClient } from "@octant/client-runtime";
import {
  MAX_NATIVE_HARNESS_SLOT_CANDIDATES,
  type BenchmarkAdviceResponse,
  type BenchmarkModelAdvice,
  type BenchmarkSuiteId,
} from "@octant/contracts";
import {
  findPickerModel,
  isDraftSelectionSelectable,
  MODEL_ROLE_NEEDS,
  type PickerGroup,
} from "@octant/domain";
import { findSupportedReasoningOption } from "../providers/ComposerModelPicker";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";

type SuiteChoices = ReadonlyArray<{ readonly id: BenchmarkSuiteId; readonly label: string }>;

export function BenchmarkRoleSuggestion(props: {
  readonly client: Pick<BenchmarksClient, "listSuites" | "advice">;
  readonly role: { readonly id: string; readonly label: string };
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly onAccept: (models: ReadonlyArray<BenchmarkModelAdvice>) => void;
  readonly onCancel: () => void;
  readonly disabled: boolean;
}) {
  const { client } = props;
  const [suites, setSuites] = useState<SuiteChoices>();
  const [suiteId, setSuiteId] = useState<BenchmarkSuiteId>();
  const [ranked, setRanked] = useState<BenchmarkAdviceResponse["suites"][number]>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let live = true;
    void client.listSuites().then(
      ({ suites }) => {
        if (live) setSuites(suites.map((suite) => ({ id: suite.suiteId, label: suite.name })));
      },
      () => {
        if (live) setMessage("Benchmark suites are unavailable.");
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => {
    if (suiteId === undefined) return;
    let live = true;
    void client.advice({ suiteId }).then(
      ({ suites }) => {
        if (!live) return;
        const suite = suites[0];
        if (suite === undefined) setMessage("That benchmark suite is no longer available.");
        else setRanked(suite);
      },
      () => {
        if (live) setMessage("Benchmark suggestions are unavailable.");
      },
    );
    return () => {
      live = false;
    };
  }, [client, suiteId]);

  const need = MODEL_ROLE_NEEDS.find((entry) => entry.roleId === props.role.id);
  const models = (
    ranked !== undefined && suiteId !== undefined && String(ranked.suiteId) === String(suiteId)
      ? ranked.models
      : []
  )
    .flatMap((model) => {
      const picker = findPickerModel(props.groups, model);
      if (
        picker === undefined ||
        !isDraftSelectionSelectable(props.groups, model) ||
        (need?.needsTools === true && !picker.toolCapable) ||
        (need?.needsImages === true && !picker.model.inputModalities.includes("image"))
      ) {
        return [];
      }
      const supported = findSupportedReasoningOption(picker.model.options, model.effort);
      const { effort: _dropped, ...withoutEffort } = model;
      const validated: BenchmarkModelAdvice =
        supported === undefined ? withoutEffort : { ...withoutEffort, effort: supported.value };
      return [{ model: validated, displayName: picker.model.displayName }];
    })
    .slice(0, MAX_NATIVE_HARNESS_SLOT_CANDIDATES);
  return (
    <OctantConfirmDialog
      title={`Benchmark suggestions for ${props.role.label}`}
      confirmDisabled={props.disabled || models.length === 0}
      confirmLabel="Use these models"
      onCancel={props.onCancel}
      onConfirm={() => props.onAccept(models.map(({ model }) => model))}
      details={
        <>
          {suites === undefined || suites.length === 0 ? null : (
            <OctantSelectField
              aria-label="Benchmark suite"
              options={[{ id: "", label: "Choose a suite" }, ...suites]}
              value={suiteId ?? ""}
              onValueChange={(id) => {
                setMessage(undefined);
                setRanked(undefined);
                setSuiteId(suites.find((suite) => String(suite.id) === id)?.id);
              }}
            />
          )}
          {message !== undefined ? <p role="status">{message}</p> : null}
          {suites === undefined && message === undefined ? (
            <p role="status">Loading suites…</p>
          ) : null}
          {suites?.length === 0 ? <p>No benchmark suites yet.</p> : null}
          {suiteId !== undefined && ranked === undefined && message === undefined ? (
            <p role="status">Reading results…</p>
          ) : null}
          {ranked !== undefined && models.length === 0 ? (
            <p>No available models passed this suite’s bar.</p>
          ) : null}
          {models.length === 0 ? null : (
            <ol aria-label="Ranked benchmark models">
              {models.map(({ model, displayName }) => (
                <li key={`${model.providerInstanceId}:${model.modelId}`}>
                  {displayName}
                  {model.effort === undefined ? "" : ` (${model.effort} effort)`} ·{" "}
                  {model.runAt.slice(0, 10)}
                  {model.costPerPass === undefined ? " · Cost not reported" : ""}
                  {model.stale ? " · Stale" : ""}
                </li>
              ))}
            </ol>
          )}
        </>
      }
    >
      Accepting replaces this role’s candidates in the order shown.
    </OctantConfirmDialog>
  );
}
