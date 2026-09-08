import {
  decodeCodeOperationApprovalChallenge,
  decodeCodeOperationApprovalReceipt,
  decodeCodeOperationApprovalRequest,
  type CodeApprovalId,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalRequest,
} from "@octant/contracts";

export type NativeCodeOperationApprovalRequest = CodeOperationApprovalRequest;

/** The server has paused authority issuance until host clock recovery completes. */
export class CodeOperationApprovalUnavailableError extends Error {
  constructor() {
    super("Octant cannot approve Code authority while host time recovery is required.");
    this.name = "CodeOperationApprovalUnavailableError";
  }
}

export async function requestCodeOperationApprovalFromServer<TWindow>(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly request: NativeCodeOperationApprovalRequest;
  readonly owner: TWindow;
  readonly dialog: {
    readonly showMessageBox: (
      owner: TWindow,
      options: {
        readonly type: "question";
        readonly buttons: readonly string[];
        readonly defaultId: number;
        readonly cancelId: number;
        readonly title: string;
        readonly message: string;
        readonly detail: string;
        readonly noLink: boolean;
      },
    ) => Promise<{ readonly response: number }>;
  };
  readonly fetch: typeof globalThis.fetch;
}): Promise<CodeApprovalId | undefined> {
  const request = decodeCodeOperationApprovalRequest(options.request);
  try {
    const challenge = await prepareCodeOperationApprovalChallengeFromServer({
      serverUrl: options.serverUrl,
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowCapability: options.windowCapability,
      request,
      fetch: options.fetch,
    });
    const decision = await options.dialog.showMessageBox(options.owner, {
      type: "question",
      buttons: ["Approve once", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Approve Code authority?",
      message: challenge.message,
      detail: `${challenge.detail}\n\nEffect digest: ${challenge.effectDigest}\nContext digest: ${challenge.contextDigest}`,
      noLink: true,
    });
    if (decision.response !== 0) return undefined;
    return await confirmCodeOperationApprovalFromServer({
      serverUrl: options.serverUrl,
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowCapability: options.windowCapability,
      challengeId: challenge.challengeId,
      fetch: options.fetch,
    });
  } catch (error) {
    if (error instanceof CodeOperationApprovalUnavailableError) throw error;
    throw new Error("Octant could not approve this Code authority.");
  }
}

export async function prepareCodeOperationApprovalChallengeFromServer(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly request: NativeCodeOperationApprovalRequest;
  readonly fetch: typeof globalThis.fetch;
}): Promise<CodeOperationApprovalChallenge> {
  const request = decodeCodeOperationApprovalRequest(options.request);
  const challengeResponse = await options.fetch(
    new URL("/api/desktop/code-operation-approval-challenges", options.serverUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": options.desktopBridgeSecret,
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(request),
    },
  );
  if (!challengeResponse.ok) throwApprovalResponseFailure(challengeResponse);
  return decodeCodeOperationApprovalChallenge(await challengeResponse.json());
}

export async function confirmCodeOperationApprovalFromServer(options: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly challengeId: string;
  readonly fetch: typeof globalThis.fetch;
}): Promise<CodeApprovalId | undefined> {
  const receiptResponse = await options.fetch(
    new URL("/api/desktop/code-operation-approval-confirmations", options.serverUrl),
    {
      method: "POST",
      headers: approvalHeaders(options),
      body: JSON.stringify({ challengeId: options.challengeId }),
    },
  );
  if (!receiptResponse.ok) throwApprovalResponseFailure(receiptResponse);
  return decodeCodeOperationApprovalReceipt(await receiptResponse.json()).approvalId;
}

function throwApprovalResponseFailure(response: Response): never {
  if (response.status === 503) throw new CodeOperationApprovalUnavailableError();
  throw new Error("Code operation approval request was rejected.");
}

function approvalHeaders(options: {
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-octant-desktop-secret": options.desktopBridgeSecret,
    "x-octant-window-capability": options.windowCapability,
  };
}
