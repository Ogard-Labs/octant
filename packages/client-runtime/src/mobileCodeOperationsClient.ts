import {
  decodeCodeBootstrap,
  decodeCodeOperationResult,
  decodeCodeThread,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodePullRequestReview,
  type CodeThread,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

async function decodeJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      `${failureMessage} The host returned an invalid response.`,
    );
  }
}

function newOperationId(): string {
  return crypto.randomUUID();
}

/** Resolve a Code thread (including checkoutId) from the host bootstrap. */
export async function loadMobileCodeThread(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<CodeThread> {
  const bootstrap = await decodeJson(
    await transport.authenticatedFetch({ method: "GET", path: "/api/code/bootstrap" }),
    decodeCodeBootstrap,
    "Code bootstrap failed over the remote session.",
  );
  const thread = bootstrap.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    throw new MobileInboxFailure("unavailable", "Code thread is not available on this host.");
  }
  return decodeCodeThread(thread);
}

export async function executeMobileCodeOperation(
  transport: MobileRemoteTransport,
  command: CodeOperationCommand,
): Promise<CodeOperationResult> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path: "/api/code/commands",
    body: JSON.stringify(command),
  });
  const result = await decodeJson(
    response,
    decodeCodeOperationResult,
    "Code operation failed over the remote session.",
  );
  if (result.operationId !== command.operationId) {
    throw new MobileInboxFailure("unavailable", "Code operation identity mismatch.");
  }
  return result;
}

export async function observeMobilePullRequest(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly maxDiffBytes?: number;
}): Promise<CodePullRequestReview> {
  const result = await executeMobileCodeOperation(input.transport, {
    kind: "observe-pull-request",
    operationId: newOperationId() as CodeOperationCommand["operationId"],
    threadId: input.threadId as CodeOperationCommand["threadId"],
    checkoutId: input.checkoutId as CodeOperationCommand["checkoutId"],
    maxDiffBytes: input.maxDiffBytes ?? 262_144,
  });
  if (result.kind !== "pull-request-review") {
    throw new MobileInboxFailure("unavailable", "Pull request observation returned no review.");
  }
  return result;
}
