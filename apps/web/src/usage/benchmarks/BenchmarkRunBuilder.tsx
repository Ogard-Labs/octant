import { Play } from "lucide-react";
import { useMemo, useState } from "react";
import {
  decodeBenchmarkRunStartRequest,
  MAX_BENCHMARK_CELLS,
  MAX_BENCHMARK_CONTENDERS,
  type BenchmarkExecutionLevel,
  type BenchmarkRunStartRequest,
  type BenchmarkSuite,
  type TurnDiagnosticsReport,
} from "@octant/contracts";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantNumberStepper } from "../../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import type { ModelChoice } from "./benchmarkModels";
import {
  contenderLabel,
  decodeFailure,
  estimateRunCost,
  formatUsd,
  mintId,
  type ContenderNames,
} from "./benchmarkPresentation";

const LEVEL_WORDS: ReadonlyArray<{ readonly id: BenchmarkExecutionLevel; readonly label: string }> =
  [
    { id: "auto", label: "Auto" },
    { id: "accept-edits", label: "Accept edits" },
    { id: "full-access", label: "Full access, only where the Project allows it" },
  ];

export interface BenchmarkRunBuilderProps {
  readonly suite: BenchmarkSuite;
  readonly models: ReadonlyArray<ModelChoice>;
  readonly names: ContenderNames;
  /** Earlier turns, which price the estimate; absent until read or when unreadable. */
  readonly report: TurnDiagnosticsReport | undefined;
  /** Starts the run; resolves to the sentence to show when it was refused. */
  readonly onStart: (request: BenchmarkRunStartRequest) => Promise<string | undefined>;
}

function positiveWhole(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : undefined;
}

