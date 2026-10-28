import type { AppleDeviceClient } from "@octant/client-runtime/apple-device-client";
import type {
  AppleDeviceRequest,
  AppleDeviceResponse,
  AppleStoreVersion,
} from "@octant/contracts/apple-toolchain";
import type { AppleStoreVersionPreparation } from "@octant/contracts/apple-toolchain-rpc";
import { useCallback, useRef, useState } from "react";

/** A few App Store Connect requests, and the person approving a 1Password read. */
const STEP_TIMEOUT_MS = 5 * 60_000;

type Step = "submit-for-review" | "release-version";

export interface UseAppleStoreVersionOptions {
  readonly client: AppleDeviceClient;
  readonly scope: Pick<AppleDeviceRequest, "authority" | "threadId" | "checkoutId">;
  readonly createUuid: () => string;
  /**
   * The desktop app's confirmation of exactly this submission or release.
   * Absent where the window cannot raise one; the workbench then offers
   * neither.
   */
  readonly requestConfirmation?: (request: AppleDeviceRequest) => Promise<string | undefined>;
  readonly projectPath?: string;
  readonly scheme?: string;
}

export type AppleStoreVersionState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly prepared: Extract<AppleStoreVersionPreparation, { readonly kind: "prepared" }>;
    }
  | { readonly kind: "confirming"; readonly step: Step; readonly version: AppleStoreVersion }
  | { readonly kind: "sending"; readonly step: Step; readonly version: AppleStoreVersion }
  | {
      readonly kind: "done";
      readonly step: Step;
      readonly version: AppleStoreVersion;
      readonly appStoreConnectId: string;
    }
  | { readonly kind: "stopped"; readonly message: string };

export interface AppleStoreVersionController {
  readonly offered: boolean;
  readonly state: AppleStoreVersionState;
  /** Reads what App Store Connect holds for the project's version. */
  readonly check: () => Promise<void>;
  /** Confirms and carries out the one step the read said the version is ready for. */
  readonly carryOut: () => Promise<void>;
}

/**
 * The workbench's **Submit for App Review…** and **Release…**
 * (docs/design/apple-devices.md, slice 8), on the same host flow as the
 * agent's: the host reads the version from App Store Connect first, the
 * desktop app asks the person to confirm exactly that version, and the host
 * reads App Store Connect again before it sends anything.
 */
export function useAppleStoreVersion(
  options: UseAppleStoreVersionOptions,
): AppleStoreVersionController {
  const { client, createUuid, projectPath, requestConfirmation, scheme } = options;
  const [state, setState] = useState<AppleStoreVersionState>({ kind: "idle" });
  const scopeRef = useRef(options.scope);
  scopeRef.current = options.scope;

  const check = useCallback(async () => {
    if (projectPath === undefined) return;
    setState({ kind: "reading" });
    const prepared = await client.prepareStoreVersion({
      kind: "apple-store-version-preparation",
      ...scopeRef.current,
      projectPath: projectPath as never,
      ...(scheme === undefined ? {} : { scheme }),
    });
    setState(
      prepared.kind === "failed"
        ? { kind: "stopped", message: prepared.message }
        : { kind: "read", prepared },
    );
  }, [client, projectPath, scheme]);

  const carryOut = useCallback(async () => {
    if (requestConfirmation === undefined || state.kind !== "read") return;
    const { ready, storeVersion: version } = state.prepared;
    if (ready === "neither") return;
    const step = ready;
    const request: AppleDeviceRequest = {
      actionId: createUuid() as never,
      correlationId: createUuid() as never,
      ...scopeRef.current,
      kind: step,
      requestedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" as never },
      storeVersion: version,
      timeoutMs: STEP_TIMEOUT_MS,
      approval: { kind: "not-required" },
    };
    setState({ kind: "confirming", step, version });
    const approvalId = await requestConfirmation(request);
    if (approvalId === undefined) {
      setState({
        kind: "stopped",
        message: step === "submit-for-review" ? "Nothing was submitted." : "Nothing was released.",
      });
      return;
    }
    setState({ kind: "sending", step, version });
    const answer = await client.request({
      ...request,
      approval: { kind: "approved", approvalId: approvalId as never },
    });
    setState(stepResult(answer, step, version));
  }, [client, createUuid, requestConfirmation, state]);

  return { offered: requestConfirmation !== undefined, state, check, carryOut };
}

function stepResult(
  answer: AppleDeviceResponse,
  step: Step,
  version: AppleStoreVersion,
): AppleStoreVersionState {
  if (answer.kind === "apple-store-version-evidence") {
    const { evidence } = answer;
    if (evidence.outcome === "succeeded" && evidence.appStoreConnectId !== undefined) {
      return { kind: "done", step, version, appStoreConnectId: evidence.appStoreConnectId };
    }
    const reason = [...evidence.diagnostics]
      .reverse()
      .find((diagnostic) => diagnostic.severity === "error");
    return { kind: "stopped", message: reason?.message ?? "App Store Connect did not take it." };
  }
  if (answer.kind === "apple-device-refused") {
    return {
      kind: "stopped",
      message:
        answer.reason === "store-version-changed"
          ? "App Store Connect no longer holds that version and build ready for this step. Check again to see what it holds now."
          : answer.reason === "key-source-unavailable"
            ? "The App Store Connect key could not be read from 1Password. Nothing was sent."
            : answer.reason === "confirmation-required" || answer.reason === "local-person-required"
              ? "This is confirmed in Octant on this Mac."
              : "The Mac refused it.",
    };
  }
  if (answer.kind === "apple-device-failure") {
    return { kind: "stopped", message: answer.failure.message };
  }
  return { kind: "stopped", message: "The Mac answered something else than what was asked." };
}
