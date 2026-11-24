import {
  decodePersonMemoryView,
  type PersonMemoryResult,
  type PersonMemoryView,
} from "@octant/contracts/person-memory";
import type { ThreadTitleSettings } from "@octant/contracts/shell";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { AutomaticModelSettings } from "./AutomaticModelSettings";

const LOCAL = "00000000-0000-4000-8000-0000000000a1";
const KEYED = "00000000-0000-4000-8000-0000000000a2";
const OFF = "00000000-0000-4000-8000-0000000000a3";
const PLAN = "00000000-0000-4000-8000-0000000000a4";

const snapshot = {
  instances: [
    { id: LOCAL, displayName: "Local", enabled: true },
    {
      id: KEYED,
      displayName: "Team key",
      enabled: true,
      driverKind: "openai-compatible",
      configuration: { authentication: "bearer" },
    },
    { id: OFF, displayName: "Old account", enabled: false },
    {
      id: PLAN,
      displayName: "ChatGPT plan",
      enabled: true,
      driverKind: "openai-compatible",
      configuration: { authentication: "bearer", oauthDescriptorId: "chatgpt-plan" },
    },
  ],
  observedStates: [
    { instanceId: LOCAL, readiness: "ready" },
    { instanceId: KEYED, readiness: "ready", accountAuthentication: "api-key" },
    { instanceId: PLAN, readiness: "ready", accountAuthentication: "subscription" },
  ],
  catalogs: [
    { instanceId: LOCAL, models: [{ id: "local-small", displayName: "Local small" }] },
    { instanceId: KEYED, models: [{ id: "key-mini", displayName: "Key mini" }] },
    { instanceId: PLAN, models: [{ id: "plan-mini", displayName: "Plan mini" }] },
  ],
} as never;

const codeSettings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  requireGitRepository: true,
  version: 1,
  updatedAt: "2026-11-01T12:00:00.000Z",
} as never;

function memoryView(settings: Record<string, unknown> = {}): PersonMemoryView {
  return decodePersonMemoryView({
    kind: "person-memory",
    settings: { enabled: true, pastThreadSearch: true, excludedProjectIds: [], ...settings },
    version: 3,
    entries: [],
    rememberedThreads: 0,
    untracedThreads: [],
  });
}

function fakeMemory(initial: PersonMemoryView) {
  const change = vi.fn(
    async (command: { settings: Record<string, unknown> }): Promise<PersonMemoryResult> =>
      memoryView(command.settings),
  );
  return { change, client: { read: vi.fn(async () => initial), change } as never };
}

