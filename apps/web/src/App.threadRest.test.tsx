import { decodeCodeThread } from "@octant/contracts";
import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  chatShellBootstrap,
  chats,
  client,
  codeShellBootstrap,
  codes,
  projectWindowCapability,
  projects,
  providers,
  windowId,
} from "./App.test-fixtures";

/**
 * Completing, snoozing, and waking from a sidebar row, rendered through the
 * whole shell because that is where the two halves meet: the host decides
 * whether a thread may rest, and the sidebar decides where the row then goes.
 *
 * These live beside `App.test.tsx` rather than inside it. Driving a row's menu
 * leaves state that the next full-shell render in the same file trips over, so
 * a suite of its own is what keeps both sets honest.
 */
describe("thread rest from the sidebar", () => {
  function shell(codeClient: CodeClient) {
    return (
      <App
        chatClient={chats()}
        codeClient={codeClient}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />
    );
  }

  /* Chat mode with no thread open, which is how a sidebar row is used. */
  function chatShell(chatClient: ChatClient) {
    return (
      <App
        chatClient={chatClient}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />
    );
  }

  it("says why the host refused to snooze a Code thread from its sidebar row", async () => {
    const codeApi: CodeClient = {
      ...codes(),
      execute: vi.fn(async () => {
        throw { category: "invalid", message: "This thread is waiting on you." };
      }),
    };
    render(shell(codeApi));

    const row = within(await screen.findByRole("navigation", { name: "Projects" })).getByRole(
      "button",
      { name: /Controller foundation/ },
    );
    await userEvent.click(
      within(row.closest("div")!).getByRole("button", { name: "Thread actions" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: /Snooze · In 1 hour/ }));

    await waitFor(() =>
      expect(codeApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "snooze-code-thread" }),
      ),
    );
    expect(await screen.findByText("This thread is waiting on you.")).toBeVisible();
  });

  it("shelves a snoozed Code thread whose lifecycle still rests on waiting", async () => {
    const base = codes();
    const snoozedThreads = async () => {
      const listed = (await base.bootstrap()).threads[0];
      if (listed === undefined) throw new Error("The Code fixture listed no thread.");
      return [
        decodeCodeThread({
          ...listed,
          lifecycle: "waiting",
          snooze: { until: "2099-01-01T00:00:00.000Z", at: "2026-07-21T12:00:00.000Z" },
        }),
      ];
    };
    render(
      shell({
        ...base,
        bootstrap: vi.fn(async () => ({
          ...(await base.bootstrap()),
          threads: await snoozedThreads(),
        })),
        navigation: vi.fn(async () => ({
          threads: await snoozedThreads(),
          activity: [],
          runtime: [],
        })),
      }),
    );

    const shelf = (await screen.findByText("Snoozed")).closest("details");
    expect(shelf).toHaveAttribute("data-shelf", "snoozed");
    expect(within(shelf!).getByRole("button", { name: /Controller foundation/ })).toBeVisible();
  });

  it("says why the host refused to snooze a Chat thread from its sidebar row", async () => {
    const chatApi: ChatClient = {
      ...chats(),
      execute: vi.fn(async () => {
        throw new ChatClientFailure({
          category: "invalid",
          message: "This thread is waiting on you.",
        });
      }),
    };
    render(chatShell(chatApi));

    // A Chat row carries no inline gutter — it offers neither pinning nor
    // archiving — so its rest commands are reached by right-click, the row's
    // own menu.
    const row = within(await screen.findByRole("navigation", { name: "Projects" })).getByRole(
      "button",
      { name: /Older chat/ },
    );
    await userEvent.pointer({ target: row, keys: "[MouseRight]" });
    await userEvent.hover(await screen.findByRole("menuitem", { name: "Snooze" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));

    await waitFor(() =>
      expect(chatApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "snooze-chat-thread" }),
      ),
    );
    expect(await screen.findByText("This thread is waiting on you.")).toBeVisible();
  });
});
