import {
  NavigatorAssistantClientFailure,
  type NavigatorAssistantClient,
} from "@octant/client-runtime";
import type {
  NavigatorAssistantCommand,
  NavigatorAssistantSnapshot,
  UtcTimestamp,
} from "@octant/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigatorPanel } from "./NavigatorPanel";
import { useNavigatorAssistant } from "./useNavigatorAssistant";

afterEach(cleanup);

/**
 * Drives the panel through the real hook and a real client, so these assert
 * what a mounted Navigator does rather than what a hand-built state renders.
 */
function Harness(props: {
  readonly client?: NavigatorAssistantClient;
  readonly onOpenSettings?: (target: { readonly section: string }) => void;
}) {
  const controller = useNavigatorAssistant(props.client);
  return (
    <NavigatorPanel controller={controller} onOpenSettings={props.onOpenSettings ?? (() => {})} />
  );
}

const TIMESTAMP = "2026-08-15T09:00:00.000Z" as UtcTimestamp;

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

/** A client that answers with what the host said, and records what it was told. */
function client(options: {
  readonly snapshot?: NavigatorAssistantSnapshot;
  readonly snapshotError?: unknown;
  readonly onExecute?: (command: NavigatorAssistantCommand) => NavigatorAssistantSnapshot;
}): NavigatorAssistantClient & { readonly commands: NavigatorAssistantCommand[] } {
  const commands: NavigatorAssistantCommand[] = [];
  return {
    commands,
    snapshot: async () => {
      if (options.snapshotError !== undefined) throw options.snapshotError;
      return options.snapshot ?? snapshot();
    },
    execute: async (command) => {
      commands.push(command);
      return {
        kind: "message-sent",
        snapshot: options.onExecute?.(command) ?? options.snapshot ?? snapshot(),
      };
    },
  };
}

describe("NavigatorPanel", () => {
  it("renders the host's Navigator conversation and sends through the client", async () => {
    const user = userEvent.setup();
    const navigator = client({
      snapshot: snapshot({
        transcript: [{ role: "user", text: "Earlier question", createdAt: TIMESTAMP }],
      }),
      onExecute: () =>
        snapshot({
          transcript: [
            { role: "user", text: "Earlier question", createdAt: TIMESTAMP },
            { role: "user", text: "Which model am I on?", createdAt: TIMESTAMP },
            { role: "assistant", text: "model-a.", createdAt: TIMESTAMP },
          ],
        }),
    });

    render(<Harness client={navigator} />);

    // Settle on the revealed conversation rather than asserting against
    // content a re-suspended boundary may only have hidden.
    const transcript = await screen.findByRole("log", { name: "Navigator transcript" });
    await waitFor(() => expect(transcript).toHaveTextContent("Earlier question"));

    await user.type(screen.getByLabelText("Message Navigator"), "Which model am I on?");
    await user.click(screen.getByRole("button", { name: "Send to Navigator" }));

    expect(navigator.commands).toEqual([{ kind: "send-message", prompt: "Which model am I on?" }]);
    await waitFor(() => expect(transcript).toHaveTextContent("model-a."));
  });

  it("names the configured model it is running on", async () => {
    render(<Harness client={client({})} />);

    expect(await screen.findByText("Running on model-a")).toBeVisible();
  });

  it("offers the settings fix for an unconfigured Navigator instead of an empty transcript", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <Harness
        client={client({ snapshot: snapshot({ status: "unconfigured", defaultProvider: null }) })}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(await screen.findByText("Navigator has no default model")).toBeVisible();
    // The configure state is not a blank conversation: there is no transcript
    // at all, and the composer cannot spend a turn.
    expect(screen.queryByRole("log", { name: "Navigator transcript" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send to Navigator" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Open Navigator settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "navigator-assistant",
      setting: "default-model",
    });
  });

  it("treats the host's 409 unconfigured refusal as the configure state, not an error", async () => {
    render(
      <Harness
        client={client({
          snapshotError: new NavigatorAssistantClientFailure(
            "Navigator has no default model.",
            409,
            "unconfigured",
            { section: "navigator-assistant", setting: "default-model" },
          ),
        })}
      />,
    );

    expect(await screen.findByText("Navigator has no default model")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an unavailable host distinctly from an empty conversation", async () => {
    render(
      <Harness
        client={client({
          snapshotError: new NavigatorAssistantClientFailure(
            "The Navigator conversation is unavailable.",
            503,
            "unavailable",
          ),
        })}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Navigator is unavailable");
    expect(alert).toHaveTextContent("The Navigator conversation is unavailable.");
    // Unavailable is not empty: no transcript and no composer are offered.
    expect(screen.queryByRole("log", { name: "Navigator transcript" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to Navigator" })).toBeNull();
  });

  it("reports an empty conversation as empty, not as unavailable", async () => {
    render(<Harness client={client({})} />);

    expect(await screen.findByText("No messages yet. Ask Navigator anything.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a model that cannot read images rather than assuming it can", async () => {
    render(<Harness client={client({ snapshot: snapshot({ imageInput: "unknown" }) })} />);

    expect(await screen.findByText("Images unavailable")).toBeVisible();
    expect(
      screen.getByText(
        "The Navigator model is not known to read images, and no vision reviewer is configured.",
      ),
    ).toBeVisible();
  });

  it("says so plainly when the host serves no Navigator at all", async () => {
    render(<Harness />);

    expect(await screen.findByText("Navigator is not available on this host.")).toBeVisible();
  });
});
