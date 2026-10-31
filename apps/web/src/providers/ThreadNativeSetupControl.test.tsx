import { decodeProviderInstanceId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadNativeSetupControl, ThreadNativeSetupProvider } from "./ThreadNativeSetupControl";

const codexId = decodeProviderInstanceId("90000000-0000-4000-8000-000000000001");
const piId = decodeProviderInstanceId("90000000-0000-4000-8000-000000000002");
const threadId = "90000000-0000-4000-8000-000000000003";

function services(choice: "on" | "off" | "inherit" = "inherit") {
  return {
    instances: [
      { id: codexId, driverKind: "codex" as const },
      { id: piId, driverKind: "pi" as const },
    ],
    read: vi.fn(async () => choice),
    change: vi.fn(
      async (_thread: string, _provider: unknown, next: "on" | "off" | "inherit") => next,
    ),
  };
}

describe("a thread's own-setup choice", () => {
  it("lets the person turn a key provider's own setup off for this thread", async () => {
    const host = services();
    render(
      <ThreadNativeSetupProvider services={host}>
        <ThreadNativeSetupControl providerInstanceId={codexId} threadId={threadId} />
      </ThreadNativeSetupProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Provider’s own setup" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Off/ }));
    await waitFor(() => expect(host.change).toHaveBeenCalledWith(threadId, codexId, "off"));
    expect(await screen.findByText("Own setup off")).toBeTruthy();
  });

  it("shows the choice already made for the thread", async () => {
    render(
      <ThreadNativeSetupProvider services={services("on")}>
        <ThreadNativeSetupControl providerInstanceId={codexId} threadId={threadId} />
      </ThreadNativeSetupProvider>,
    );
    expect(await screen.findByText("Own setup on")).toBeTruthy();
  });

  it("stays out of the way for a provider that is not a key provider", () => {
    render(
      <ThreadNativeSetupProvider services={services()}>
        <ThreadNativeSetupControl providerInstanceId={piId} threadId={threadId} />
      </ThreadNativeSetupProvider>,
    );
    expect(screen.queryByRole("button", { name: "Provider’s own setup" })).toBeNull();
  });
});
