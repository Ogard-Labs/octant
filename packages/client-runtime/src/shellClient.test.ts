import {
  decodeShellBootstrap,
  decodeShellCommand,
  decodeShellCommandResult,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createShellClient, ShellClientFailure } from "./shellClient";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000501");
const settings = {
  chatEnabled: true,
  workEnabled: true,
  sidebarWidth: 280,
  contextSidebarWidth: 360,
  lastContextSurface: "code-environment" as const,
  sidebarMaterial: "system" as const,
  modeSwitcherPresentation: "buttons" as const,
};
const bootstrap = decodeShellBootstrap({
  settings,
  workspace: {
    windowId,
    activeMode: "code",
    layouts: {
      chat: group("00000000-0000-4000-8000-000000000511", "chat"),
      work: group("00000000-0000-4000-8000-000000000521", "work"),
      code: group("00000000-0000-4000-8000-000000000531", "code"),
    },
    activeGroupIds: {
      chat: "00000000-0000-4000-8000-000000000511",
      work: "00000000-0000-4000-8000-000000000521",
      code: "00000000-0000-4000-8000-000000000531",
    },
    contextByMode: {
      chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
      work: { host: "local", mode: "work", projectId: null, boundRoot: null },
      code: { host: "local", mode: "code", projectId: null, boundRoot: null },
    },
    version: 0,
  },
  availableSurfaces: {
    chat: [
      { kind: "thread", label: "Thread", available: true },
      { kind: "side-chat", label: "Side Chat", available: true },
    ],
    work: [
      { kind: "thread", label: "Thread", available: true },
      { kind: "side-chat", label: "Side Chat", available: true },
    ],
    code: [
      { kind: "thread", label: "Thread", available: true },
      { kind: "side-chat", label: "Side Chat", available: true },
    ],
  },
  connectionStatus: "connected",
  environmentPresentation: {
    byTab: [],
    byMode: { chat: "hidden", work: "floating", code: "pinned" },
  },
  settingsVersion: 0,
  workspaceVersion: 0,
  presentationVersion: 0,
});
const command = decodeShellCommand({
  kind: "replace-settings",
  windowId,
  expectedVersion: 0,
  settings,
});
const commandResult = decodeShellCommandResult({
  kind: "settings-replaced",
  settings,
  version: 1,
});

describe("shell client", () => {
  it("constructs the bootstrap URL and decodes a successful response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(bootstrap));
    const client = createShellClient({ baseUrl: "http://127.0.0.1:13773/", fetch });

    await expect(client.bootstrap(windowId)).resolves.toEqual(bootstrap);
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:13773/api/shell/bootstrap?windowId=${windowId}`,
      { method: "GET" },
    );
  });

  it("posts the encoded command body and decodes a successful response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(commandResult));
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    await expect(client.execute(command)).resolves.toEqual(commandResult);
    expect(fetch).toHaveBeenCalledWith("http://localhost:13773/api/shell/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  });

  it("posts one strict atomic dock-tab command without transport decomposition", async () => {
    const dockCommand = decodeShellCommand({
      kind: "apply-workspace-operation",
      windowId,
      expectedVersion: 0,
      operation: {
        kind: "dock-tab",
        mode: "code",
        fromGroupId: "00000000-0000-4000-8000-000000000531",
        targetGroupId: "00000000-0000-4000-8000-000000000541",
        tabId: "00000000-0000-4000-8000-000000000533",
        splitNodeId: "00000000-0000-4000-8000-000000000551",
        newGroupNodeId: "00000000-0000-4000-8000-000000000552",
        newGroupId: "00000000-0000-4000-8000-000000000553",
        orientation: "horizontal",
        placement: "after",
        ratio: 0.5,
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(commandResult));
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    await client.execute(dockCommand);

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(dockCommand);
  });

  it("rejects a malformed success response without exposing its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ...commandResult, privatePayload: "do not expose" }),
    );
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    const failure = await rejectedFailure(client.execute(command));
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Shell service returned an invalid response.",
    });
    expect(failure.message).not.toContain("do not expose");
  });

  it("propagates a schema-decoded conflict with version details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          category: "conflict",
          message: "Reload authoritative state.",
          expectedVersion: 3,
          actualVersion: 4,
        },
        { status: 409 },
      ),
    );
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    await expect(client.execute(command)).rejects.toMatchObject({
      category: "conflict",
      message: "Reload authoritative state.",
      expectedVersion: 3,
      actualVersion: 4,
    });
  });

  it("rejects a malformed failure response without exposing its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { category: "unavailable", message: "private server detail", raw: "do not expose" },
        { status: 503 },
      ),
    );
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    const failure = await rejectedFailure(client.bootstrap(windowId));
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Shell service returned an invalid response.",
    });
    expect(failure.message).not.toContain("private server detail");
    expect(failure.message).not.toContain("do not expose");
  });

  it("keeps a server-declared invalid command as a definite rejection", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ category: "invalid", message: "Command rejected." }, { status: 400 }),
    );
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    await expect(client.execute(command)).rejects.toMatchObject({
      category: "invalid",
      message: "Command rejected.",
    });
  });

  it("normalizes unavailable transport without exposing the network error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("connect ECONNREFUSED token=private");
    });
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    const failure = await rejectedFailure(client.bootstrap(windowId));
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Octant shell service is unavailable.",
    });
    expect(failure.message).not.toContain("ECONNREFUSED");
    expect(failure.message).not.toContain("private");
  });

  it("normalizes an aborted request to an actionable unavailable failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new DOMException("private abort reason", "AbortError");
    });
    const client = createShellClient({ baseUrl: "http://localhost:13773", fetch });

    const failure = await rejectedFailure(client.bootstrap(windowId));
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Shell request was aborted.",
    });
    expect(failure.message).not.toContain("private abort reason");
  });
});

async function rejectedFailure(request: Promise<unknown>): Promise<ShellClientFailure> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(ShellClientFailure);
    return error as ShellClientFailure;
  }
  throw new Error("Expected shell request to reject.");
}

function group(seed: string, mode: "chat" | "work" | "code") {
  return {
    kind: "group" as const,
    nodeId: seed,
    groupId: seed.replace(/.$/, "2"),
    tabs: [
      {
        kind: "welcome" as const,
        id: seed.replace(/.$/, "3"),
        mode,
        title: `${mode} welcome`,
      },
    ],
    activeTabId: seed.replace(/.$/, "3"),
  };
}
