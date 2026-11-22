import {
  decodeProviderInstanceId,
  MAX_IMPORTED_SESSION_BYTES,
  MAX_IMPORTED_SESSION_MESSAGE_BYTES,
  MAX_IMPORTED_SESSION_MESSAGES,
} from "@octant/contracts";
import type { ProviderNativeSessions } from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { boundImportedSessionHistory, readImportedSessionHistory } from "./nativeSessionHistory";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a01");
const input = { instanceId, projectRoot: "/work/project", nativeSessionId: "session-1" };

function sessions(history?: ProviderNativeSessions["history"]): ProviderNativeSessions {
  return {
    list: () => Effect.succeed([]),
    adopt: () => Effect.die("not adopted here"),
    ...(history === undefined ? {} : { history }),
  };
}

describe("imported session history", () => {
  it("keeps the newest messages within the message cap and counts the earlier ones it left out", () => {
    const messages = Array.from({ length: MAX_IMPORTED_SESSION_MESSAGES + 5 }, (_, index) => ({
      role: index % 2 === 0 ? ("person" as const) : ("agent" as const),
      text: `message ${String(index)}`,
    }));
    const bounded = boundImportedSessionHistory({ status: "read", messages, omitted: 3 });
    expect(bounded).toMatchObject({ status: "imported", omittedMessages: 8 });
    if (bounded.status !== "imported") throw new Error("expected an import");
    expect(bounded.messages).toHaveLength(MAX_IMPORTED_SESSION_MESSAGES);
    expect(bounded.messages[0]?.text).toBe("message 5");
    expect(bounded.messages.at(-1)?.text).toBe(
      `message ${String(MAX_IMPORTED_SESSION_MESSAGES + 4)}`,
    );
  });

  it("stops at the byte cap, clips one long message, and says both", () => {
    const long = "x".repeat(MAX_IMPORTED_SESSION_MESSAGE_BYTES * 2);
    const count = Math.ceil(MAX_IMPORTED_SESSION_BYTES / MAX_IMPORTED_SESSION_MESSAGE_BYTES) + 2;
    const bounded = boundImportedSessionHistory({
      status: "read",
      messages: Array.from({ length: count }, () => ({ role: "agent" as const, text: long })),
    });
    if (bounded.status !== "imported") throw new Error("expected an import");
    expect(bounded.messages.length).toBe(
      MAX_IMPORTED_SESSION_BYTES / MAX_IMPORTED_SESSION_MESSAGE_BYTES,
    );
    expect(bounded.omittedMessages).toBe(count - bounded.messages.length);
    expect(bounded.messages[0]).toMatchObject({ clipped: true });
    expect(bounded.messages[0]?.text).toHaveLength(MAX_IMPORTED_SESSION_MESSAGE_BYTES);
  });

  it("imports none from a runtime without a history read, or one whose session is empty", async () => {
    expect(await readImportedSessionHistory(sessions(), input)).toEqual({
      status: "none",
      reason: "unsupported",
    });
    expect(
      await readImportedSessionHistory(
        sessions(() =>
          Effect.succeed({ status: "read", messages: [{ role: "agent", text: "  " }] }),
        ),
        input,
      ),
    ).toEqual({ status: "none", reason: "empty" });
  });

  it("imports none as unreadable when the read fails, dies, or runs past its time", async () => {
    const failing = sessions(() => Effect.fail({ category: "unavailable", message: "gone" }));
    const dying = sessions(() => Effect.die(new Error("broken")));
    const stalled = sessions(() => Effect.never);
    for (const nativeSessions of [failing, dying])
      expect(await readImportedSessionHistory(nativeSessions, input)).toEqual({
        status: "none",
        reason: "unreadable",
      });
    expect(await readImportedSessionHistory(stalled, input, 10)).toEqual({
      status: "none",
      reason: "unreadable",
    });
  });
});
