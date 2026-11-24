import type { ThreadSecretsClient } from "@octant/client-runtime/thread-secrets-client";
import type { ThreadSecretCommand, ThreadSecretsHostView } from "@octant/contracts/thread-secrets";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadSecretsSettings } from "./ThreadSecretsSettings";

const ACTIVE = "00000000-0000-4000-8000-000000000001";
const REMEMBERED = "00000000-0000-4000-8000-000000000002";
const full: ThreadSecretsHostView = {
  active: [
    {
      id: ACTIVE,
      threadId: "thread",
      threadTitle: "Publish the preview",
      name: "DEPLOY_TOKEN",
      label: "Deploy token",
      kind: "token",
      source: "pasted",
      lifetime: "until-archived",
      delivery: "file-and-environment",
    },
  ],
  remembered: [{ id: REMEMBERED, name: "NPM_TOKEN", source: "pasted" }],
};

function setup(status: "accepted" | "refused" | "throws" = "accepted") {
  let view = full;
  const sent: ThreadSecretCommand[] = [];
  const client: ThreadSecretsClient = {
    read: vi.fn(),
    readHost: async () => view,
    execute: async (command) => {
      sent.push(command);
      if (status === "throws") throw new Error("offline");
      if (status === "refused") return { status, failure: "unavailable" };
      view = { active: [], remembered: [] };
      return { status };
    },
  };
  render(<ThreadSecretsSettings client={client} />);
  return { sent };
}

describe("secrets in Settings", () => {
  it("names each active secret with its thread and time, and revokes one", async () => {
    const { sent } = setup();
    expect(
      await screen.findByText("DEPLOY_TOKEN · Publish the preview · Entered · Until archived"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Deploy token, DEPLOY_TOKEN" }),
    );
    expect(await screen.findByText("No thread has an active secret.")).toBeInTheDocument();
    expect(sent).toEqual([{ kind: "revoke", threadId: "thread", secretId: ACTIVE }]);
  });

  it("forgets a remembered secret only after the person confirms", async () => {
    const { sent } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Forget NPM_TOKEN" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Forget NPM_TOKEN" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Forget" }),
    );
    expect(await screen.findByText("Octant remembers no secret.")).toBeInTheDocument();
    expect(sent).toEqual([{ kind: "forget", id: REMEMBERED }]);
  });

  it.each(["refused", "throws"] as const)(
    "keeps the row and says so when it %s",
    async (status) => {
      setup(status);
      await userEvent.click(
        await screen.findByRole("button", { name: "Revoke Deploy token, DEPLOY_TOKEN" }),
      );
      expect(await screen.findByText(/Deploy token could not be revoked/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("Deploy token")).toBeInTheDocument());
    },
  );
});
