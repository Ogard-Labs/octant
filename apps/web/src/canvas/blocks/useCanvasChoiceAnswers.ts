import type {
  CanvasChoiceAnswer,
  CanvasChoiceAnswerChange,
  CanvasChoiceAnswersOutcome,
  CanvasChoiceAnswersReviseCommand,
  CanvasChoiceAnswersReviseResult,
  CanvasId,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/** Where a decision form's saved answers are read and written; the host owns both. */
export interface CanvasChoiceAnswersPort {
  readonly canvasId: CanvasId;
  readonly load: () => Promise<CanvasChoiceAnswersOutcome>;
  readonly revise: (
    command: CanvasChoiceAnswersReviseCommand,
  ) => Promise<CanvasChoiceAnswersReviseResult>;
}

export type CanvasChoiceAnswersState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly sequence: number;
      readonly answers: ReadonlyArray<CanvasChoiceAnswer>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type CanvasChoiceSaveResult =
  | { readonly status: "saved" }
  | { readonly status: "refused"; readonly message: string };

/**
 * A decision form's saved answers. Writes run one after another so quick picks
 * never race each other for the sequence; a write the host refuses as stale
 * reloads and tries once more against the new sequence, as the later write to
 * a question wins. The host's own answers, not a local guess, are what the form
 * shows once a write is accepted.
 */
export function useCanvasChoiceAnswers(port: CanvasChoiceAnswersPort) {
  const [state, setState] = useState<CanvasChoiceAnswersState>({ status: "loading" });
  const sequence = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const outcome = await port.load();
      if (outcome.kind === "ready") {
        sequence.current = outcome.sequence;
        setState({ status: "ready", sequence: outcome.sequence, answers: outcome.answers });
        return true;
      }
      setState({
        status: "unavailable",
        reason:
          outcome.kind === "unavailable"
            ? outcome.reason
            : "Saved answers are not available in this workspace.",
      });
    } catch {
      setState({ status: "unavailable", reason: "The saved answers could not be loaded." });
    }
    return false;
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (changes: ReadonlyArray<CanvasChoiceAnswerChange>): Promise<CanvasChoiceSaveResult> => {
      const run = async (): Promise<CanvasChoiceSaveResult> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let result: CanvasChoiceAnswersReviseResult;
          try {
            result = await port.revise({
              kind: "canvas-choice-answers-revise",
              canvasId: port.canvasId,
              expectedSequence: sequence.current,
              changes,
            });
          } catch {
            return {
              status: "refused",
              message: "The answer could not be saved. Check the connection and try again.",
            };
          }
          if (result.kind === "accepted") {
            await load();
            return { status: "saved" };
          }
          if (result.denialCode === "stale-version" && attempt === 0) {
            if (await load()) continue;
          }
          return { status: "refused", message: result.message };
        }
        return { status: "refused", message: "The answers changed on the host; try again." };
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [port, load],
  );

  return { state, save };
}
