import { describe, expect, it, vi } from "vitest";
import { decodeThreadMovePhoneConfirmations } from "@octant/contracts";
import type { OwnerActionResult, OwnerUnlockSigner } from "./hubOwnerClient";
import { confirmThreadMoveOnPhone, holdUnlockForOneAction } from "./ownerThreadMove";

const LAPTOP = "11111111-1111-4111-8111-111111111111";
const DESKTOP = "22222222-2222-4222-8222-222222222222";
const THREAD = { mode: "chat", threadId: "77777777-7777-4777-8777-777777777777" } as const;
const TICKET = "33333333-3333-4333-8333-333333333333";

const [confirmation] = decodeThreadMovePhoneConfirmations({
  status: "listed",
  confirmations: [
    {
      confirmationId: "44444444-4444-4444-8444-444444444444",
      destinationMemberId: DESKTOP,
      destinationName: "Desktop",
      threads: [{ thread: THREAD, title: "Plan the trip" }],
      expiresAt: 2_000_000,
    },
  ],
}).confirmations;
if (confirmation === undefined) throw new Error("The listing holds no confirmation.");

describe("confirming a held move on an owner phone", () => {
  it("asks the destination for a ticket naming the computer it read the wait from and exactly its threads, then hands the source only the ticket id", async () => {
    const issueMoveTicket = vi.fn(
      async (): Promise<OwnerActionResult> => ({
        status: "done",
        body: { status: "issued", ticketId: TICKET },
      }),
    );
    const confirmMove = vi.fn(
      async (): Promise<OwnerActionResult> => ({ status: "done", body: { status: "started" } }),
    );

    const result = await confirmThreadMoveOnPhone({
      source: { memberId: LAPTOP, confirmMove },
      destination: { issueMoveTicket },
      confirmation,
    });

    expect(result.status).toBe("done");
    expect(issueMoveTicket).toHaveBeenCalledWith({ sourceMemberId: LAPTOP, threads: [THREAD] });
    expect(confirmMove).toHaveBeenCalledWith({
      confirmationId: confirmation.confirmationId,
      ticketId: TICKET,
    });
  });

  it("tells the source nothing when the person declines the unlock on the destination", async () => {
    const confirmMove = vi.fn(
      async (): Promise<OwnerActionResult> => ({ status: "done", body: {} }),
    );

    const result = await confirmThreadMoveOnPhone({
      source: { memberId: LAPTOP, confirmMove },
      destination: {
        issueMoveTicket: async () => ({ status: "not-unlocked", reason: "cancelled" }),
      },
      confirmation,
    });

    expect(result).toEqual({ status: "not-unlocked", reason: "cancelled" });
    expect(confirmMove).not.toHaveBeenCalled();
  });
});

describe("one unlock for an action that two computers check", () => {
  it("asks the person once, signs for both, and drops the key afterwards", async () => {
    const close = vi.fn();
    const open = vi.fn(async () => ({
      status: "signed" as const,
      value: { sign: async (text: string) => `signed:${text}`, close },
    }));
    const raw: OwnerUnlockSigner = { shape: "raw", publicKey: "key", open };
    const held = holdUnlockForOneAction(raw);
    if (held.signer.shape !== "raw") throw new Error("Expected a raw signer.");

    const first = await held.signer.open();
    const second = await held.signer.open();
    if (first.status !== "signed" || second.status !== "signed") throw new Error("Not opened.");
    expect(await first.value.sign("destination")).toBe("signed:destination");
    first.value.close();
    expect(await second.value.sign("source")).toBe("signed:source");
    expect(close).not.toHaveBeenCalled();

    held.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledOnce();
  });

  it("asks again after the person declined", async () => {
    const open = vi
      .fn<Extract<OwnerUnlockSigner, { shape: "raw" }>["open"]>()
      .mockResolvedValueOnce({ status: "cancelled" })
      .mockResolvedValueOnce({
        status: "signed",
        value: { sign: async () => "sig", close: () => undefined },
      });
    const held = holdUnlockForOneAction({ shape: "raw", publicKey: "key", open });
    if (held.signer.shape !== "raw") throw new Error("Expected a raw signer.");

    expect((await held.signer.open()).status).toBe("cancelled");
    expect((await held.signer.open()).status).toBe("signed");
    expect(open).toHaveBeenCalledTimes(2);
  });
});
