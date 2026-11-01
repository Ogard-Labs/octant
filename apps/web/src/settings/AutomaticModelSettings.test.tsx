import {
  decodePersonMemoryView,
  type PersonMemoryResult,
  type PersonMemoryView,
} from "@octant/contracts/person-memory";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { AutomaticModelSettings } from "./AutomaticModelSettings";

const LOCAL = "00000000-0000-4000-8000-0000000000a1";
const KEYED = "00000000-0000-4000-8000-0000000000a2";
const OFF = "00000000-0000-4000-8000-0000000000a3";

const snapshot = {
  instances: [
    { id: LOCAL, displayName: "Local", enabled: true },
    { id: KEYED, displayName: "Team key", enabled: true },
    { id: OFF, displayName: "Old account", enabled: false },
  ],
  observedStates: [
    { instanceId: LOCAL, readiness: "ready" },
    { instanceId: KEYED, readiness: "ready", accountAuthentication: "api-key" },
  ],
  catalogs: [
    { instanceId: LOCAL, models: [{ id: "local-small", displayName: "Local small" }] },
    { instanceId: KEYED, models: [{ id: "key-mini", displayName: "Key mini" }] },
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
});
