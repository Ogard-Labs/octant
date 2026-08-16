import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasVersionHistoryPanel, ReviseCanvasDraft } from "./CanvasRevisionPanel";

const entries = [
  {
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    schemaVersion: 1,
    title: "Quarterly summary",
    createdAt: "2026-08-01T21:00:00.000Z",
    createdBy: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-test-model",
  },
  {
    versionId: "33333333-3333-4333-8333-333333333333",
    sequence: 2,
    schemaVersion: 1,
    title: "Quarterly summary",
    createdAt: "2026-08-01T21:01:00.000Z",
    createdBy: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-revise-model",
    promptSummary: "Add a summary section",
  },
] as const;

describe("Canvas revision UI", () => {
  it("submits a bounded revise prompt", async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn(async () => true);
    render(
      <ReviseCanvasDraft
        expectedSequence={1}
        requestBase={{
          canvasId: "11111111-1111-4111-8111-111111111111" as never,
          hostId: "local" as never,
          mode: "chat",
          workspace: { kind: "chat-virtual", projectId: null },
          originThreadId: "99999999-9999-4999-8999-999999999999" as never,
          actor: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" as never },
          providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
          modelId: "octant-test-model" as never,
          requestedAuthority: {
            filesystem: false,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: false,
            executionPolicy: "plan",
            permissionPersistence: "current-session",
          },
        }}
        onRevise={onRevise}
      />,
    );
    await user.type(screen.getByLabelText("Revision prompt"), "Add a summary section");
    await user.click(screen.getByTestId("canvas-revise-submit"));
    expect(onRevise).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas-revise",
        prompt: "Add a summary section",
        expectedSequence: 1,
      }),
    );
  });

  it("lists version history entries and selects a prior version", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CanvasVersionHistoryPanel
        entries={entries as never}
        selectedVersionId="22222222-2222-4222-8222-222222222222"
        currentVersionId="33333333-3333-4333-8333-333333333333"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId("canvas-version-history")).toBeInTheDocument();
    expect(screen.getByText("Add a summary section")).toBeInTheDocument();
    await user.click(screen.getByTestId("canvas-version-1"));
    expect(onSelect).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });
});
