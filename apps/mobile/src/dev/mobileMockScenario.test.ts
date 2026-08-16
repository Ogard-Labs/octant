import { describe, expect, it } from "vitest";
import { decodeCodeDeliveryTarget } from "@octant/contracts";
import {
  createMobileChatWithFirstTurn,
  createMobileCodeFromPrompt,
  createMobileWorkFromPrompt,
  fetchMobileCodeProjects,
  fetchMobileWorkProjects,
  loadMobileChatThread,
} from "@octant/client-runtime";
import {
  createMobileMockScenario,
  resolveMobileMockScenario,
  type MobileMockScenarioId,
} from "./mobileMockScenario";

describe("mobile mock scenarios", () => {
  it("activates only known scenarios in development", () => {
    expect(resolveMobileMockScenario("full", true)).toBe("full");
    expect(resolveMobileMockScenario("stale", true)).toBe("stale");
    expect(resolveMobileMockScenario("empty", true)).toBe("empty");
    expect(resolveMobileMockScenario("unknown", true)).toBeUndefined();
    expect(resolveMobileMockScenario("full", false)).toBeUndefined();
  });

  it.each<MobileMockScenarioId>(["full", "stale", "empty"])(
    "builds isolated deterministic %s data without external origins",
    (scenarioId) => {
      const first = createMobileMockScenario(scenarioId);
      const second = createMobileMockScenario(scenarioId);

      expect({ id: first.id, hosts: first.hosts, health: first.health }).toEqual({
        id: second.id,
        hosts: second.hosts,
        health: second.health,
      });
      expect(first.hosts.every((host) => host.origin.endsWith(".invalid"))).toBe(true);
      expect(first.transports.every((transport) => transport.hostId.length > 0)).toBe(true);
      expect(JSON.stringify(first)).not.toContain("privateKey");
      expect(JSON.stringify(first)).not.toContain("ticketProof");
    },
  );

  it("serves populated host-owned views through the real mobile transport paths", async () => {
    const scenario = createMobileMockScenario("full");
    const transport = scenario.transports[0]!;

    const chat = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/chat/bootstrap",
    });
    const code = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/code/bootstrap",
    });

    await expect(chat.json()).resolves.toMatchObject({ threads: expect.any(Array) });
    await expect(code.json()).resolves.toMatchObject({ threads: expect.any(Array) });
  });

  it("keeps mock Chat creations distinct and persists submitted turns", async () => {
    const scenario = createMobileMockScenario("full");
    const transport = scenario.transports[0]!;

    const first = await createMobileChatWithFirstTurn({
      transport,
      prompt: "First mock turn",
    });
    const second = await createMobileChatWithFirstTurn({
      transport,
      prompt: "Second mock turn",
    });

    expect(first.threadId).not.toBe(second.threadId);
    await expect(loadMobileChatThread(transport, first.threadId)).resolves.toMatchObject({
      thread: { id: first.threadId },
      contents: expect.arrayContaining([
        expect.objectContaining({ role: "user", body: "First mock turn" }),
      ]),
    });
    await expect(loadMobileChatThread(transport, second.threadId)).resolves.toMatchObject({
      thread: { id: second.threadId },
      contents: expect.arrayContaining([
        expect.objectContaining({ role: "user", body: "Second mock turn" }),
      ]),
    });
  });

  it("persists mock Work creation data from the command", async () => {
    const scenario = createMobileMockScenario("full");
    const transport = scenario.transports[0]!;
    const projects = await fetchMobileWorkProjects(transport);

    const row = await createMobileWorkFromPrompt({
      transport,
      prompt: "Prepare release notes",
      projectId: projects[0]!.projectId,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "gpt-5.6",
      bindingRevisionId: projects[0]!.bindingRevisionId,
    });
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/work/threads/bootstrap",
    });

    await expect(response.json()).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({
          id: row.threadId,
          projectId: projects[0]!.projectId,
          title: "Prepare release notes",
        }),
      ]),
    });
  });

  it("launches a repository-backed Code task entirely inside the mock scenario", async () => {
    const scenario = createMobileMockScenario("full");
    const transport = scenario.transports[0]!;
    const projects = await fetchMobileCodeProjects(transport);

    const row = await createMobileCodeFromPrompt({
      transport,
      prompt: "Polish the phone Code flow",
      project: projects[0]!,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "gpt-5.6",
      threadId: "60000000-0000-4000-8000-000000000099",
      confirmDeliveryTarget: async (proposal) =>
        decodeCodeDeliveryTarget({
          branchIntent: proposal.branchIntent,
          remoteName: proposal.remoteName,
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: proposal.proposedBaseBranch,
          outcomeKind: proposal.suggestedOutcomeKind,
          confirmedAt: "2026-08-10T09:30:00.000Z",
        }),
      uuid: (() => {
        const ids = [
          "81000000-0000-4000-8000-000000000001",
          "82000000-0000-4000-8000-000000000001",
        ];
        return () => ids.shift()!;
      })(),
    });

    expect(row).toMatchObject({
      mode: "code",
      title: "Polish the phone Code flow",
      threadId: "60000000-0000-4000-8000-000000000099",
    });
  });
});
