import { describe, expect, it, vi } from "vitest";
import {
  ProjectRootPickerError,
  createProjectRootPicker,
  createProjectWindowAuthority,
  generateProjectBridgeToken,
} from "./projectRootPicker";

const serverUrl = "http://127.0.0.1:13773/";
const desktopBridgeSecret = "desktop-bootstrap-secret";
const windowId = "00000000-0000-4000-8000-000000000701";
const receiptId = "R".repeat(43);

describe("Project window authority", () => {
  it("generates distinct canonical 256-bit capabilities", () => {
    const first = generateProjectBridgeToken();
    const second = generateProjectBridgeToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("registers before exposing a capability and revokes with only the bootstrap channel", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const authority = await createProjectWindowAuthority({
      desktopBridgeSecret,
      fetch,
      randomBytes: () => new Uint8Array(32).fill(7),
      serverUrl,
      windowId,
    });

    expect(authority.capability).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:13773/api/desktop/window-authorities",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": desktopBridgeSecret,
        },
        body: JSON.stringify({ windowId, capability: authority.capability }),
      }),
    );

    await authority.revoke();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:13773/api/desktop/window-authorities",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": desktopBridgeSecret,
        },
        body: JSON.stringify({ windowId }),
      }),
    );
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("path");
  });

  it("does not expose a capability when registration fails or leak credentials in the error", async () => {
    const capability = Buffer.alloc(32, 9).toString("base64url");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: desktopBridgeSecret }), { status: 401 }),
      );

    await expect(
      createProjectWindowAuthority({
        desktopBridgeSecret,
        fetch,
        randomBytes: () => Buffer.from(capability, "base64url"),
        serverUrl,
        windowId,
      }),
    ).rejects.toMatchObject({
      message: "Octant could not authorize this Project window.",
    });
    await expect(
      createProjectWindowAuthority({
        desktopBridgeSecret,
        fetch,
        randomBytes: () => Buffer.from(capability, "base64url"),
        serverUrl,
        windowId,
      }),
    ).rejects.not.toThrow(desktopBridgeSecret);
  });

  it("preserves retryable host-time recovery when window registration returns 503", async () => {
    const failure = await createProjectWindowAuthority({
      desktopBridgeSecret,
      fetch: vi.fn().mockResolvedValue(
        Response.json(
          {
            category: "unavailable",
            message: "Desktop Project binding is unavailable while host time recovery is required.",
          },
          { status: 503 },
        ),
      ),
      randomBytes: () => new Uint8Array(32).fill(9),
      serverUrl,
      windowId,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "ProjectWindowAuthorityUnavailableError" });
    expect(String(failure)).toContain("host time recovery");
    expect(String(failure)).not.toContain(desktopBridgeSecret);
  });
});

