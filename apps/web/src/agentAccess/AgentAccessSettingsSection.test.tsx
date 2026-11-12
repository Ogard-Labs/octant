import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import {
  DEFAULT_AGENT_GRANT_LIMITS,
  decodeAgentGrant,
  type AgentAccessCommand,
  type AgentGrantView,
} from "@octant/contracts";
import { SidebarThreadRowContent } from "../projects/SidebarThreadRowContent";
import type { AgentAccessAdministrationBridge } from "../shell/hostBridge";
import { AgentAccessSettingsSection } from "./AgentAccessSettingsSection";
import {
  AgentThreadAttributionProvider,
  AgentTurnSender,
  useAgentTurnSenders,
} from "./agentThreadAttribution";

const grantId = "63000000-0000-4000-8000-000000000001";
const projectId = "63000000-0000-4000-8000-000000000002";
const fingerprint = "a".repeat(64);
const projectNames = new Map([[projectId, "repo"]]);

const grant = decodeAgentGrant({
  grantId,
  scopeId: "63000000-0000-4000-8000-000000000003",
  name: "Home bot",
  scope: {
    projects: [projectId],
    modes: ["code"],
    highestLevel: "ask-first",
    threads: "own",
    tools: ["start_work", "read_thread"],
    limits: DEFAULT_AGENT_GRANT_LIMITS,
    direct: false,
  },
  state: "active",
  generation: 1,
  keys: [],
  createdAt: "2026-11-11T10:00:00.000Z",
  expiresAt: "2026-12-11T10:00:00.000Z",
});

const view: AgentGrantView = {
  grant,
  pendingClaims: [
    { grantId: grant.grantId, fingerprint, label: "laptop", claimedAt: grant.createdAt },
  ],
  directKey: false,
  threadsStarted: 2,
  turnsToday: 3,
};

function administration(answers: (command: AgentAccessCommand) => unknown) {
  const commands: AgentAccessCommand[] = [];
  const bridge: AgentAccessAdministrationBridge = {
    agentAccessRequest: vi.fn(async (request) => {
      if (request.kind === "list") return { status: 200, body: { kind: "grants", grants: [view] } };
      commands.push(request.command);
      return { status: 200, body: answers(request.command) };
    }),
  };
  return { bridge, commands };
}

describe("Settings › Agent access", () => {
  it("lists what a grant allows and confirms a key that claimed its code", async () => {
    const { bridge, commands } = administration(() => ({ kind: "grant", grant: view }));
    render(<AgentAccessSettingsSection administration={bridge} projectNames={projectNames} />);
    expect(
      await screen.findByText(/Code in repo · up to Ask first · only its own threads/),
    ).toBeTruthy();
    expect(screen.getByText(/2 threads started · 3 turns today/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Confirm key" }));
    await waitFor(() => expect(commands).toEqual([{ kind: "confirm-key", grantId, fingerprint }]));
  });

  it("makes a grant, then shows the join command once", async () => {
    const { bridge, commands } = administration((command) =>
      command.kind === "create"
        ? { kind: "grant", grant: view }
        : {
            kind: "ticket",
            connectionCode: "octant-agent-1.abc",
            expiresAt: "2026-11-11T10:05:00.000Z",
          },
    );
    render(<AgentAccessSettingsSection administration={bridge} projectNames={projectNames} />);
    await userEvent.click(await screen.findByRole("button", { name: "New agent grant…" }));
    await userEvent.type(screen.getByLabelText("Name"), "Laptop agent");
    await userEvent.click(screen.getByRole("checkbox", { name: "repo" }));
    await userEvent.click(screen.getByRole("button", { name: "Make grant" }));
    expect(
      await screen.findByDisplayValue("octant agent-access join octant-agent-1.abc"),
    ).toBeTruthy();
    expect(commands.map((command) => command.kind)).toEqual(["create", "issue-ticket"]);
    expect(commands[0]).toMatchObject({
      draft: {
        name: "Laptop agent",
        days: 30,
        scope: { projects: [projectId], highestLevel: "ask-first" },
      },
    });
  });

  it("lets a paired device revoke a grant and stop its turns, and offers nothing else", async () => {
    const revoke = vi.fn(async () => ({ kind: "done" as const }));
    const client: AgentGrantClient = {
      grants: async () => ({ kind: "grants", grants: [view] }),
      threads: async () => ({ threads: [] }),
      revoke,
    };
    render(<AgentAccessSettingsSection client={client} projectNames={projectNames} />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Home bot" }));
    expect(screen.queryByRole("button", { name: "New agent grant…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm key" })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Also stop its running turns" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith({ grantId, stopRunningTurns: true }));
  });
});

describe("Started by", () => {
  it("names the outside agent on the sidebar row of a thread it started, and nothing on others", async () => {
    const client: AgentGrantClient = {
      grants: async () => ({ kind: "grants", grants: [] }),
      revoke: async () => ({ kind: "done" }),
      threads: async () => ({
        threads: [
          { threadId: "t-agent", grantId: view.grant.grantId, agentName: "Home bot", mode: "code" },
        ],
      }),
    };
    render(
      <AgentThreadAttributionProvider client={client}>
        <SidebarThreadRowContent threadId="t-agent" title="Fix the failing test" />
        <SidebarThreadRowContent threadId="t-mine" title="My own thread" />
      </AgentThreadAttributionProvider>,
    );
    expect(await screen.findByText("Started by Home bot")).toBeTruthy();
    expect(screen.getAllByText(/Started by/)).toHaveLength(1);
  });
});

describe("Sent by", () => {
  function Prompt(props: { readonly threadId: string; readonly turnKey: string }) {
    const sender = useAgentTurnSenders(props.threadId);
    return <AgentTurnSender agentName={sender(props.turnKey)} />;
  }

  it("names the outside agent under each turn it sent, by the id the turn keeps, and nothing under others", async () => {
    const agentTurn = "64000000-0000-4000-8000-000000000001";
    const personTurn = "64000000-0000-4000-8000-000000000002";
    const client: AgentGrantClient = {
      grants: async () => ({ kind: "grants", grants: [] }),
      revoke: async () => ({ kind: "done" }),
      threads: async () => ({
        threads: [],
        turns: [{ threadId: "t-project", turnKey: agentTurn, agentName: "Home bot" }],
      }),
    };
    render(
      <AgentThreadAttributionProvider client={client}>
        <Prompt threadId="t-project" turnKey={agentTurn} />
        <Prompt threadId="t-project" turnKey={personTurn} />
        <Prompt threadId="t-other" turnKey={agentTurn} />
      </AgentThreadAttributionProvider>,
    );
    expect(await screen.findByText("Sent by Home bot")).toBeTruthy();
    expect(screen.getAllByText(/Sent by/)).toHaveLength(1);
  });
});
