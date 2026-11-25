import {
  decodeThreadSecretCommandResult,
  decodeThreadSecretsView,
  type PairedThreadSecretCommand,
  type ThreadSecretAnswer,
  type ThreadSecretRequestCard,
} from "@octant/contracts/thread-secrets";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import type { ThreadSecretReply } from "./threadSecretsClient";

const PAIRED_THREAD_SECRETS_PATH = "/api/thread-secrets/paired";

function send(transport: MobileRemoteTransport, command: PairedThreadSecretCommand) {
  return transport.authenticatedFetch({
    method: "POST",
    path: PAIRED_THREAD_SECRETS_PATH,
    body: JSON.stringify(command),
    contentType: "application/json",
  });
}

/**
 * The secret cards this phone may answer in one thread. A refused read throws,
 * so a caller can tell "nothing is waiting" from "could not ask".
 */
export async function listMobileThreadSecretCards(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
}): Promise<ReadonlyArray<ThreadSecretRequestCard>> {
  const response = await send(input.transport, { kind: "list", threadId: input.threadId });
  if (!response.ok) throw new Error(`Listing secret cards failed with ${response.status}.`);
  return decodeThreadSecretsView(await response.json()).requests;
}

/** Sends one answer. Throws where the outcome is not known. */
export async function answerMobileThreadSecretCard(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly answer: ThreadSecretAnswer;
}): Promise<ThreadSecretReply> {
  const response = await send(input.transport, {
    kind: "answer",
    threadId: input.threadId,
    answer: input.answer,
  });
  // The host refuses a request before it reads an answer from it.
  if (response.status >= 400 && response.status < 500) return { status: "not-taken" };
  if (!response.ok) throw new Error("The host did not take the answer.");
  return decodeThreadSecretCommandResult(await response.json());
}
