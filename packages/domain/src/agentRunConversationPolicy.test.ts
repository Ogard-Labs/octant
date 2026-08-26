import { describe, expect, it } from "vitest";
import { MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS, type UtcTimestamp } from "@octant/contracts";
import { resolveAgentRunConversationDisclosure } from "./agentRunConversationPolicy";

const occurredAt = "2026-08-23T00:00:00.000Z" as UtcTimestamp;

const liveEntry = {
  sequence: 2,
  kind: "assistant" as const,
  text: "partial finding",
  occurredAt,
};

describe("resolveAgentRunConversationDisclosure", () => {
  it("returns a bounded live managed snapshot and honors the replay cursor", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "octant-managed",
        lifecycleStatus: "running",
        live: {
          status: "live",
          entries: [{ sequence: 1, kind: "assistant", text: "earlier", occurredAt }, liveEntry],
          truncated: true,
        },
        afterSequence: 1,
      }),
    ).toEqual({
      status: "live",
      entries: [liveEntry],
      truncated: true,
    });
  });

  it("keeps a host-retained result for native and managed children after completion", () => {
    const retained = {
      text: "The review is consistent.",
      truncated: false,
      occurredAt,
    };
    for (const executionKind of ["octant-managed", "provider-native"] as const) {
      expect(
        resolveAgentRunConversationDisclosure({
          executionKind,
          lifecycleStatus: "completed",
          retained,
        }),
      ).toEqual({
        status: "complete",
        entries: [
          {
            sequence: 1,
            kind: "assistant",
            text: retained.text,
            occurredAt,
          },
        ],
        truncated: false,
      });
    }
  });

  it("refuses live native text without transcript capability even when a store snapshot exists", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "provider-native",
        lifecycleStatus: "running",
        nativeLiveTranscriptSupport: "unavailable",
        live: {
          status: "live",
          entries: [liveEntry],
          truncated: false,
        },
      }),
    ).toEqual({
      status: "unavailable",
      entries: [],
      truncated: false,
      staleReason: "Provider-native child transcript is not available through this host.",
    });
  });

  it("exposes a native live snapshot only when capability evidence permits it", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "provider-native",
        lifecycleStatus: "running",
        nativeLiveTranscriptSupport: "supported",
        live: {
          status: "live",
          entries: [liveEntry],
          truncated: false,
        },
      }),
    ).toEqual({
      status: "live",
      entries: [liveEntry],
      truncated: false,
    });
  });

  it("marks an active managed child stale after restart rather than inventing text", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "octant-managed",
        lifecycleStatus: "waiting",
        surface: "snapshot",
      }).status,
    ).toBe("stale");
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "octant-managed",
        lifecycleStatus: "interrupted",
        recoveryReason: "restart-without-resumable-execution",
        surface: "stream",
      }),
    ).toMatchObject({
      status: "stale",
      entries: [],
      staleReason:
        "The child session is no longer connected to this host; reconnect to resume viewing.",
    });
  });

  it("preserves cancellation as stale when the live store still holds text", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "octant-managed",
        lifecycleStatus: "cancelled",
        live: {
          status: "stale",
          entries: [liveEntry],
          truncated: false,
          staleReason: "The child session ended before a complete transcript was retained.",
        },
      }),
    ).toMatchObject({
      status: "stale",
      entries: [liveEntry],
      staleReason: "The child session ended before a complete transcript was retained.",
    });
  });

  it("reports inaccessible history instead of an empty completed transcript", () => {
    expect(
      resolveAgentRunConversationDisclosure({
        executionKind: "octant-managed",
        lifecycleStatus: "completed",
      }),
    ).toEqual({
      status: "unavailable",
      entries: [],
      truncated: false,
      staleReason: "No retained child conversation is available.",
    });
  });

  it("bounds a retained reply that is larger than one conversation entry", () => {
    const disclosure = resolveAgentRunConversationDisclosure({
      executionKind: "octant-managed",
      lifecycleStatus: "completed",
      retained: {
        text: "x".repeat(MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS + 24),
        truncated: false,
        occurredAt,
      },
    });
    expect(disclosure.status).toBe("complete");
    expect(disclosure.truncated).toBe(true);
    expect(disclosure.entries[0]?.text).toHaveLength(MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS);
  });
});