describe("Automatic model calls", () => {
  it("switches between API and subscription titles without losing either model choice", async () => {
    function Settings() {
      const [settings, setSettings] = useState<ThreadTitleSettings>();
      return (
        <AutomaticModelSettings
          codeSettings={undefined}
          onCodeUpdate={vi.fn()}
          onThreadTitlesChange={setSettings}
          personMemoryClient={undefined}
          providerSnapshot={snapshot}
          threadTitles={settings}
        />
      );
    }
    render(<Settings />);
    const user = userEvent.setup();
    const source = screen.getByRole("combobox", { name: "Thread title source" });
    expect(source).toHaveTextContent("Use first message");
    await chooseSelectFieldOption(user, source, "API endpoint");
    const api = screen.getByRole("combobox", { name: "API endpoint model" });
    await user.click(api);
    expect(screen.queryByRole("option", { name: "ChatGPT plan · Plan mini" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "Team key (API key) · Key mini" }));
    expect(screen.getByText(/first message to Team key/)).toBeVisible();
    await chooseSelectFieldOption(user, source, "Subscription");
    const subscription = screen.getByRole("combobox", { name: "Subscription model" });
    await user.click(subscription);
    expect(screen.queryByRole("option", { name: "Team key (API key) · Key mini" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "ChatGPT plan · Plan mini" }));
    expect(screen.getByText(/first message to ChatGPT plan/)).toBeVisible();
    await chooseSelectFieldOption(user, source, "API endpoint");
    expect(screen.getByRole("combobox", { name: "API endpoint model" })).toHaveTextContent(
      "Key mini",
    );
    await chooseSelectFieldOption(user, source, "Use first message");
    expect(screen.queryByRole("combobox", { name: "API endpoint model" })).toBeNull();
    await chooseSelectFieldOption(user, source, "Subscription");
    expect(screen.getByRole("combobox", { name: "Subscription model" })).toHaveTextContent(
      "Plan mini",
    );
  });

  it("opens endpoint setup when the remembered title endpoint was removed", async () => {
    const open = vi.fn();
    render(
      <AutomaticModelSettings
        codeSettings={undefined}
        onCodeUpdate={vi.fn()}
        personMemoryClient={undefined}
        onThreadTitlesChange={vi.fn()}
        onOpenModelEndpoints={open}
        providerSnapshot={{ instances: [], catalogs: [], observedStates: [] } as never}
        threadTitles={{
          source: "subscription",
          subscriptionModel: {
            providerInstanceId: decodeProviderInstanceId(PLAN),
            modelId: decodeProviderModelId("plan-mini"),
          },
        }}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Model endpoints" }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByText(/the account you chose was removed/i)).toBeVisible();
  });

  it("shows a failed title-model save and keeps the saved choice", async () => {
    render(
      <AutomaticModelSettings
        codeSettings={undefined}
        onCodeUpdate={vi.fn()}
        onThreadTitlesChange={vi.fn(async () => false)}
        personMemoryClient={undefined}
        providerSnapshot={snapshot}
      />,
    );
    const field = screen.getByRole("combobox", { name: "Thread title source" });
    await chooseSelectFieldOption(userEvent.setup(), field, "API endpoint");
    expect(await screen.findByText("Thread title settings could not be saved.")).toBeVisible();
    expect(field).toHaveTextContent("Use first message");
  });

  it("offers the thread's provider, then each enabled account, an API-key one marked, and none that is off", async () => {
    const { client } = fakeMemory(memoryView());
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const judge = screen.getByRole("combobox", { name: "Model for Octant Shield's Judge" });
    expect(judge).toHaveTextContent("The thread's provider, smallest model");
    await userEvent.setup().click(judge);
    expect(
      await screen.findByRole("option", { name: "Team key (API key) · Key mini" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Local · Local small" })).toBeVisible();
    expect(screen.queryByText(/Old account/)).toBeNull();
  });

  it("saves the Judge's account through Code settings and returns it to the thread's provider", async () => {
    const update = vi.fn(async () => true);
    const { client } = fakeMemory(memoryView());
    const { rerender } = render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={update}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const user = userEvent.setup();
    const judge = screen.getByRole("combobox", { name: "Model for Octant Shield's Judge" });
    await chooseSelectFieldOption(user, judge, "Local · Local small");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        shieldModel: { providerInstanceId: LOCAL, modelId: "local-small" },
      }),
    );
    rerender(
      <AutomaticModelSettings
        codeSettings={
          {
            ...(codeSettings as object),
            shieldModel: { providerInstanceId: LOCAL, modelId: "local-small" },
          } as never
        }
        onCodeUpdate={update}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    await chooseSelectFieldOption(user, judge, "The thread's provider, smallest model");
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ shieldModel: null }));
  });

  it("shows the stored choice again when the Judge's choice is not saved", async () => {
    const { client } = fakeMemory(memoryView());
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => false)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const judge = screen.getByRole("combobox", { name: "Model for Octant Shield's Judge" });
    await chooseSelectFieldOption(userEvent.setup(), judge, "Local · Local small");
    await vi.waitFor(() =>
      expect(judge).toHaveTextContent("The thread's provider, smallest model"),
    );
    expect(await screen.findByText("The Judge's model could not be saved.")).toBeVisible();
  });

  it("saves memory's account in memory's own settings and keeps its other switches", async () => {
    const { client, change } = fakeMemory(memoryView({ pastThreadSearch: false }));
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const field = await screen.findByRole("combobox", { name: "Model for memory distilling" });
    await vi.waitFor(() => expect(field).toBeEnabled());
    await chooseSelectFieldOption(userEvent.setup(), field, "Team key (API key) · Key mini");
    expect(change).toHaveBeenCalledWith({
      kind: "change-person-memory-settings",
      expectedVersion: 3,
      settings: {
        enabled: true,
        pastThreadSearch: false,
        excludedProjectIds: [],
        distillModel: { providerInstanceId: KEYED, modelId: "key-mini" },
      },
    });
  });

  it("says in plain words where each job's content goes, and that nothing switches accounts by itself", async () => {
    const { client } = fakeMemory(
      memoryView({ distillModel: { providerInstanceId: KEYED, modelId: "key-mini" } }),
    );
    render(
      <AutomaticModelSettings
        codeSettings={
          {
            ...(codeSettings as object),
            shieldModel: { providerInstanceId: LOCAL, modelId: "local-small" },
          } as never
        }
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    expect(await screen.findByText(/It goes to Team key\./)).toBeVisible();
    expect(screen.getByText(/It goes to Local\./)).toBeVisible();
    expect(screen.getByText(/never moves a job to another account by itself/)).toBeVisible();
  });

  it("says what happens while the chosen account is off", async () => {
    const { client } = fakeMemory(
      memoryView({ distillModel: { providerInstanceId: OFF, modelId: "old" } }),
    );
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    expect(
      await screen.findByText(
        "Old account is turned off. Until it is back, memory waits and tries again later.",
      ),
    ).toBeVisible();
  });

  it("starts the second opinion off, says what it reads, and saves an account in memory's settings", async () => {
    const { client, change } = fakeMemory(memoryView({ pastThreadSearch: false }));
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const field = await screen.findByRole("combobox", {
      name: "Model for second opinions on decisions",
    });
    await vi.waitFor(() => expect(field).toBeEnabled());
    expect(field).toHaveTextContent("Off");
    expect(screen.getByText(/at most 3,000 characters/)).toBeVisible();
    expect(screen.getByText(/While it is off, nothing is sent\./)).toBeVisible();
    await chooseSelectFieldOption(userEvent.setup(), field, "Team key (API key) · Key mini");
    expect(change).toHaveBeenCalledWith({
      kind: "change-person-memory-settings",
      expectedVersion: 3,
      settings: {
        enabled: true,
        pastThreadSearch: false,
        excludedProjectIds: [],
        decisionReviewModel: { providerInstanceId: KEYED, modelId: "key-mini" },
      },
    });
  });

  it("returns the second opinion to off without touching memory's own model", async () => {
    const { client, change } = fakeMemory(
      memoryView({
        distillModel: { providerInstanceId: LOCAL, modelId: "local-small" },
        decisionReviewModel: { providerInstanceId: KEYED, modelId: "key-mini" },
      }),
    );
    render(
      <AutomaticModelSettings
        codeSettings={codeSettings}
        onCodeUpdate={vi.fn(async () => true)}
        personMemoryClient={client}
        providerSnapshot={snapshot}
      />,
    );
    const field = await screen.findByRole("combobox", {
      name: "Model for second opinions on decisions",
    });
    await vi.waitFor(() => expect(field).toBeEnabled());
    await chooseSelectFieldOption(userEvent.setup(), field, "Off");
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          distillModel: { providerInstanceId: LOCAL, modelId: "local-small" },
        }),
      }),
    );
    expect(change.mock.calls[0]?.[0].settings).not.toHaveProperty("decisionReviewModel");
  });
});
