import {
  decodeOwnerThreadWake,
  decodeOwnerThreadWakeChangeRequest,
  type OwnerThreadWake,
  type OwnerThreadWakeSwitch,
} from "@octant/contracts";
import { ownerActionNotice, type OwnerActionNotice } from "./ownerAlerts";
import type { OwnerActionResult, OwnerAdministrationClient } from "./hubOwnerClient";

/** The switches' names as a window shows them (docs/design/coordinator-threads.md). */
export const OWNER_THREAD_WAKE_LABELS: Readonly<Record<OwnerThreadWakeSwitch, string>> = {
  "message-wake": "Wake when a message arrives",
  "coordinator-wake": "Wake for coordinator",
};

export type OwnerThreadWakeReading =
  | { readonly status: "read"; readonly wake: OwnerThreadWake }
  | { readonly status: "problem"; readonly message: string };

/** Reads one Code thread's wake switches; an administration session covers it. */
export async function readOwnerThreadWake(
  client: Partial<Pick<OwnerAdministrationClient, "readThreadWake">>,
  threadId: string,
): Promise<OwnerThreadWakeReading> {
  try {
    if (client.readThreadWake === undefined)
      return { status: "problem", message: "Wake switches are unavailable on this client." };
    const result = await client.readThreadWake(threadId);
    if (
      result.status === "done" &&
      typeof result.body === "object" &&
      result.body !== null &&
      "wake" in result.body
    ) {
      return { status: "read", wake: decodeOwnerThreadWake(result.body.wake) };
    }
    return { status: "problem", message: ownerThreadWakeNotice(result, "").message };
  } catch {
    return { status: "problem", message: "Could not read wake switches. Read them again." };
  }
}

/**
 * Sends one switch change against the reading the person saw. The host asks
 * for a fresh unlock for this change alone and refuses it if the thread or its
 * Project changed since that reading; nothing here retries a write.
 */
export async function changeOwnerThreadWake(
  client: Partial<Pick<OwnerAdministrationClient, "changeThreadWake">>,
  before: OwnerThreadWake,
  wakeSwitch: OwnerThreadWakeSwitch,
  wake: boolean,
): Promise<OwnerActionResult> {
  if (wakeSwitch === "coordinator-wake" && before.coordinatorWake === undefined)
    return { status: "refused", kind: "not-a-worker" };
  try {
    if (client.changeThreadWake === undefined) return { status: "refused", kind: "unsupported" };
    return await client.changeThreadWake(
      decodeOwnerThreadWakeChangeRequest({
        threadId: before.threadId,
        expectedVersion: before.version,
        switch: wakeSwitch,
        wake,
      }),
    );
  } catch {
    return { status: "unreachable" };
  }
}

/**
 * A wake answer as a sentence. The host answers `refused` both when a change
 * arrived without its own fresh unlock and when the change could not be
 * recorded, so the sentence names the unlock the person can redo.
 */
export function ownerThreadWakeNotice(result: OwnerActionResult, done: string): OwnerActionNotice {
  if (result.status === "refused" && result.kind === "refused")
    return {
      tone: "problem",
      message:
        "The computer refused that change. Each wake switch change needs its own fresh unlock; read the switches and try again.",
    };
  return ownerActionNotice(result, done);
}