describe("createProjectRootPicker", () => {
  const ownedWindow = { isDestroyed: () => false };
  const sender = {};

  function setup(overrides: Record<string, unknown> = {}) {
    const dialog = {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ["/private/raw"] }),
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ receiptId, projectType: "work", expiresAt: 61_000 }, { status: 201 }),
      );
    const picker = createProjectRootPicker({
      desktopBridgeSecret,
      dialog,
      fetch,
      resolveOwnedWindow: (candidate) => (candidate === sender ? ownedWindow : undefined),
      serverUrl,
      windowId,
      ...overrides,
    });
    return { dialog, fetch, picker };
  }

  it.each(["work", "code"] as const)(
    "tells %s to choose an accessible directory when the selected root is unavailable",
    async (projectType) => {
      const { picker } = setup({
        fetch: vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { category: "unavailable", message: "The selected Project root is unavailable." },
              { status: 400 },
            ),
          ),
      });

      await expect(picker({ sender }, projectType)).rejects.toMatchObject({
        message: "Choose an accessible directory.",
      });
    },
  );

  it.each(["work", "code"] as const)(
    "tells %s to choose an accessible directory when root validation is unavailable",
    async (projectType) => {
      const { picker } = setup({
        fetch: vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { category: "unavailable", message: "The selected Project root is unavailable." },
              { status: 503 },
            ),
          ),
      });

      await expect(picker({ sender }, projectType)).rejects.toMatchObject({
        message: "Choose an accessible directory.",
      });
    },
  );

  it("does not treat host-time recovery as a rejected Project root", async () => {
    const { picker } = setup({
      fetch: vi.fn().mockResolvedValue(
        Response.json(
          {
            category: "unavailable",
            message: "Desktop Project binding is unavailable while host time recovery is required.",
          },
          { status: 503 },
        ),
      ),
    });

    await expect(picker({ sender }, "code")).rejects.toMatchObject({
      message: "Octant could not validate the selected Project root.",
    });
  });

  it.each(["work", "code"] as const)(
    "accepts an owned directory as a %s Project root and returns only a frozen receipt",
    async (projectType) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ receiptId, projectType, expiresAt: 61_000 }, { status: 201 }),
        );
      const { dialog, picker } = setup({ fetch });

      const result = await picker({ sender }, projectType);

      expect(dialog.showOpenDialog).toHaveBeenCalledWith(ownedWindow, {
        properties: ["openDirectory", "dontAddToRecent"],
      });
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:13773/api/desktop/project-binding-receipts",
        expect.objectContaining({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-desktop-secret": desktopBridgeSecret,
          },
          body: JSON.stringify({ windowId, projectType, path: "/private/raw" }),
        }),
      );
      expect(result).toEqual({ kind: "selected", receiptId, displayName: "raw" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("/private/raw");
    },
  );

  it("returns a frozen cancellation without contacting the server", async () => {
    const { fetch, picker } = setup({
      dialog: { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) },
    });

    const result = await picker({ sender }, "code");

    expect(result).toEqual({ kind: "cancelled" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts raw path and bootstrap secret when the native dialog rejects", async () => {
    const { fetch, picker } = setup({
      dialog: {
        showOpenDialog: vi.fn().mockRejectedValue(new Error(`/private/raw ${desktopBridgeSecret}`)),
      },
    });

    const rejection = picker({ sender }, "work");
    await expect(rejection).rejects.toMatchObject({
      message: "Octant could not open the Project root picker.",
    });
    await expect(rejection).rejects.not.toThrow("/private/raw");
    await expect(rejection).rejects.not.toThrow(desktopBridgeSecret);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires exact HTTP 201 for a valid receipt response", async () => {
    const { picker } = setup({
      fetch: vi
        .fn()
        .mockResolvedValue(
          Response.json({ receiptId, projectType: "work", expiresAt: 61_000 }, { status: 200 }),
        ),
    });

    await expect(picker({ sender }, "work")).rejects.toMatchObject({
      message: "Octant could not validate the selected Project root.",
    });
  });

  it.each(["chat", "unknown", undefined])(
    "rejects invalid Project type %s before dialog",
    async (projectType) => {
      const { dialog, fetch, picker } = setup();

      await expect(picker({ sender }, projectType)).rejects.toBeInstanceOf(ProjectRootPickerError);
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects foreign or destroyed senders before dialog", async () => {
    const foreign = setup();
    await expect(foreign.picker({ sender: {} }, "work")).rejects.toBeInstanceOf(
      ProjectRootPickerError,
    );
    expect(foreign.dialog.showOpenDialog).not.toHaveBeenCalled();

    const destroyed = setup({
      resolveOwnedWindow: () => ({ isDestroyed: () => true }),
    });
    await expect(destroyed.picker({ sender }, "code")).rejects.toBeInstanceOf(
      ProjectRootPickerError,
    );
    expect(destroyed.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed or failed server responses without leaking private values", async () => {
    for (const response of [
      Response.json({ receiptId, projectType: "work", expiresAt: 61_000, path: "/private/raw" }),
      Response.json({ category: "invalid", message: "/private/raw" }, { status: 400 }),
    ]) {
      const { picker } = setup({ fetch: vi.fn().mockResolvedValue(response) });
      const rejection = picker({ sender }, "work");
      await expect(rejection).rejects.toMatchObject({
        message: "Octant could not validate the selected Project root.",
      });
      await expect(rejection).rejects.not.toThrow("/private/raw");
      await expect(rejection).rejects.not.toThrow(desktopBridgeSecret);
    }
  });
});
