// An owner phone confirming a move that a window on the source holds for it.
// The move is an owner act on the destination, so the phone has the
// destination issue the ticket after its own fresh unlock there, naming the
// source and exactly the threads the source listed, and then hands the source
// only the ticket id. No signature passes through the source.

import { HubMemberId, type ThreadMovePhoneConfirmation } from "@octant/contracts";
import { Schema } from "effect";
import type {
  OwnerActionResult,
  OwnerThreadMoveClient,
  OwnerUnlockSigner,
  RawUnlockSession,
  UnlockAttempt,
} from "./hubOwnerClient";

const decodeMemberId = Schema.decodeUnknownEither(HubMemberId);

export async function confirmThreadMoveOnPhone(input: {
  readonly source: { readonly memberId: string } & Pick<OwnerThreadMoveClient, "confirmMove">;
  readonly destination: Pick<OwnerThreadMoveClient, "issueMoveTicket">;
  readonly confirmation: ThreadMovePhoneConfirmation;
}): Promise<OwnerActionResult> {
  // The source named in the ticket is the computer the phone read the wait
  // from, never one a listing names, so the ticket opens moves only from there.
  const sourceMemberId = decodeMemberId(input.source.memberId);
  if (sourceMemberId._tag === "Left") return { status: "refused", kind: "invalid-answer" };
  const ticket = await input.destination.issueMoveTicket({
    sourceMemberId: sourceMemberId.right,
    threads: input.confirmation.threads.map((entry) => entry.thread),
  });
  if (ticket.status !== "done") return ticket;
  const ticketId =
    typeof ticket.body === "object" && ticket.body !== null
      ? Reflect.get(ticket.body, "ticketId")
      : undefined;
  if (typeof ticketId !== "string") return { status: "refused", kind: "invalid-answer" };
  return input.source.confirmMove({
    confirmationId: input.confirmation.confirmationId,
    ticketId,
  });
}

/**
 * One confirmation asks two computers for an unlock. A raw key is opened once
 * for both, so the person authenticates once, as for a confirmed member; the
 * key is dropped from memory when `release` runs. A passkey signs one
 * challenge per prompt and is passed through as it is.
 */
export function holdUnlockForOneAction(signer: OwnerUnlockSigner): {
  readonly signer: OwnerUnlockSigner;
  readonly release: () => void;
} {
  if (signer.shape === "webauthn") return { signer, release: () => undefined };
  let opened: Promise<UnlockAttempt<RawUnlockSession>> | undefined;
  return {
    signer: {
      shape: "raw",
      publicKey: signer.publicKey,
      open: async () => {
        opened ??= signer.open();
        const attempt = await opened;
        if (attempt.status !== "signed") {
          // A declined prompt is not kept: the next action may ask again.
          opened = undefined;
          return attempt;
        }
        return { status: "signed", value: { sign: attempt.value.sign, close: () => undefined } };
      },
    },
    release: () => {
      void opened?.then((attempt) => {
        if (attempt.status === "signed") attempt.value.close();
      });
      opened = undefined;
    },
  };
}
