import type { NavigatorAssistantClient } from "@octant/client-runtime";
import type { NavigatorAssistantSnapshot, UtcTimestamp } from "@octant/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechCapabilityProvider } from "../voice/SpeechCapabilityContext";
import {
  fakeSpeechClient,
  speechTestInstances,
  speechTestSettings,
} from "../voice/speechTestSupport";
import { NavigatorPanel } from "./NavigatorPanel";
import { useNavigatorAssistant } from "./useNavigatorAssistant";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TIMESTAMP = "2026-09-05T09:00:00.000Z" as UtcTimestamp;
const LATER = "2026-09-05T09:00:05.000Z" as UtcTimestamp;

function snapshot(
  transcript: NavigatorAssistantSnapshot["transcript"],
): NavigatorAssistantSnapshot {
  return {
    status: "ready",
    settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    threadId: null,
    transcript,
    defaultProvider: {
      providerInstanceId: "00000000-0000-4000-8000-00000000b001",
      modelId: "model-a",
    },
    imageInput: "supported",
    visionReviewer: null,
  } as NavigatorAssistantSnapshot;
}

/** A Navigator with nothing on screen that answers for the first time on send. */
function emptyNavigatorClient(): NavigatorAssistantClient {
  const existing = snapshot([]);
  return {
    snapshot: async () => existing,
    execute: async () => ({
      kind: "message-sent",
      snapshot: snapshot([
        { role: "user", text: "what now", createdAt: LATER },
        { role: "assistant", text: "A first reply.", createdAt: LATER },
      ]),
    }),
  } as unknown as NavigatorAssistantClient;
}

/** A Navigator that already answered once and answers again on send. */
function navigatorClient(): NavigatorAssistantClient {
  const existing = snapshot([
    { role: "user", text: "hi", createdAt: TIMESTAMP },
    { role: "assistant", text: "Already on screen.", createdAt: TIMESTAMP },
  ]);
  return {
    snapshot: async () => existing,
    execute: async () => ({
      kind: "message-sent",
      snapshot: snapshot([
        ...existing.transcript,
        { role: "user", text: "what now", createdAt: LATER },
        { role: "assistant", text: "A fresh reply.", createdAt: LATER },
      ]),
    }),
  } as unknown as NavigatorAssistantClient;
}

function Harness(props: {
  readonly client: NavigatorAssistantClient;
  readonly speech?: ReturnType<typeof fakeSpeechClient>["client"];
  readonly synthesisConfigured?: boolean;
}) {
  const controller = useNavigatorAssistant(props.client);
  return (
    <SpeechCapabilityProvider
      client={props.speech}
      instances={speechTestInstances()}
      settings={speechTestSettings({ synthesis: props.synthesisConfigured === true })}
    >
      <NavigatorPanel controller={controller} onOpenSettings={() => {}} />
    </SpeechCapabilityProvider>
  );
}

function stubSystemVoice() {
  const speak = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal("speechSynthesis", { speak, cancel });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
      addEventListener() {}
    },
  );
  return { speak, cancel };
}

describe("Navigator read-aloud", () => {
  it("offers no read-aloud when neither a provider voice nor a system voice exists", async () => {
    render(<Harness client={navigatorClient()} />);
    await screen.findByRole("log", { name: "Navigator transcript" });
    expect(screen.queryByRole("button", { name: /Read replies aloud/ })).toBeNull();
  });

  it("reads only replies that arrive after it was switched on, with the system voice when no provider is set", async () => {
    const user = userEvent.setup();
    const { speak } = stubSystemVoice();
    render(<Harness client={navigatorClient()} />);
    await screen.findByRole("log", { name: "Navigator transcript" });

    const toggle = screen.getByRole("button", { name: "Read replies aloud (system voice)" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(speak).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Message Navigator" }), "what now");
    await user.click(screen.getByRole("button", { name: "Send to Navigator" }));

    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect((speak.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe("A fresh reply.");
  });

  it("reads the first reply when read-aloud was switched on with an empty transcript", async () => {
    const user = userEvent.setup();
    const { speak } = stubSystemVoice();
    render(<Harness client={emptyNavigatorClient()} />);
    await screen.findByRole("log", { name: "Navigator transcript" });

    await user.click(screen.getByRole("button", { name: "Read replies aloud (system voice)" }));
    await user.type(screen.getByRole("textbox", { name: "Message Navigator" }), "what now");
    await user.click(screen.getByRole("button", { name: "Send to Navigator" }));

    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect((speak.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe("A first reply.");
  });

  it("asks the configured provider for audio instead of the system voice", async () => {
    const user = userEvent.setup();
    const { speak } = stubSystemVoice();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:octant/reply"),
      revokeObjectURL: vi.fn(),
    });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(async () => undefined);
    const { client, synthesize } = fakeSpeechClient();
    render(<Harness client={navigatorClient()} speech={client} synthesisConfigured />);
    await screen.findByRole("log", { name: "Navigator transcript" });

    await user.click(screen.getByRole("button", { name: "Read replies aloud" }));
    await user.type(screen.getByRole("textbox", { name: "Message Navigator" }), "what now");
    await user.click(screen.getByRole("button", { name: "Send to Navigator" }));

    await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    expect((synthesize.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe(
      "A fresh reply.",
    );
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(speak).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Stop reading" })).toBeVisible();
    play.mockRestore();
  });
});
