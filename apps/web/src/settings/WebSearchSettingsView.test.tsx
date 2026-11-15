import type {
  SetWebSearchKeyRequest,
  SetWebSearchSettingsRequest,
  WebSearchSettingsView as WebSearchSettingsViewValue,
} from "@octant/contracts/web-search";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { WebSearchSettingsView } from "./WebSearchSettingsView";

const searxId = "00000000-0000-4000-8000-0000000000b1";
const braveId = "00000000-0000-4000-8000-0000000000b2";
const newId = "00000000-0000-4000-8000-0000000000b3";

function saved(overrides: Partial<WebSearchSettingsViewValue> = {}): WebSearchSettingsViewValue {
  return {
    source: "saved",
    settings: {
      policy: "eu-only",
      backends: [
        {
          id: searxId as never,
          kind: "searxng",
          address: "https://search.example/",
          enabled: true,
          statesZdr: false,
          statesEuProcessing: true,
        },
        {
          id: braveId as never,
          kind: "brave",
          credentialRef: "00000000-0000-4000-8000-0000000000c2",
          enabled: true,
          statesZdr: true,
          statesEuProcessing: false,
        },
      ],
    },
    states: [
      { id: searxId as never, state: { kind: "ready" } },
      {
        id: braveId as never,
        state: { kind: "not-eligible", reason: "eu-processing-not-stated" },
      },
    ],
    ...overrides,
  };
}

function client(view: WebSearchSettingsViewValue = saved()) {
  return {
    readWebSearch: vi.fn(async () => view),
    setWebSearch: vi.fn(async (request: SetWebSearchSettingsRequest) => ({
      kind: "saved" as const,
      view: { ...view, settings: request.settings, states: [] },
    })),
    setWebSearchKey: vi.fn(async (_request: SetWebSearchKeyRequest) => ({
      kind: "saved" as const,
      view,
    })),
  };
}

describe("Settings › Web search", () => {
  it("shows the policy and each backend's state as the host reports it, in the person's order", async () => {
    render(<WebSearchSettingsView client={client()} />);
    expect(await screen.findByRole("combobox", { name: "Data policy" })).toHaveTextContent(
      "EU only",
    );
    const searx = screen.getByRole("group", { name: "1. SearXNG setting" });
    expect(searx).toHaveTextContent("Ready");
    const brave = screen.getByRole("group", { name: "2. Brave Search setting" });
    expect(brave).toHaveTextContent(
      "Not eligible under this policy: you have not stated it processes in the EU or UK",
    );
    expect(screen.getByText(/No provider's own search runs/)).toBeVisible();
  });

  it("offers only the statements a vendor's terms support, and says why the others are not", async () => {
    const user = userEvent.setup();
    render(<WebSearchSettingsView client={client()} />);
    const brave = await screen.findByRole("group", { name: "2. Brave Search setting" });
    await user.click(brave.querySelector("button[aria-expanded]") as HTMLElement);
    // The statement's own label names it, so the terms and the reason a
    // statement is not offered are read with the checkbox.
    expect(
      within(brave).getByRole("checkbox", {
        name: "This vendor processes my queries only in the EU or UK — not offered: Not offered",
      }),
    ).toBeDisabled();
    expect(
      within(brave).getByRole("checkbox", {
        name: /^This vendor keeps no record of my queries \(.+\)$/,
      }),
    ).toBeEnabled();
  });

  it("adds a backend and saves the whole list and policy in one change", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<WebSearchSettingsView client={host} newId={() => newId} />);
    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "Backend kind" }),
      "Mojeek",
    );
    expect(screen.queryByRole("textbox", { name: "Backend address" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("group", { name: "3. Mojeek setting" })).toHaveTextContent("Not saved");
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Data policy" }),
      "EU and ZDR",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(host.setWebSearch).toHaveBeenCalledOnce());
    const request = host.setWebSearch.mock.calls[0]?.[0];
    expect(request?.settings.policy).toBe("eu-and-zdr");
    expect(request?.settings.backends.map((entry) => entry.kind)).toEqual([
      "searxng",
      "brave",
      "mojeek",
    ]);
    expect(await screen.findByText("Web search saved.")).toBeVisible();
  });

  it("moves a backend ahead of another before saving", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<WebSearchSettingsView client={host} />);
    const brave = await screen.findByRole("group", { name: "2. Brave Search setting" });
    await user.click(brave.querySelector("button[aria-expanded]") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Move 2. Brave Search up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        host.setWebSearch.mock.calls[0]?.[0].settings.backends.map((entry) => entry.kind),
      ).toEqual(["brave", "searxng"]),
    );
  });

  it("shows the host's refusal as it arrived and keeps the draft", async () => {
    const user = userEvent.setup();
    const host = client();
    host.setWebSearch.mockResolvedValueOnce({
      kind: "refused",
      code: "statement-not-offered",
      message: "Staan has not published terms under which it keeps no record of queries.",
    } as never);
    render(<WebSearchSettingsView client={host} />);
    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "Data policy" }),
      "Any",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Staan has not published terms under which it keeps no record of queries.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeVisible();
  });

  it("names each entry's controls by position when two entries share a kind", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<WebSearchSettingsView client={host} newId={() => newId} />);
    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "Backend kind" }),
      "SearXNG",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Backend address" }),
      "https://other.search.example/",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    const second = screen.getByRole("group", { name: "3. SearXNG setting" });
    await user.click(second.querySelector("button[aria-expanded]") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Remove 3. SearXNG" }));
    expect(screen.queryByRole("group", { name: "3. SearXNG setting" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "1. SearXNG setting" })).toBeVisible();
  });

  it("sends a saved entry's key to the host and never shows it back", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<WebSearchSettingsView client={host} />);
    const brave = await screen.findByRole("group", { name: "2. Brave Search setting" });
    await user.click(brave.querySelector("button[aria-expanded]") as HTMLElement);
    const key = screen.getByLabelText("2. Brave Search API key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "brave-secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(host.setWebSearchKey).toHaveBeenCalledWith({ entryId: braveId, key: "brave-secret" }),
    );
    expect(screen.getByLabelText("2. Brave Search API key")).toHaveValue("");
  });

  it("asks for a new entry's key only once the list holding it is saved", async () => {
    const user = userEvent.setup();
    render(<WebSearchSettingsView client={client()} newId={() => newId} />);
    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "Backend kind" }),
      "Exa",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    const exa = screen.getByRole("group", { name: "3. Exa setting" });
    await user.click(exa.querySelector("button[aria-expanded]") as HTMLElement);
    expect(screen.getByLabelText("3. Exa API key")).toBeDisabled();
  });

  it("says where web search is set when this window has no host to ask", () => {
    render(<WebSearchSettingsView />);
    expect(screen.getByText("Web search is set on the host this window runs on.")).toBeVisible();
  });
});
