import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMoveClient } from "../environment/threadMove/threadMoveClient";
import { createHandoversCard } from "./HandoversCard";

const HANDOVER = "12345678-1234-4234-8234-123456789012";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const NEW_THREAD = "88888888-8888-4888-8888-888888888888";

function Card(props: {
  readonly client: Partial<ThreadMoveClient>;
  readonly onOpen: (id: string) => void;
}) {
  const card = createHandoversCard({
    client: props.client as ThreadMoveClient,
    onOpenThread: props.onOpen,
  });
  const content = card.useContent();
  return content.status === "ready" ? <div>{content.body}</div> : <p>Loading</p>;
}

describe("the Handovers card", () => {
  it("continues a handover in the one fitting Project and opens the thread it became", async () => {
    const user = userEvent.setup();
    const continued: Array<{ handoverId: string; projectId: string }> = [];
    const opened = vi.fn();
    render(
      <Card
        client={{
          handoversList: async () => ({
            status: "listed",
            handovers: [
              {
                handoverId: HANDOVER as never,
                title: "Fix the flaky test",
                branch: "feature/flaky",
                repositoryRemote: "git@github.com:person/octant.git",
                originMemberId: "33333333-3333-4333-8333-333333333333" as never,
                originName: "Laptop",
                projects: [{ projectId: PROJECT as never, title: "octant" }],
                receivedAt: "2026-11-08T12:00:00.000Z" as never,
              },
            ],
          }),
          handoversContinue: async (request) => {
            continued.push(request);
            return { status: "continued", thread: { mode: "code", threadId: NEW_THREAD } };
          },
        }}
        onOpen={opened}
      />,
    );
    expect(await screen.findByText("Fix the flaky test")).toBeInTheDocument();
    expect(screen.getByText(/From Laptop/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue handover" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(NEW_THREAD));
    expect(continued).toEqual([{ handoverId: HANDOVER, projectId: PROJECT }]);
  });

  it("says why it cannot continue without a Project bound to the repository", async () => {
    render(
      <Card
        client={{
          handoversList: async () => ({
            status: "listed",
            handovers: [
              {
                handoverId: HANDOVER as never,
                title: "Fix the flaky test",
                branch: "feature/flaky",
                repositoryRemote: "git@github.com:person/other.git",
                originMemberId: "33333333-3333-4333-8333-333333333333" as never,
                originName: "Laptop",
                projects: [],
                receivedAt: "2026-11-08T12:00:00.000Z" as never,
              },
            ],
          }),
        }}
        onOpen={() => {}}
      />,
    );
    expect(
      await screen.findByText("No Code Project here is bound to that repository."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue handover" })).toBeDisabled();
  });
});
