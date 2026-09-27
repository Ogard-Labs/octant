import { describe, expect, it, vi } from "vitest";
import {
  SIDE_CHAT_LIST_FILES_TOOL_NAME,
  SIDE_CHAT_READ_FILE_TOOL_NAME,
  SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeCheckoutId,
} from "@octant/contracts";
import { workFilesystemFixture } from "../work/workFilesystemFixture";
import {
  createSideChatSourceTools,
  createSideChatWorkFileReader,
  type SideChatCodeSourceReads,
} from "./sideChatSourceTools";

const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000301");
const workThreadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000302");
const checkoutId = "00000000-0000-4000-8000-000000000601" as CodeCheckoutId;

function codeReads(text = "line one\nline two\nline three"): SideChatCodeSourceReads {
  return {
    checkoutOf: vi.fn(async () => ({ checkoutId, availability: "available" })),
    listFiles: vi.fn(async () => ({
      status: "listed" as const,
      listing: {
        kind: "code-file-listing" as const,
        threadId: codeThreadId,
        checkoutId,
        entries: [],
        truncated: false,
        observedAt: "2026-09-26T10:00:00.000Z" as never,
      },
    })),
    searchFiles: vi.fn(async () => ({
      status: "failed" as const,
      failure: { category: "unavailable" as const, message: "Search is unavailable." },
    })),
    readFile: vi.fn(async () => ({
      status: "read" as const,
      bytes: new TextEncoder().encode(text),
    })),
  };
}

describe("Side Chat source file tools", () => {
  it("offers only reading tools, and refuses any other name", async () => {
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads: codeReads() },
      authorize: async () => true,
    });

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      SIDE_CHAT_LIST_FILES_TOOL_NAME,
      SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
      SIDE_CHAT_READ_FILE_TOOL_NAME,
    ]);
    const write = await tools.execute({
      name: "octant_side_chat_write_file",
      inputJson: JSON.stringify({ path: "a.ts", content: "x" }),
    });
    expect(write).toMatchObject({ isError: true, result: { status: "refused" } });
  });

  it("asks for the source's authority again on every call and stops when it is gone", async () => {
    const reads = codeReads();
    let allowed = true;
    const authorize = vi.fn(async () => allowed);
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads },
      authorize,
    });

    const first = await tools.execute({
      name: SIDE_CHAT_READ_FILE_TOOL_NAME,
      inputJson: JSON.stringify({ path: "src/a.ts" }),
    });
    allowed = false;
    const second = await tools.execute({
      name: SIDE_CHAT_READ_FILE_TOOL_NAME,
      inputJson: JSON.stringify({ path: "src/a.ts" }),
    });

    expect(first).toMatchObject({
      result: { status: "read", text: "line one\nline two\nline three" },
    });
    expect(second).toMatchObject({ isError: true, result: { status: "refused" } });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(reads.readFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a path outside the source's folder before any host read", async () => {
    const reads = codeReads();
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads },
      authorize: async () => true,
    });

    for (const path of ["../secrets.txt", "/etc/passwd", "src/../../x"]) {
      const result = await tools.execute({
        name: SIDE_CHAT_READ_FILE_TOOL_NAME,
        inputJson: JSON.stringify({ path }),
      });
      expect(result).toMatchObject({ isError: true, result: { status: "refused" } });
    }
    expect(reads.readFile).not.toHaveBeenCalled();
  });

  it("waits for a checkout the host is still resolving instead of calling the file unreadable", async () => {
    const availability = ["waiting", "waiting", "available"];
    const reads = {
      ...codeReads("first line\nsecond line"),
      checkoutOf: vi.fn(async () => ({
        checkoutId,
        availability: availability.shift() ?? "available",
      })),
    };
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads },
      authorize: async () => true,
      sleep: async () => undefined,
    });

    const result = await tools.execute({
      name: SIDE_CHAT_READ_FILE_TOOL_NAME,
      inputJson: JSON.stringify({ path: "README.md" }),
    });

    expect(result).toMatchObject({ result: { status: "read", text: "first line\nsecond line" } });
    expect(reads.checkoutOf).toHaveBeenCalledTimes(3);
    expect(reads.readFile).toHaveBeenCalledTimes(1);
  });

  it("says the checkout is still being prepared when it never becomes available", async () => {
    const reads = {
      ...codeReads(),
      checkoutOf: vi.fn(async () => ({ checkoutId, availability: "waiting" })),
    };
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads },
      authorize: async () => true,
      sleep: async () => undefined,
    });

    const result = await tools.execute({
      name: SIDE_CHAT_LIST_FILES_TOOL_NAME,
      inputJson: "{}",
    });

    expect(result).toMatchObject({
      isError: true,
      result: { status: "refused", message: expect.stringContaining("still being prepared") },
    });
    expect(reads.listFiles).not.toHaveBeenCalled();
  });

  it("returns a window of lines and says where it stopped", async () => {
    const text = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const tools = createSideChatSourceTools({
      source: { mode: "code", threadId: codeThreadId, reads: codeReads(text) },
      authorize: async () => true,
    });

    const result = await tools.execute({
      name: SIDE_CHAT_READ_FILE_TOOL_NAME,
      inputJson: JSON.stringify({ path: "big.txt", startLine: 501, lineCount: 10 }),
    });

    expect(result).toMatchObject({
      result: { status: "read", startLine: 501, endLine: 510, totalLines: 1_000, truncated: true },
    });
  });

  it("reads a Work source's file only inside its Project folder", async () => {
    const filesystem = workFilesystemFixture("/work");
    filesystem.putFile("/work/notes.md", new TextEncoder().encode("# Notes\nShip Friday."));
    const readFile = createSideChatWorkFileReader({
      filesystem,
      resolveRoot: async () => "/work",
      maximumBytes: 1_024,
    });
    const tools = createSideChatSourceTools({
      source: {
        mode: "work",
        threadId: workThreadId,
        reads: {
          listFiles: vi.fn(async () => {
            throw new Error("not used");
          }),
          readFile,
        },
      },
      authorize: async () => true,
    });

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      SIDE_CHAT_LIST_FILES_TOOL_NAME,
      SIDE_CHAT_READ_FILE_TOOL_NAME,
    ]);
    const inside = await tools.execute({
      name: SIDE_CHAT_READ_FILE_TOOL_NAME,
      inputJson: JSON.stringify({ path: "notes.md" }),
    });
    const outside = await readFile({ threadId: workThreadId, relativePath: "../etc/passwd" });

    expect(inside).toMatchObject({ result: { status: "read", text: "# Notes\nShip Friday." } });
    expect(outside).toMatchObject({ status: "refused" });
  });

  it("refuses a Work file whose symlink leads out of the Project folder", async () => {
    const filesystem = workFilesystemFixture("/work");
    filesystem.putFile("/elsewhere/secret.txt", new TextEncoder().encode("secret"));
    filesystem.putSymlink("/work/link.txt", "/elsewhere/secret.txt");
    const readFile = createSideChatWorkFileReader({
      filesystem,
      resolveRoot: async () => "/work",
      maximumBytes: 1_024,
    });

    expect(await readFile({ threadId: workThreadId, relativePath: "link.txt" })).toMatchObject({
      status: "refused",
    });
  });
});
