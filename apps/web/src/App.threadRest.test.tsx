import { decodeCodeThread } from "@octant/contracts";
import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  chatShellBootstrap,
  chats,
  client,
  codeShellBootstrap,
  codeThreadId,
  codes,
  openSidebarProject,
  projectConversationCodes,
  projectWindowCapability,
  projects,
  providers,
  providersWithToolModel,
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
  function shell(codeClient: CodeClient, providerClient = providers()) {
    return (
      <App
        chatClient={chats()}
        codeClient={codeClient}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providerClient}
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

  it("snoozes the Code thread in front from the command palette", async () => {
    const codeApi: CodeClient = {
      ...codes(),
      execute: vi.fn(async () => {
        throw { category: "invalid", message: "This thread is waiting on you." };
      }),
    };
    render(shell(codeApi));

    const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
    await userEvent.click(
      within(projectsNav).getByRole("button", { name: /Controller foundation/ }),
    );
    await waitFor(() =>
      expect(
        within(projectsNav).getByRole("button", { name: /Controller foundation/ }),
      ).toHaveAttribute("aria-current", "page"),
    );
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(await screen.findByRole("option", { name: /^Snooze · In 1 hour/ }));

    await waitFor(() =>
      expect(codeApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "snooze-code-thread" }),
      ),
    );
    expect(await screen.findByText("This thread is waiting on you.")).toBeVisible();
  });

  it("offers commands for the open Project worker when its sidebar row is hidden", async () => {
    const codeApi = await projectConversationCodes();
    const user = userEvent.setup();
    render(shell(codeApi, providersWithToolModel()));

    const sidebar = await screen.findByRole("navigation", { name: "Projects" });
    expect(
      within(sidebar).queryByRole("button", { name: /Fix updater retries/ }),
    ).not.toBeInTheDocument();
    await openSidebarProject(user, "Octant");
    const report = await screen.findByRole("region", { name: "Project report" });
    await user.click(
      within(report).getByRole("button", { name: "Open Fix updater retries beside the Project" }),
    );
    const worker = await screen.findByRole("region", {
      name: "Workspace pane: Fix updater retries",
    });
    await user.click(within(worker).getByRole("textbox", { name: "Follow-up message" }));
    await user.keyboard("{Control>}k{/Control}");
    const pin = await screen.findByRole("option", { name: /^Pin.*Fix updater retries/ });
    expect(screen.getByRole("option", { name: /^Settle.*Fix updater retries/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /^Snooze · In 1 hour/ })).toBeVisible();
    await user.click(pin);
    await waitFor(() =>
      expect(codeApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "pin-code-thread", threadId: codeThreadId, pinned: true }),
      ),
    );
  });

  it("offers no thread commands while a new thread is being drafted", async () => {
    render(shell(codes()));

    await screen.findByRole("navigation", { name: "Projects" });
    await userEvent.keyboard("{Control>}n{/Control}");
    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findByRole("combobox", { name: "Search commands" });

    expect(screen.getByRole("option", { name: /^New Code thread/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /^Snooze · / })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Settle/ })).not.toBeInTheDocument();
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

    // The new-thread composer loads on demand and takes focus when it mounts.
    // Under CPU load that landed after the row's menu opened, moved focus out
    // of it and closed it, so Enter never reached Tomorrow (2 of 10 runs).
    // Let the composer settle first.
    await act(() => vi.dynamicImportSettled());
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "First message" })).toHaveFocus(),
    );

    // A Chat row carries no inline gutter — it offers neither pinning nor
    // archiving — so its rest commands are reached by right-click, the row's
    // own menu.
    const row = within(await screen.findByRole("navigation", { name: "Projects" })).getByRole(
      "button",
      { name: /Older chat/ },
    );
    await userEvent.pointer({ target: row, keys: "[MouseRight]" });
    const snooze = await screen.findByRole("menuitem", { name: "Snooze" });
    act(() => snooze.focus());
    await userEvent.keyboard("{ArrowRight}");
    const tomorrow = await screen.findByRole("menuitem", { name: /^Tomorrow/ });
    act(() => tomorrow.focus());
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(chatApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "snooze-chat-thread" }),
      ),
    );
    expect(await screen.findByText("This thread is waiting on you.")).toBeVisible();
  });
});
