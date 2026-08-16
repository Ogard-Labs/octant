import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertNoOwnedPackagedChatProcesses,
  completedAssistantText,
  createPackagedChatSmokeDirectories,
  findOwnedPackagedChatProcesses,
  isFinalizedPackagedAttachment,
  packagedChatEnvironment,
  startPackagedChatProviderFixture,
  withPackagedChatLifecycle,
  type PackagedChatProcess,
} from "./smoke-packaged-chat";

const root = "/tmp/octant-packaged-chat.abc";

describe("packaged Chat smoke isolation", () => {
  it("exercises the bundled server without depending on staged internal package exports", async () => {
    const source = await readFile(new URL("./smoke-packaged-chat.ts", import.meta.url), "utf8");

    expect(source).toContain("access(serverEntry)");
    expect(source).toContain("spawn(executable");
    expect(source).not.toContain("createRequire");
    expect(source).not.toContain("pathToFileURL");
    expect(source).not.toContain("CHAT_RUNTIME_IMPORTS");
    expect(source).not.toContain("process.chdir");
  });

  it("uses an isolated loopback provider to prove a real packaged Chat turn", async () => {
    const source = await readFile(new URL("./smoke-packaged-chat.ts", import.meta.url), "utf8");

    expect(source).toContain("createServer");
    expect(source).toContain("create-ollama-provider");
    expect(source).toContain("send-chat-turn");
    expect(source).toContain("/events?afterSequence=");
  });

  it("routes setup, baseline, spawn, and verification through one cleanup owner", async () => {
    const source = await readFile(new URL("./smoke-packaged-chat.ts", import.meta.url), "utf8");

    expect(source).toContain("withPackagedChatLifecycle");
  });

  it("serves deterministic streamed provider evidence only on loopback", async () => {
    const fixture = await startPackagedChatProviderFixture();
    try {
      expect(new URL(fixture.baseUrl).hostname).toBe("127.0.0.1");
      await expect(
        fetch(`${fixture.baseUrl}/api/version`).then((response) => response.json()),
      ).resolves.toEqual({
        version: "0.1.0",
      });
      const streamed = await fetch(`${fixture.baseUrl}/api/chat`, { method: "POST" }).then(
        (response) => response.text(),
      );
      expect(streamed).toContain('"content":"packaged "');
      expect(streamed).toContain('"content":"chat smoke"');
      expect(streamed).toContain('"done":true');
    } finally {
      await fixture.close();
      await expect(fixture.close()).resolves.toBeUndefined();
    }
  });

  it("sends the finalized image attachment through the native Ollama modality", async () => {
    const source = await readFile(new URL("./smoke-packaged-chat.ts", import.meta.url), "utf8");
    const fixture = await startPackagedChatProviderFixture();
    try {
      expect(source).toMatch(/smokeChatTurn\(capability,\s*threadId,\s*attachmentId/);
      expect(source).toContain("attachmentIds: [attachmentId]");
      expect(source).toContain("setup.fixture.assertReceivedNativeImage()");

      await expect(
        fetch(`${fixture.baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "octant-smoke:latest" }),
        }).then((response) => response.json()),
      ).resolves.toMatchObject({ capabilities: expect.arrayContaining(["vision"]) });

      await fetch(`${fixture.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "opaque", images: ["AQID"] }],
        }),
      });
      expect(() => fixture.assertReceivedNativeImage()).not.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("accepts the packaged attachment shape without inventing a command-result wrapper", () => {
    expect(
      isFinalizedPackagedAttachment(
        {
          id: "attachment-a",
          threadId: "thread-a",
          displayName: "packaged-chat-smoke.txt",
          mediaType: "text/plain",
          byteLength: 4,
          digest: "a".repeat(64),
          status: "finalized",
          createdAt: "2026-07-20T08:00:00.000Z",
        },
        "thread-a",
        "attachment-a",
      ),
    ).toBe(true);
    expect(
      isFinalizedPackagedAttachment(
        { kind: "attachment-updated", id: "attachment-a", status: "finalized" },
        "thread-a",
        "attachment-a",
      ),
    ).toBe(false);
  });

  it("assembles completed assistant content in response-reference order", () => {
    expect(
      completedAssistantText({
        contents: [
          { contentId: "second", role: "assistant", body: "chat smoke" },
          { contentId: "first", role: "assistant", body: "packaged " },
        ],
        turns: [
          {
            attempts: [
              {
                outcome: "completed",
                responseRefs: [{ contentId: "first" }, { contentId: "second" }],
              },
            ],
          },
        ],
      }),
    ).toBe("packaged chat smoke");
  });

  it.each(["setup", "baseline", "spawn"] as const)(
    "removes the isolated root when %s fails",
    async (stage) => {
      const calls: string[] = [];
      await expect(
        withPackagedChatLifecycle({
          createRoot: async () => "/tmp/root",
          setup: async () => {
            if (stage === "setup") throw new Error("setup failed");
            return "setup";
          },
          inspectBaseline: async () => {
            if (stage === "baseline") throw new Error("baseline failed");
            return "baseline";
          },
          spawnApp: () => {
            if (stage === "spawn") throw new Error("spawn failed");
            return "app";
          },
          verify: async () => "result",
          cleanupApp: async () => calls.push("app"),
          cleanupSetup: async () => calls.push("setup"),
          removeRoot: async () => calls.push("root"),
        }),
      ).rejects.toThrow(`${stage} failed`);
      expect(calls.at(-1)).toBe("root");
      expect(calls).not.toContain("app");
    },
  );

  it("cleans a spawned app and root when verification fails", async () => {
    const calls: string[] = [];
    await expect(
      withPackagedChatLifecycle({
        createRoot: async () => "/tmp/root",
        setup: async () => "setup",
        inspectBaseline: async () => "baseline",
        spawnApp: () => "app",
        verify: async () => {
          throw new Error("verification failed");
        },
        cleanupApp: async () => calls.push("app"),
        cleanupSetup: async () => calls.push("setup"),
        removeRoot: async () => calls.push("root"),
      }),
    ).rejects.toThrow("verification failed");
    expect(calls).toEqual(["app", "setup", "root"]);
  });

  it("preserves primary and cleanup failure causes", async () => {
    const failure = await withPackagedChatLifecycle({
      createRoot: async () => "/tmp/root",
      setup: async () => "setup",
      inspectBaseline: async () => "baseline",
      spawnApp: () => "app",
      verify: async () => {
        throw new Error("provider probe failed");
      },
      cleanupApp: async () => undefined,
      cleanupSetup: async () => {
        throw new Error("fixture close failed");
      },
      removeRoot: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "provider probe failed" }),
      expect.objectContaining({ message: "Packaged Chat fixture cleanup failed." }),
    ]);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      cause: expect.objectContaining({ message: "fixture close failed" }),
    });
  });

  it("owns separate data, config, scratch, and attachment directories", () => {
    expect(createPackagedChatSmokeDirectories(root)).toEqual({
      root,
      dataDirectory: `${root}/data`,
      configDirectory: `${root}/config`,
      scratchDirectory: `${root}/data/chat/scratch`,
      attachmentDirectory: `${root}/data/chat/threads`,
    });
  });

  it("launches with only its isolated filesystem environment", () => {
    const directories = createPackagedChatSmokeDirectories(root);

    expect(
      packagedChatEnvironment(
        {
          HOME: "/Users/ambient",
          OCTANT_CREDENTIAL_BROKER_TOKEN: "private-value",
          OPENAI_API_KEY: "private-value",
        },
        directories,
      ),
    ).toEqual({
      HOME: directories.configDirectory,
      TMPDIR: directories.scratchDirectory,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OCTANT_DATA_DIR: directories.dataDirectory,
      OCTANT_SERVER_PORT: "13773",
    });
  });
});

