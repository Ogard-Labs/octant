import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { decodeCodeThreadId } from "@octant/contracts";
import {
  decodeProviderCloudResponse,
  type ProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";
import type { ProviderCloudSessionClient } from "@octant/client-runtime/provider-cloud-session-client";
import { ProviderCloudSessions } from "./ProviderCloudSessions";

const threadId = decodeCodeThreadId("a7550000-0000-4000-8000-000000000001");
const otherThreadId = decodeCodeThreadId("a7550000-0000-4000-8000-000000000002");
const profiles = [
  {
    instanceId: "a7550000-0000-4000-8000-000000000003",
    label: "Fixture cloud",
    supported: true,
    enabled: true,
    models: ["fixture-model"],
  },
];
const ready = decodeProviderCloudResponse({ status: "ready", profiles, jobs: [] });
afterEach(() => vi.unstubAllGlobals());

describe("Code provider cloud sessions", () => {
  it("requires exact text review and separate execution consent before a cloud start", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const execute = vi.fn<ProviderCloudSessionClient["execute"]>().mockResolvedValue(ready);
    const user = userEvent.setup();
    render(<ProviderCloudSessions client={{ execute }} threadId={threadId} />);
    fireEvent.click(screen.getByText("Provider cloud sessions"));
    const text = await screen.findByLabelText("Task text to send");
    await user.type(text, "Explain this synthetic input.");
    await user.click(screen.getByRole("button", { name: "Review cloud task" }));
    const run = screen.getByRole("button", { name: "Run in provider cloud" });
    expect(run).toBeDisabled();
    expect(execute.mock.calls.filter(([command]) => command.kind === "start")).toHaveLength(0);
    await user.click(screen.getByRole("checkbox"));
    await user.click(run);
    await waitFor(() =>
      expect(execute.mock.calls.filter(([command]) => command.kind === "start")).toHaveLength(1),
    );
    expect(execute.mock.calls.find(([command]) => command.kind === "start")?.[0]).toMatchObject({
      kind: "start",
      input: "Explain this synthetic input.",
      cloudExecutionConsent: true,
      modelId: "fixture-model",
    });
  });

  it("does not publish a previous thread's delayed cloud receipt after navigation", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const pending = Promise.withResolvers<ProviderCloudResponse>();
    const execute = vi
      .fn<ProviderCloudSessionClient["execute"]>()
      .mockImplementation(async (command) => (command.kind === "start" ? pending.promise : ready));
    const client = { execute };
    const user = userEvent.setup();
    const rendered = render(<ProviderCloudSessions client={client} threadId={threadId} />);
    fireEvent.click(screen.getByText("Provider cloud sessions"));
    await user.type(await screen.findByLabelText("Task text to send"), "Synthetic input.");
    await user.click(screen.getByRole("button", { name: "Review cloud task" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Run in provider cloud" }));
    await waitFor(() =>
      expect(execute.mock.calls.some(([command]) => command.kind === "start")).toBe(true),
    );
    rendered.rerender(<ProviderCloudSessions client={client} threadId={otherThreadId} />);
    await act(async () =>
      pending.resolve(
        decodeProviderCloudResponse({
          status: "ready",
          profiles,
          jobs: [
            {
              id: "a7550000-0000-4000-8000-000000000004",
              version: 1,
              threadId,
              projectId: "a7550000-0000-4000-8000-000000000005",
              instanceId: profiles[0]?.instanceId,
              modelId: "fixture-model",
              input: "Synthetic input.",
              inputDigest: "a".repeat(64),
              state: "completed",
              remoteId: "sess_old",
              output: "Previous private receipt",
              truncated: false,
              createdAt: "2026-11-04T12:00:00.000Z",
              updatedAt: "2026-11-04T12:00:00.000Z",
            },
          ],
        }),
      ),
    );
    expect(screen.queryByText("Previous private receipt")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task text to send")).toHaveValue("");
  });
});
