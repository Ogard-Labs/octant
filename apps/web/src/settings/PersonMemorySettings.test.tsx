import {
  decodePersonMemoryView,
  type PersonMemoryResult,
  type PersonMemoryView,
} from "@octant/contracts/person-memory";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PERSON_MEMORY_FACT,
  PERSON_MEMORY_PROVIDER_NOTE,
  PersonMemorySettings,
} from "./PersonMemorySettings";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENTRY = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

function view(overrides: Readonly<Record<string, unknown>> = {}): PersonMemoryView {
  return decodePersonMemoryView({
    kind: "person-memory",
    settings: { enabled: true, pastThreadSearch: true, excludedProjectIds: [] },
    version: 1,
    entries: [
      {
        id: ENTRY,
        kind: "preference",
        content: "Prefers CSV over spreadsheets.",
        sources: [
          {
            mode: "work",
            threadId: "bbbbbbbb-0000-4000-8000-000000000001",
            title: "Invoices",
            projectId: PROJECT,
            providerInstanceId: "33333333-3333-4333-8333-333333333333",
            endedAt: "2026-11-01T10:00:00.000Z",
          },
        ],
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ],
    rememberedThreads: 1,
    untracedThreads: [],
    ...overrides,
  });
}

function fakeClient(initial: PersonMemoryView) {
  const change = vi.fn(async (): Promise<PersonMemoryResult> => view({ entries: [] }));
  return { change, client: { read: vi.fn(async () => initial), change } };
}

const projectNames = new Map([[PROJECT, "Shop"]]);

describe("PersonMemorySettings", () => {
  it("shows each memory with where it came from and says it crosses providers", async () => {
    const { client } = fakeClient(view());
    render(<PersonMemorySettings client={client} projectNames={projectNames} />);
    expect(await screen.findByText("Prefers CSV over spreadsheets.")).toBeVisible();
    expect(screen.getByText(/From “Invoices” \(Work, Shop, 2026-11-01\)/)).toBeVisible();
    expect(screen.getByText(PERSON_MEMORY_FACT)).toBeVisible();
    expect(screen.getByText(PERSON_MEMORY_PROVIDER_NOTE)).toBeVisible();
  });

  it("deletes one memory by its id", async () => {
    const user = userEvent.setup();
    const { client, change } = fakeClient(view());
    render(<PersonMemorySettings client={client} projectNames={projectNames} />);
    const row = (await screen.findByText("Prefers CSV over spreadsheets.")).closest(
      "[data-setting-id]",
    );
    if (!(row instanceof HTMLElement)) throw new Error("expected the memory's row");
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(change).toHaveBeenCalledWith({ kind: "delete-person-memory-entry", entryId: ENTRY });
  });

  it("asks before forgetting everything", async () => {
    const user = userEvent.setup();
    const { client, change } = fakeClient(view());
    render(<PersonMemorySettings client={client} projectNames={projectNames} />);
    await user.click(await screen.findByRole("button", { name: "Forget everything" }));
    expect(change).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Forget everything" }),
    );
    expect(change).toHaveBeenCalledWith({ kind: "forget-person-memory", confirmed: true });
  });

  it("turns memory off with the version it read", async () => {
    const user = userEvent.setup();
    const { client, change } = fakeClient(view());
    render(<PersonMemorySettings client={client} projectNames={projectNames} />);
    await user.click(await screen.findByRole("switch", { name: "Remember across threads" }));
    expect(change).toHaveBeenCalledWith({
      kind: "change-person-memory-settings",
      expectedVersion: 1,
      settings: { enabled: false, pastThreadSearch: true, excludedProjectIds: [] },
    });
  });

  it("says memory lives on the host where no client reaches it", () => {
    render(<PersonMemorySettings client={undefined} projectNames={projectNames} />);
    expect(screen.getByText("Memory is shown on the host machine only.")).toBeVisible();
  });
});
