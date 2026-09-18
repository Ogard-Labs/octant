import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigatorAssistantClient } from "@octant/client-runtime";
import type { NavigatorAssistantSnapshot } from "@octant/contracts";
import { useNavigatorAssistant } from "./useNavigatorAssistant";

function snapshot(overrides: Partial<NavigatorAssistantSnapshot> = {}): NavigatorAssistantSnapshot {
  return {
    status: "ready",
    settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    threadId: null,
    transcript: [],
    defaultProvider: {
      providerInstanceId: "00000000-0000-4000-8000-00000000b001",
      modelId: "model-a",
    },
    imageInput: "supported",
    visionReviewer: null,
    ...overrides,
  } as NavigatorAssistantSnapshot;
}

/** A client that answers with whatever the host currently says, and counts reads. */
function hostClient(initial: NavigatorAssistantSnapshot) {
  let answer = initial;
  const reads = vi.fn(async () => answer);
  const client = {
    snapshot: reads,
    execute: vi.fn(),
  } as unknown as NavigatorAssistantClient;
  return {
    client,
    reads,
    answersWith: (next: NavigatorAssistantSnapshot) => {
      answer = next;
    },
  };
}

function Surface(props: {
  readonly client: NavigatorAssistantClient;
  readonly configuration: string;
}) {
  const controller = useNavigatorAssistant(props.client, {
    enabled: true,
    configuration: props.configuration,
  });
  return <span data-testid="kind">{controller.state.kind}</span>;
}

describe("useNavigatorAssistant", () => {
  it("re-reads the host snapshot when the Navigator configuration changes", async () => {
    const host = hostClient(snapshot());
    const view = render(<Surface client={host.client} configuration="model-a" />);
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));
    expect(host.reads).toHaveBeenCalledTimes(1);

    view.rerender(<Surface client={host.client} configuration="model-b" />);

    await waitFor(() => expect(host.reads).toHaveBeenCalledTimes(2));
  });

  it("does not re-read while the configuration is unchanged", async () => {
    const host = hostClient(snapshot());
    const view = render(<Surface client={host.client} configuration="model-a" />);
    await waitFor(() => expect(host.reads).toHaveBeenCalledTimes(1));

    view.rerender(<Surface client={host.client} configuration="model-a" />);
    view.rerender(<Surface client={host.client} configuration="model-a" />);

    await Promise.resolve();
    expect(host.reads).toHaveBeenCalledTimes(1);
  });

  it("stops offering Navigator as soon as the configuration is cleared", async () => {
    const host = hostClient(snapshot());
    const view = render(<Surface client={host.client} configuration="model-a" />);
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));

    host.answersWith(snapshot({ status: "unconfigured", defaultProvider: null }));
    view.rerender(<Surface client={host.client} configuration="" />);

    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("unconfigured"));
  });
});
