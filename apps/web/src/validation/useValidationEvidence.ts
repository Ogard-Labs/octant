import { useCallback, useEffect, useRef, useState } from "react";
import {
  ValidationEvidenceClientFailure,
  type ValidationEvidenceClient,
} from "@octant/client-runtime/validation-evidence-client";
import type {
  ValidationEvidenceRequest,
  ValidationEvidenceSnapshot,
} from "@octant/contracts/validation-rpc";
import { sameToolActionAuthority } from "@octant/contracts/tool-actions";
import type { ValidationPaneStatus } from "./ValidationEvidencePane";

export interface ValidationEvidenceControllerState {
  readonly status: ValidationPaneStatus;
  readonly snapshot?: ValidationEvidenceSnapshot;
  readonly errorMessage?: string;
  readonly retry: () => void;
}

export interface UseValidationEvidenceOptions {
  readonly client: ValidationEvidenceClient;
  readonly request: ValidationEvidenceRequest;
  readonly enabled?: boolean;
}

/**
 * Connects the ValidationEvidencePane to the server-authoritative validation
 * evidence route via the client-runtime. All typed states are rendered
 * truthfully: loading while in flight, waiting when the snapshot has no
 * evidence yet, unavailable when the server reports no evidence, interrupted
 * on abort, denied/missing/stale/superseded for their authoritative server
 * failures, failed on protocol errors, and ready when a snapshot with evidence
 * arrives.
 *
 * The hook never fabricates zero, success, or completion. When the snapshot
 * carries `overallOutcome: "unavailable"` with an empty timeline, the pane
 * renders the honest empty state instead of pretending validation passed.
 */
export function useValidationEvidence(
  options: UseValidationEvidenceOptions,
): ValidationEvidenceControllerState {
  const { client, request, enabled = true } = options;
  const [status, setStatus] = useState<ValidationPaneStatus>("loading");
  const [snapshot, setSnapshot] = useState<ValidationEvidenceSnapshot | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const lastSequenceRef = useRef<ValidationEvidenceSnapshot["sequence"] | undefined>(undefined);
  const lastPlanIdRef = useRef<
    NonNullable<ValidationEvidenceSnapshot["plan"]>["planId"] | undefined
  >(undefined);
  const authorityRef = useRef(request.authority);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    if (!sameToolActionAuthority(authorityRef.current, request.authority)) {
      lastSequenceRef.current = undefined;
      lastPlanIdRef.current = undefined;
    }
    authorityRef.current = request.authority;
    setStatus("loading");
    setSnapshot(undefined);
    setErrorMessage(undefined);

    const reconnectRequest =
      lastSequenceRef.current === undefined || lastPlanIdRef.current === undefined
        ? request
        : {
            ...request,
            planId: lastPlanIdRef.current,
            afterSequence: lastSequenceRef.current,
          };

    client
      .inspect(reconnectRequest, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        lastSequenceRef.current = result.sequence;
        lastPlanIdRef.current = result.plan?.planId;
        if (result.timeline.length === 0 && result.steps.length === 0) {
          // Honest empty/waiting state — never fabricate success.
          setStatus(result.overallOutcome === "unavailable" ? "unavailable" : "waiting");
        } else {
          setSnapshot(result);
          setStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ValidationEvidenceClientFailure) {
          switch (error.category) {
            case "unauthorized":
              setStatus("denied");
              setErrorMessage(error.message);
              return;
            case "unavailable":
              setStatus("unavailable");
              setErrorMessage(error.message);
              return;
            case "replay-denied":
            case "stale":
              lastSequenceRef.current = undefined;
              lastPlanIdRef.current = undefined;
              setStatus("stale");
              setErrorMessage(error.message);
              return;
            case "missing":
              setStatus("missing");
              setErrorMessage(error.message);
              return;
            case "superseded":
              lastSequenceRef.current = undefined;
              lastPlanIdRef.current = undefined;
              setStatus("superseded");
              setErrorMessage(error.message);
              return;
            case "interrupted":
              setStatus("interrupted");
              return;
            case "invalid":
            case "budget-exceeded":
            case "protocol":
              setStatus("failed");
              setErrorMessage(error.message);
              return;
          }
        }
        setStatus("unavailable");
        setErrorMessage("Validation evidence is unavailable.");
      });

    return () => {
      controller.abort();
    };
  }, [client, request, enabled, attempt]);

  return {
    status,
    ...(snapshot ? { snapshot } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    retry,
  };
}
