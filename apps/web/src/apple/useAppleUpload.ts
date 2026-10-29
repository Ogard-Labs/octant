import type { AppleDeviceClient } from "@octant/client-runtime/apple-device-client";
import type {
  AppleDeviceRequest,
  AppleDeviceResponse,
  AppleUploadBuild,
} from "@octant/contracts/apple-toolchain";
import { useCallback, useRef, useState } from "react";

/** An archive of a real app, its export, and the upload together. */
const UPLOAD_TIMEOUT_MS = 60 * 60_000;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export interface UseAppleUploadOptions {
  readonly client: AppleDeviceClient;
  readonly scope: Pick<AppleDeviceRequest, "authority" | "threadId" | "checkoutId">;
  readonly createUuid: () => string;
  /**
   * The desktop app's confirmation of exactly this upload. Absent where the
   * window cannot raise one; the workbench then offers no upload.
   */
  readonly requestConfirmation?: (request: AppleDeviceRequest) => Promise<string | undefined>;
  readonly projectPath?: string;
  readonly scheme?: string;
  readonly team: string;
}

export type AppleUploadState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | { readonly kind: "confirming"; readonly build: AppleUploadBuild }
  | { readonly kind: "uploading"; readonly build: AppleUploadBuild }
  | {
      readonly kind: "uploaded";
      readonly build: AppleUploadBuild;
      readonly deliveryId: string;
    }
  | { readonly kind: "stopped"; readonly message: string };

export interface AppleUploadController {
  readonly offered: boolean;
  readonly ready: boolean;
  readonly state: AppleUploadState;
  readonly upload: () => Promise<void>;
}

/**
 * The workbench's upload to App Store Connect (docs/design/apple-devices.md,
 * slice 7), on the same host flow as the agent's: the host reads the exact
 * build first, the desktop app asks the person to confirm that build, and the
 * host reads the project again before it archives, signs, and uploads.
 */
export function useAppleUpload(options: UseAppleUploadOptions): AppleUploadController {
  const { client, createUuid, projectPath, requestConfirmation, scheme, team } = options;
  const [state, setState] = useState<AppleUploadState>({ kind: "idle" });
  const scopeRef = useRef(options.scope);
  scopeRef.current = options.scope;
  const ready =
    projectPath !== undefined &&
    TEAM_ID.test(team) &&
    state.kind !== "reading" &&
    state.kind !== "confirming" &&
    state.kind !== "uploading";

  const upload = useCallback(async () => {
    if (requestConfirmation === undefined || projectPath === undefined || !TEAM_ID.test(team)) {
      return;
    }
    const scope = scopeRef.current;
    setState({ kind: "reading" });
    const prepared = await client.prepareUpload({
      kind: "apple-upload-preparation",
      ...scope,
      projectPath: projectPath as never,
      ...(scheme === undefined ? {} : { scheme }),
      teamId: team as never,
    });
    if (prepared.kind === "failed") {
      setState({ kind: "stopped", message: prepared.message });
      return;
    }
    const build = prepared.upload;
    const request: AppleDeviceRequest = {
      actionId: createUuid() as never,
      correlationId: createUuid() as never,
      ...scope,
      kind: "upload",
      requestedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" as never },
      projectPath: projectPath as never,
      ...(scheme === undefined ? {} : { scheme }),
      teamId: team as never,
      upload: build,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      approval: { kind: "not-required" },
    };
    setState({ kind: "confirming", build });
    // The desktop app names the app, version, build, team, identity, and
    // revision; the host uploads only on that answer.
    const approvalId = await requestConfirmation(request);
    if (approvalId === undefined) {
      setState({ kind: "stopped", message: "Nothing was uploaded." });
      return;
    }
    setState({ kind: "uploading", build });
    const answer = await client.request({
      ...request,
      approval: { kind: "approved", approvalId: approvalId as never },
    });
    setState(uploadResult(answer, build));
  }, [client, createUuid, projectPath, requestConfirmation, scheme, team]);

  return { offered: requestConfirmation !== undefined, ready, state, upload };
}

function uploadResult(answer: AppleDeviceResponse, build: AppleUploadBuild): AppleUploadState {
  if (answer.kind === "apple-upload-evidence") {
    const { evidence } = answer;
    if (evidence.outcome === "succeeded" && evidence.deliveryId !== undefined) {
      return { kind: "uploaded", build, deliveryId: evidence.deliveryId };
    }
    const reason = [...evidence.diagnostics]
      .reverse()
      .find((diagnostic) => diagnostic.severity === "error");
    return { kind: "stopped", message: reason?.message ?? "The upload did not go through." };
  }
  if (answer.kind === "apple-device-refused") {
    return {
      kind: "stopped",
      message:
        answer.reason === "upload-changed"
          ? "The project no longer builds the version and build you confirmed. Upload again to confirm what it builds now."
          : answer.reason === "confirmation-required" || answer.reason === "local-person-required"
            ? "An upload is confirmed in Octant on this Mac."
            : "The Mac refused the upload.",
    };
  }
  if (answer.kind === "apple-device-failure")
    return { kind: "stopped", message: answer.failure.message };
  return { kind: "stopped", message: "The Mac answered something else than what was asked." };
}
