import { describe, expect, it, vi } from "vitest";
import type { AutomationIntegrationEventTrigger } from "@octant/contracts";
import { linearRoutineEventSources } from "./linearRoutineEventSources";

describe("Linear assignment source ownership", () => {
  it("retains the selected account and refuses a changed connection or workspace", async () => {
    let revision = 0;
    let account = "viewer-1:workspace-1";
    const service = {
      connectionRevision: () => revision,
      snapshot: async () => ({
        state: "ready" as const,
        capabilities: [],
        account: { login: "Workspace", source: "oauth", scopes: ["read"] },
      }),
      executeOperation: vi.fn(async () => ({
        kind: "ok" as const,
        value: { identity: account, label: "My assignments", events: [] },
      })),
    };
    const provider = linearRoutineEventSources(service, () => true);
    const selection: AutomationIntegrationEventTrigger = {
      kind: "integration-event",
      integrationId: "linear",
      sourceId: "assigned-to-me",
      filters: { team: "ENG" },
      pollMinutes: 1,
      automaticStartLimit: 8,
    };
    const source = await provider.bind(selection, new AbortController().signal);
    expect(source?.current()).toBe(true);
    expect(await source?.read(new AbortController().signal)).toEqual({
      kind: "complete",
      events: [],
    });
    revision += 1;
    expect(source?.current()).toBe(false);
    expect(await source?.read(new AbortController().signal)).toMatchObject({ kind: "unavailable" });
    account = "viewer-2:workspace-2";
    expect(
      await provider.bind(
        { ...selection, sourceIdentity: source?.identity },
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });
});