describe("packaged Chat process attribution", () => {
  const baseline: readonly PackagedChatProcess[] = [
    { pid: 10, ppid: 1, pgid: 10, command: "/older/Octant" },
    { pid: 11, ppid: 10, pgid: 10, command: "/older/apps/server/dist/main.mjs" },
  ];

  it("attributes the exact smoke app and its direct packaged server child", () => {
    const app = { pid: 20, ppid: 1, pgid: 20, command: "/package/Octant" };
    const server = {
      pid: 21,
      ppid: app.pid,
      pgid: app.pgid,
      command: "/package/app/apps/server/dist/main.mjs",
    };
    const identities = findOwnedPackagedChatProcesses([...baseline, app, server], {
      appPid: app.pid,
      serverEntry: "/package/app/apps/server/dist/main.mjs",
    });

    expect(identities).toEqual({ app, server });
    expect(() =>
      assertNoOwnedPackagedChatProcesses([...baseline], {
        appPid: app.pid,
        processGroup: app.pgid,
        ownedServerPid: server.pid,
      }),
    ).not.toThrow();
  });

  it("rejects a server with only a matching command but no smoke parent identity", () => {
    expect(() =>
      findOwnedPackagedChatProcesses(
        [
          ...baseline,
          { pid: 22, ppid: 1, pgid: 22, command: "/package/app/apps/server/dist/main.mjs" },
        ],
        { appPid: 20, serverEntry: "/package/app/apps/server/dist/main.mjs" },
      ),
    ).toThrow("managed app identity is unavailable");
  });
});
