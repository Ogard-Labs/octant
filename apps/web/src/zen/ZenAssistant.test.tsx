import type { NavigatorAssistantClient } from "@octant/client-runtime";
import type {
  NavigatorAssistantSnapshot,
  UtcTimestamp,
  ZenAssistantSnapshot,
} from "@octant/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigatorPanel } from "../navigator/NavigatorPanel";
import { useNavigatorAssistant } from "../navigator/useNavigatorAssistant";
import { ZenAssistant } from "./ZenAssistant";
import { entry } from "./ZenThreadPicker.test-fixture";

afterEach(cleanup);

const TIMESTAMP = "2026-07-28T12:00:00.000Z" as UtcTimestamp;

const snapshot: ZenAssistantSnapshot = {
  status: "ready",
  binding: {
    threadId: entry.threadId as never,
    providerId: String(entry.providerInstanceId),
    modelId: String(entry.modelId),
  },
  provider: {
    providerInstanceId: entry.providerInstanceId,
    providerLabel: "Local provider",
    modelId: entry.modelId,
    modelLabel: "Local model",
    readiness: "ready",
    toolCapability: "unsupported",
    toolCapabilityReason: "Use the manual Zen controls.",
  },
  transcript: [],
  manualControls: ["threads", "widgets", "add", "placement", "appearance"],
};

function navigatorSnapshot(
  transcript: NavigatorAssistantSnapshot["transcript"] = [],
): NavigatorAssistantSnapshot {
  return {
    status: "ready",
    settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    threadId: null,
    transcript,
    defaultProvider: {
      providerInstanceId: "00000000-0000-4000-8000-00000000b001",
      modelId: "navigator-model",
    },
    imageInput: "supported",
    visionReviewer: null,
  } as NavigatorAssistantSnapshot;
}

/** One host-owned Navigator conversation, shared by every front that reads it. */
function hostNavigator(): NavigatorAssistantClient {
  const transcript: Array<NavigatorAssistantSnapshot["transcript"][number]> = [
    { role: "assistant", text: "What needs focus?", createdAt: TIMESTAMP },
  ];
  return {
    snapshot: async () => navigatorSnapshot(transcript),
    execute: async (command) => {
      transcript.push({ role: "user", text: command.prompt, createdAt: TIMESTAMP });
      return { kind: "message-sent", snapshot: navigatorSnapshot(transcript) };
    },
  };
}

describe("ZenAssistant", () => {
  it("shows a typed preview as inert until the user explicitly saves or places it", async () => {
    const onConfirmRecipe = vi.fn();
    function Harness() {
      const controller = useNavigatorAssistant(useState(hostNavigator)[0]);
      return (
        <ZenAssistant
          controller={controller}
          onClose={vi.fn()}
          onConfirmRecipe={onConfirmRecipe}
          onOpenSettings={vi.fn()}
          onOpenThreads={vi.fn()}
          snapshot={{
            ...snapshot,
            provider: { ...snapshot.provider!, toolCapability: "supported" },
            recipePreview: {
              previewId: "00000000-0000-4000-8000-000000000016" as never,
              recipe: {
                recipeId: "00000000-0000-4000-8000-000000000017" as never,
                name: "Release focus",
                primitives: ["checklist", "text"],
                fields: [],
              },
              providerInstanceId: snapshot.provider!.providerInstanceId,
              modelId: snapshot.provider!.modelId,
              expectedVersion: 2 as never,
              createdAt: "2026-07-29T12:00:00.000Z" as never,
              expiresAt: "2026-07-29T12:10:00.000Z" as never,
            },
          }}
        />
      );
    }
    render(<Harness />);

    expect(await screen.findByText(/nothing has been saved or placed/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Place recipe" }));
    expect(onConfirmRecipe).toHaveBeenCalledWith("place");
  });

  it("keeps the Zen tool-capability truth and the manual Threads fallback", async () => {
    const onOpenThreads = vi.fn();
    function Harness() {
      const controller = useNavigatorAssistant(useState(hostNavigator)[0]);
      return (
        <ZenAssistant
          controller={controller}
          onClose={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenThreads={onOpenThreads}
          snapshot={snapshot}
        />
      );
    }
    render(<Harness />);

    expect(await screen.findByText(/Assistant actions unavailable/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Threads" }));
    expect(onOpenThreads).toHaveBeenCalledOnce();
  });

  it("runs on the configured Navigator model, not on Zen's own thread provider", async () => {
    function Harness() {
      const controller = useNavigatorAssistant(useState(hostNavigator)[0]);
      return (
        <ZenAssistant
          controller={controller}
          onClose={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenThreads={vi.fn()}
          snapshot={snapshot}
        />
      );
    }
    render(<Harness />);

    expect(await screen.findByText("Running on navigator-model")).toBeVisible();
    // Zen's thread provider is no longer what the assistant answers on.
    expect(screen.queryByText(/Local provider.*Local model/)).toBeNull();
  });

  it("shares one conversation with the dock panel through the same controller", async () => {
    function Harness() {
      // One controller, two fronts — exactly how App mounts them.
      const controller = useNavigatorAssistant(useState(hostNavigator)[0]);
      return (
        <>
          <ZenAssistant
            controller={controller}
            onClose={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenThreads={vi.fn()}
            snapshot={snapshot}
          />
          <div data-testid="dock">
            <NavigatorPanel controller={controller} onOpenSettings={vi.fn()} />
          </div>
        </>
      );
    }
    render(<Harness />);

    const transcripts = await screen.findAllByRole("log", { name: "Navigator transcript" });
    expect(transcripts).toHaveLength(2);
    await waitFor(() =>
      transcripts.forEach((log) => expect(log).toHaveTextContent("What needs focus?")),
    );

    // Sending from Zen's front is on screen in the dock front too, because the
    // conversation is the host's, not either surface's.
    fireEvent.change(screen.getAllByLabelText("Message Navigator")[0]!, {
      target: { value: "Attach it" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Send to Navigator" })[0]!);

    await waitFor(() => transcripts.forEach((log) => expect(log).toHaveTextContent("Attach it")));
  });
});
