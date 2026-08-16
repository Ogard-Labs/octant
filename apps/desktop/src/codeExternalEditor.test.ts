import { describe, expect, it, vi } from "vitest";
import { launchCodeExternalEditor, openCodeExternalEditorFromServer } from "./codeExternalEditor";

describe("launchCodeExternalEditor", () => {
  it("launches an explicit executable with structured arguments and no shell", async () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    await launchCodeExternalEditor({
      editor: {
        executable: "/usr/local/bin/code",
        arguments: ["--goto", "{file}:{line}:{column}"],
      },
      target: { file: "/private/repo/src/app.ts", line: 12, column: 4 },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/code",
      ["--goto", "/private/repo/src/app.ts:12:4"],
      { detached: true, shell: false, stdio: "ignore" },
    );
  });

  it.each([
    { executable: "code", arguments: ["{file}"] },
    { executable: "/usr/local/bin/code", arguments: ["bad\0argument"] },
    { executable: "/usr/local/bin/code", arguments: ["{unknown}"] },
  ])("rejects invalid editor configuration without spawning", async (editor) => {
    const spawn = vi.fn();
    await expect(
      launchCodeExternalEditor({
        editor,
        target: { file: "/private/repo/src/app.ts", line: 1, column: 1 },
        spawn,
      }),
    ).rejects.toThrow("external editor");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("sanitizes launch failures", async () => {
    await expect(
      launchCodeExternalEditor({
        editor: { executable: "/private/secret/editor", arguments: ["{file}"] },
        target: { file: "/private/secret/file", line: 1, column: 1 },
        spawn: () => {
          throw new Error("/private/secret/editor failed");
        },
      }),
    ).rejects.toThrow("Octant could not open the configured external editor.");
  });

  it("resolves opaque identities through the desktop-authenticated server before launch", async () => {
    const fetch = vi.fn(
      async (..._args: Parameters<typeof globalThis.fetch>): Promise<Response> =>
        Response.json({
          file: "/private/repo/src/app.ts",
          line: 12,
          column: 4,
          editor: { executable: "/usr/local/bin/code", arguments: ["--goto", "{file}"] },
        }),
    );
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    await openCodeExternalEditorFromServer({
      serverUrl: "http://127.0.0.1:13773/",
      desktopBridgeSecret: "private-secret",
      windowId: "10000000-0000-4000-8000-000000000001",
      request: {
        threadId: "20000000-0000-4000-8000-000000000001",
        checkoutId: "30000000-0000-4000-8000-000000000001",
        fileId: "40000000-0000-4000-8000-000000000001",
        line: 12,
        column: 4,
      },
      fetch,
      spawn,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:13773/api/desktop/code-external-editor-target");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": "private-secret",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      windowId: "10000000-0000-4000-8000-000000000001",
      threadId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "30000000-0000-4000-8000-000000000001",
      fileId: "40000000-0000-4000-8000-000000000001",
      line: 12,
      column: 4,
    });
  });
});
