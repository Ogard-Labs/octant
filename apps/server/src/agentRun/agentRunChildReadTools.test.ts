import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childGithubTools, childLookTools } from "./agentRunChildReadTools";
import { CHILD_PARENT, CHILD_RUN, childHost } from "./agentRunChildTools.test-support";

const call = (name: string, input: unknown) => ({ name, inputJson: JSON.stringify(input) });

describe("a child that cannot read images", () => {
  const look = (
    overrides: { readonly readsImages?: boolean; readonly available?: boolean } = {},
  ) => {
    const describe = vi.fn(async (_input: unknown) => ({
      kind: "described" as const,
      describedBy: { providerInstanceId: "p", modelId: "seeing" } as never,
      text: "A blue footer.",
    }));
    return {
      describe,
      describer: {
        available: () =>
          overrides.available === false
            ? { kind: "unavailable" as const, reason: "No model." }
            : { kind: "available" as const },
        describe,
      } as never,
      readsImages: overrides.readsImages ?? false,
    };
  };

  it("is offered octant_look only while Sees images can describe one for its Project", () => {
    const facts = { threadModel: "Worker", uuid: () => crypto.randomUUID() };
    expect(
      childLookTools({ host: childHost(), ...facts, ...look() })?.definitions.map(
        (tool) => tool.name,
      ),
    ).toEqual(["octant_look"]);
    expect(
      childLookTools({ host: childHost(), ...facts, ...look({ readsImages: true }) }),
    ).toBeUndefined();
    expect(
      childLookTools({ host: childHost(), ...facts, ...look({ available: false }) }),
    ).toBeUndefined();
    // A read, so Plan keeps it.
    expect(
      childLookTools({ host: childHost({ policy: "plan" }), ...facts, ...look() }),
    ).toBeDefined();
  });

  it("looks only inside its own folder, and spends against its parent's ceiling as its turns do", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-child-look-")));
    try {
      await writeFile(join(root, "footer.png"), Buffer.from("not really a png"));
      const { describe: described, ...port } = look();
      const tools = childLookTools({
        host: childHost({ root }),
        threadModel: "Worker",
        uuid: () => crypto.randomUUID(),
        ...port,
      });
      const seen = await tools?.execute(call("octant_look", { image: "footer.png" }));
      expect(JSON.stringify(seen)).toContain("A blue footer.");
      expect(described.mock.calls[0]?.[0]).toMatchObject({
        scope: { threadId: CHILD_PARENT, threadType: "code-thread" },
      });
      expect(await tools?.execute(call("octant_look", { image: "../parent.png" }))).toMatchObject({
        isError: true,
      });
      expect(described).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a Code child's GitHub reads", () => {
  const thread = {
    id: CHILD_PARENT,
    projectId: "77777777-7777-4777-8777-777777777777",
    lifecycle: "active",
    toolConstraints: [],
  } as never;

  it("are offered to a Code child of a Project whose integration is effective, and to no other child", () => {
    const createToolSet = vi.fn((_context: unknown) => ({
      definitions: [{ name: "octant_github", inputSchema: {} }],
      execute: async () => ({ result: "read" }),
    }));
    const deps = {
      github: { createToolSet } as never,
      effective: (create: () => unknown) => create() as never,
      readThread: () => thread,
    };
    expect(childGithubTools({ host: childHost(), ...deps })).toBeDefined();
    expect(createToolSet.mock.calls[0]?.[0]).toMatchObject({ readerId: CHILD_RUN });
    expect(childGithubTools({ host: childHost({ policy: "plan" }), ...deps })).toBeDefined();
    expect(childGithubTools({ host: childHost({ mode: "work" }), ...deps })).toBeUndefined();
    expect(childGithubTools({ host: childHost({ mode: "chat" }), ...deps })).toBeUndefined();
    expect(
      childGithubTools({ host: childHost(), ...deps, effective: () => undefined }),
    ).toBeUndefined();
    expect(
      childGithubTools({ host: childHost(), ...deps, readThread: () => undefined }),
    ).toBeUndefined();
  });

  it("stop once the child no longer holds its grant", async () => {
    let held = true;
    const tools = childGithubTools({
      host: childHost({ current: () => held }),
      github: {
        createToolSet: () => ({
          definitions: [],
          execute: async () => ({ result: "read" }),
        }),
      } as never,
      effective: (create: () => unknown) => create() as never,
      readThread: () => thread,
    });
    expect(await tools?.execute(call("octant_github", {}))).toEqual({ result: "read" });
    held = false;
    expect(await tools?.execute(call("octant_github", {}))).toMatchObject({ isError: true });
  });
});