function positiveNumber(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Chooses who competes and what the run may spend. The estimate comes from
 * what each model's earlier turns cost, and says so when it has no history to
 * go on, rather than showing a number it made up.
 */
export function BenchmarkRunBuilder(props: BenchmarkRunBuilderProps) {
  const [chosen, setChosen] = useState<ReadonlyArray<string>>([]);
  const [repetitions, setRepetitions] = useState(1);
  const [maxTokens, setMaxTokens] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [level, setLevel] = useState<BenchmarkExecutionLevel>("auto");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const hasCode = props.suite.cases.some((candidate) => candidate.kind === "code");
  const contenders = useMemo(
    () =>
      chosen.flatMap((key) => {
        const model = props.models.find((candidate) => candidate.key === key);
        return model === undefined
          ? []
          : [{ providerInstanceId: model.providerInstanceId, modelId: model.modelId }];
      }),
    [chosen, props.models],
  );
  const estimate = estimateRunCost({
    report: props.report,
    contenders,
    caseCount: props.suite.cases.length,
    repetitions,
  });
  const tokenBudget = positiveWhole(maxTokens);
  const costBudget = positiveNumber(maxCost);
  const blocker =
    contenders.length === 0
      ? "Choose at least one contender."
      : tokenBudget === undefined && costBudget === undefined
        ? "Set a token or cost budget."
        : maxTokens.trim() !== "" && tokenBudget === undefined
          ? "The token budget must be a whole number above zero."
          : maxCost.trim() !== "" && costBudget === undefined
            ? "The cost budget must be a number above zero."
            : estimate.cells > MAX_BENCHMARK_CELLS
              ? `This run would have ${estimate.cells.toLocaleString("en")} cells, and a run holds at most ${MAX_BENCHMARK_CELLS.toLocaleString("en")}.`
              : undefined;

  const toggle = (key: string, on: boolean) =>
    setChosen((current) =>
      on ? [...current.filter((entry) => entry !== key), key] : current.filter((e) => e !== key),
    );

  const start = async () => {
    let request: BenchmarkRunStartRequest;
    try {
      request = decodeBenchmarkRunStartRequest({
        runId: mintId(),
        suiteId: props.suite.suiteId,
        contenders,
        repetitions,
        budget: {
          ...(tokenBudget === undefined ? {} : { maxTokens: tokenBudget }),
          ...(costBudget === undefined ? {} : { maxCostUsd: costBudget }),
        },
        ...(hasCode ? { executionLevel: level } : {}),
      });
    } catch (error) {
      setMessage(`The run does not fit the benchmark format: ${decodeFailure(error)}`);
      return;
    }
    setPending(true);
    setMessage(undefined);
    const refusal = await props.onStart(request);
    setPending(false);
    if (refusal !== undefined) setMessage(refusal);
  };

  const byInstance = new Map<string, ModelChoice[]>();
  for (const model of props.models) {
    byInstance.set(model.instanceName, [...(byInstance.get(model.instanceName) ?? []), model]);
  }

  return (
    <SurfaceSection label="Run builder" note={`Suite: ${props.suite.name}`}>
      {props.models.length === 0 ? (
        <p className="usage-workspace__note">
          No provider account is ready, so there is no one to compete. Sign in to a provider in
          Settings.
        </p>
      ) : (
        <div aria-label="Contenders" className="benchmark-contenders" role="group">
          {[...byInstance.entries()].map(([instanceName, models]) => (
            <div className="benchmark-contenders__group" key={instanceName}>
              <span className="usage-workspace__note">{instanceName}</span>
              {models.map((model) => (
                <label className="benchmark-editor__toggle" key={model.key}>
                  <input
                    checked={chosen.includes(model.key)}
                    className="octant-checkbox"
                    disabled={
                      !chosen.includes(model.key) && chosen.length >= MAX_BENCHMARK_CONTENDERS
                    }
                    onChange={(event) => toggle(model.key, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>{model.label}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="benchmark-builder__row">
        <div className="usage-workspace__field">
          <span>Repetitions</span>
          <OctantNumberStepper
            label="Repetitions"
            max={5}
            min={1}
            onChange={setRepetitions}
            value={repetitions}
          />
        </div>
        <label className="usage-workspace__field">
          <span>Token budget</span>
          <OctantInput
            aria-label="Token budget"
            inputMode="numeric"
            onChange={(event) => setMaxTokens(event.currentTarget.value)}
            placeholder="No limit"
            value={maxTokens}
          />
        </label>
        <label className="usage-workspace__field">
          <span>Cost budget, US dollars</span>
          <OctantInput
            aria-label="Cost budget in US dollars"
            inputMode="decimal"
            onChange={(event) => setMaxCost(event.currentTarget.value)}
            placeholder="No limit"
            value={maxCost}
          />
        </label>
        {hasCode ? (
          <label className="usage-workspace__field">
            <span>Execution level</span>
            <OctantSelectField
              aria-label="Execution level"
              onValueChange={(value) => setLevel(value as BenchmarkExecutionLevel)}
              options={LEVEL_WORDS}
              value={level}
            />
          </label>
        ) : null}
      </div>

      <p aria-live="polite" className="benchmark-estimate" role="status">
        {contenders.length === 0
          ? "Choose contenders to see an estimate."
          : estimate.usd === undefined
            ? "No estimate yet. Models are priced from their earlier turns, and these have none."
            : `Estimated cost ${formatUsd(estimate.usd)} for ${estimate.cells.toLocaleString("en")} cells${
                estimate.unpriced.length === 0
                  ? "."
                  : `, not counting ${estimate.unpriced
                      .map((entry) => contenderLabel(entry, props.names))
                      .join(", ")}, which have no history.`
              }${
                costBudget !== undefined && estimate.usd > costBudget
                  ? " That is above the cost budget, so the run may stop early."
                  : ""
              }`}
      </p>
      {blocker === undefined || contenders.length === 0 ? null : (
        <p className="usage-workspace__note">{blocker}</p>
      )}
      {message === undefined ? null : (
        <OctantAlert tone="warning">
          <p>{message}</p>
        </OctantAlert>
      )}
      <div>
        <OctantButton
          disabled={pending || blocker !== undefined}
          onClick={() => void start()}
          type="button"
        >
          <Play aria-hidden="true" size={14} />
          Start run
        </OctantButton>
      </div>
    </SurfaceSection>
  );
}
