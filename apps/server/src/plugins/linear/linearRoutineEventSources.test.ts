import { describe, expect, it, vi } from "vitest";
import type { AutomationIntegrationEventTrigger } from "@octant/contracts";
import { createMemorySecretVault } from "../../integration/integrationCredentialVault";
import {
  computeLinearAccountRef,
  createMemoryLinearAccountIndexStore,
} from "../../integration/linearAccountIndexStore";
import { createLinearIntegrationService } from "../../integration/integrationService";
import { linearRoutineEventSources } from "./linearRoutineEventSources";

const REDIRECT_URI = "http://127.0.0.1:52693/oauth/linear/callback";
const CLIENT_ID = "linear-public-client";

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

  it("offers one choice per connected account, preserves legacy routine identity, and isolates sign-out of B from A", async () => {
    const tokenA = "token_routine_a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const tokenB = "token_routine_b_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const seenTokens: string[] = [];

    const fetch = vi.fn(async (input: Request) => {
      if (input.url === "https://api.linear.app/oauth/revoke") {
        return new Response(null, { status: 200 });
      }
      if (input.url === "https://api.linear.app/graphql") {
        const auth = input.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
        seenTokens.push(token);
        const body = JSON.parse(await input.text()) as { readonly query: string };
        const isA = token === tokenA;
        if (!isA && token !== tokenB)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const viewer = isA
          ? {
              id: "viewer-a",
              name: "Ada A",
              organization: { id: "org-a", name: "Personal", urlKey: "personal" },
            }
          : {
              id: "viewer-b",
              name: "Ada B",
              organization: { id: "org-b", name: "Company", urlKey: "company" },
            };
        if (body.query.includes("RoutineAssignments")) {
          return Response.json({
            data: {
              viewer,
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: isA ? "issue-a-1" : "issue-b-1",
                    identifier: "ENG-1",
                    title: isA ? "Personal assignment" : "Company assignment",
                    url: `https://linear.app/${viewer.organization.urlKey}/issue/ENG-1`,
                    updatedAt: "2026-11-28T10:00:00.000Z",
                  },
                ],
              },
            },
          });
        }
        if (body.query.includes("IssueFilters")) {
          return Response.json({
            data: {
              teams: {
                nodes: [{ id: isA ? "team-a" : "team-b", name: "Engineering", key: "ENG" }],
              },
              users: { nodes: [] },
              workflowStates: { nodes: [] },
              projects: { nodes: [] },
            },
          });
        }
        return Response.json({ data: { viewer } });
      }
      return new Response(null, { status: 500 });
    });

    const service = createLinearIntegrationService({
      vault: createMemorySecretVault(),
      accountIndexStore: createMemoryLinearAccountIndexStore(),
      config: { clientId: CLIENT_ID, redirectUri: REDIRECT_URI },
      fetch,
      startCallbackListener: false,
    });
    expect(await service.putSecret("linear", "personal-api-key", tokenA)).toEqual({
      kind: "stored",
    });
    expect(await service.putSecret("linear", "personal-api-key", tokenB)).toEqual({
      kind: "stored",
    });

    const refA = computeLinearAccountRef("viewer-a", "org-a");
    const refB = computeLinearAccountRef("viewer-b", "org-b");
    const provider = linearRoutineEventSources(service, () => true);

    const choices = await provider.choices();
    expect(choices.map((choice) => choice.sourceId)).toEqual([
      `assigned-to-me:${refA}`,
      `assigned-to-me:${refB}`,
    ]);
    expect(choices.map((choice) => choice.label)).toEqual([
      "Linear assignments (Personal)",
      "Linear assignments (Company)",
    ]);

    const sourceA = await provider.bind(
      {
        kind: "integration-event",
        integrationId: "linear",
        sourceId: `assigned-to-me:${refA}`,
        filters: { team: "ENG" },
        pollMinutes: 1,
        automaticStartLimit: 8,
      },
      new AbortController().signal,
    );
    const sourceB = await provider.bind(
      {
        kind: "integration-event",
        integrationId: "linear",
        sourceId: `assigned-to-me:${refB}`,
        filters: { team: "ENG" },
        pollMinutes: 1,
        automaticStartLimit: 8,
      },
      new AbortController().signal,
    );
    expect(sourceA).toBeDefined();
    expect(sourceB).toBeDefined();

    // Legacy routine persisted with `sourceId: "assigned-to-me"` and A's stored identity
    // resolves directly to A and never calls B.
    seenTokens.length = 0;
    const legacyRoutine = await provider.bind(
      {
        kind: "integration-event",
        integrationId: "linear",
        sourceId: "assigned-to-me",
        sourceIdentity: sourceA?.identity,
        filters: { team: "ENG" },
        pollMinutes: 1,
        automaticStartLimit: 8,
      },
      new AbortController().signal,
    );
    expect(legacyRoutine?.identity).toBe(sourceA?.identity);
    expect(seenTokens).toEqual([tokenA]);

    // Signing out of account B invalidates B's routine but leaves A's routine running.
    await service.execute(
      "linear",
      { kind: "logout", accountRef: refB },
      new AbortController().signal,
    );
    expect(sourceB?.current()).toBe(false);
    expect(await sourceB?.read(new AbortController().signal)).toEqual({
      kind: "unavailable",
      reason: "source-unavailable",
    });

    expect(sourceA?.current()).toBe(true);
    expect(await sourceA?.read(new AbortController().signal)).toMatchObject({
      kind: "complete",
      events: [{ id: "issue-a-1" }],
    });
    // Subsequent live poll on A also succeeds without interruption.
    expect(await sourceA?.read(new AbortController().signal)).toMatchObject({
      kind: "complete",
      events: [{ id: "issue-a-1" }],
    });

    // Rebinding B's persisted routine after B signed out refuses without ever touching A.
    seenTokens.length = 0;
    expect(
      await provider.bind(
        {
          kind: "integration-event",
          integrationId: "linear",
          sourceId: "assigned-to-me",
          sourceIdentity: sourceB?.identity,
          filters: { team: "ENG" },
          pollMinutes: 1,
          automaticStartLimit: 8,
        },
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(seenTokens).toEqual([]);
  });
});
