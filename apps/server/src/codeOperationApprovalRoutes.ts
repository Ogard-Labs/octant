import { timingSafeEqual } from "node:crypto";
import {
  decodeCodeOperationApprovalChallenge,
  decodeCodeOperationApprovalConfirmation,
  decodeCodeOperationApprovalReceipt,
  decodeCodeOperationApprovalRequest,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalConfirmation,
  type CodeOperationApprovalReceipt,
  type CodeOperationApprovalRequest,
  type WindowId,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { CodeOperationApprovalUnavailableError } from "./code/codeOperationApprovalStore";

const MAX_BODY_BYTES = 1_048_576;

export function createCodeOperationApprovalRouteHandler(options: {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly prepare: (
    windowId: WindowId,
    request: CodeOperationApprovalRequest,
  ) => Promise<CodeOperationApprovalChallenge | undefined>;
  readonly confirm: (
    windowId: WindowId,
    confirmation: CodeOperationApprovalConfirmation,
  ) => Promise<CodeOperationApprovalReceipt | undefined>;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isPrepare = url.pathname === "/api/desktop/code-operation-approval-challenges";
    const isConfirm = url.pathname === "/api/desktop/code-operation-approval-confirmations";
    if (!isPrepare && !isConfirm) return undefined;
    if (
      options.desktopBridgeSecret === undefined ||
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !equal(options.desktopBridgeSecret, request.headers.get("x-octant-desktop-secret") ?? "")
    ) {
      return failure("unauthorized", 401);
    }
    if (
      request.method !== "POST" ||
      url.search !== "" ||
      request.headers.get("content-type")?.toLowerCase() !== "application/json"
    ) {
      return failure("invalid", 400);
    }
    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: options.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return failure("invalid", 413);
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (isPrepare) {
        const challenge = await options.prepare(windowId, decodeCodeOperationApprovalRequest(body));
        return challenge === undefined
          ? failure("unauthorized", 403)
          : Response.json(decodeCodeOperationApprovalChallenge(challenge), { status: 201 });
      }
      const receipt = await options.confirm(
        windowId,
        decodeCodeOperationApprovalConfirmation(body),
      );
      return receipt === undefined
        ? failure("unauthorized", 403)
        : Response.json(decodeCodeOperationApprovalReceipt(receipt), { status: 201 });
    } catch (error) {
      if (error instanceof CodeOperationApprovalUnavailableError) {
        return failure("unavailable", 503);
      }
      return failure("invalid", 400);
    }
  };
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unauthorized"
          ? "Code operation approval is unauthorized."
          : category === "unavailable"
            ? "Code operation approval is unavailable while host time recovery is required."
            : "Code operation approval request is invalid.",
    },
    { status },
  );
}
