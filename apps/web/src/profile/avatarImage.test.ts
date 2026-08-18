import { MAX_AVATAR_IMAGE_CHARACTERS } from "@octant/contracts/user-profile";
import { describe, expect, it, vi } from "vitest";
import {
  importAvatarFromFile,
  importAvatarFromGravatar,
  type AvatarImageEnvironment,
} from "./avatarImage";

const encoded = "data:image/webp;base64,AAAA";

function environment(overrides: Partial<AvatarImageEnvironment> = {}): AvatarImageEnvironment {
  return {
    decode: vi.fn(async () => ({ width: 400, height: 300 })),
    encode: vi.fn(async () => ({ dataUrl: encoded })),
    fetch: vi.fn(async () => new Response("binary", { status: 200 })),
    digest: vi.fn(async () => "hashed"),
    ...overrides,
  };
}

function imageFile(type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], "avatar.png", { type });
}

describe("importing an avatar from a file", () => {
  it("downscales and inlines an image the host can read", async () => {
    const env = environment();

    const result = await importAvatarFromFile(imageFile(), env);

    expect(result).toEqual({ kind: "imported", dataUrl: encoded });
    // The original is never stored: what goes into settings is the small
    // square the surface actually draws.
    expect(env.encode).toHaveBeenCalledWith(expect.anything(), 128);
  });

  it("refuses a file that is not an image, by name", async () => {
    const result = await importAvatarFromFile(
      new File(["x"], "notes.pdf", { type: "application/pdf" }),
      environment(),
    );

    expect(result).toEqual({
      kind: "failed",
      failure: { kind: "unsupported-type", message: expect.stringContaining("not a PNG") },
    });
  });

  it("reports an image it could not decode instead of storing nothing quietly", async () => {
    const result = await importAvatarFromFile(
      imageFile(),
      environment({
        decode: vi.fn(async () => {
          throw new Error("corrupt");
        }),
      }),
    );

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "unreadable" } });
  });

  it("refuses an image too large for journaled settings", async () => {
    const result = await importAvatarFromFile(
      imageFile(),
      environment({
        encode: vi.fn(async () => ({
          dataUrl: `data:image/png;base64,${"A".repeat(MAX_AVATAR_IMAGE_CHARACTERS)}`,
        })),
      }),
    );

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "too-large" } });
  });
});

describe("importing an avatar from Gravatar", () => {
  it("asks for the normalised address and inlines what comes back", async () => {
    const env = environment();

    const result = await importAvatarFromGravatar("  Ada@Example.COM ", env);

    expect(env.digest).toHaveBeenCalledWith("ada@example.com");
    // `d=404` means a miss is reported as a miss, so Octant never stores the
    // placeholder Gravatar would otherwise generate.
    expect(env.fetch).toHaveBeenCalledWith("https://gravatar.com/avatar/hashed?s=256&d=404", {
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({ kind: "imported", dataUrl: encoded });
  });

  it("says the address has no Gravatar rather than inventing one", async () => {
    const result = await importAvatarFromGravatar(
      "ada@example.com",
      environment({ fetch: vi.fn(async () => new Response(null, { status: 404 })) }),
    );

    expect(result).toMatchObject({
      kind: "failed",
      failure: { kind: "gravatar-missing", message: expect.stringContaining("no Gravatar") },
    });
  });

  it("distinguishes an unreachable service from a missing picture", async () => {
    const offline = await importAvatarFromGravatar(
      "ada@example.com",
      environment({
        fetch: vi.fn(async () => {
          throw new TypeError("offline");
        }),
      }),
    );
    const broken = await importAvatarFromGravatar(
      "ada@example.com",
      environment({ fetch: vi.fn(async () => new Response(null, { status: 503 })) }),
    );

    expect(offline).toMatchObject({ failure: { kind: "gravatar-unreachable" } });
    expect(broken).toMatchObject({ failure: { kind: "gravatar-unreachable" } });
  });

  // A request that is accepted and then never answered fails no other way, and
  // first run disables Escape and Skip while an import runs, so an unbounded
  // one leaves the user with no way out of the profile step.
  it("gives up on a request gravatar.com accepts and never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = importAvatarFromGravatar(
        "ada@example.com",
        environment({
          fetch: vi.fn(
            async (_input, init) =>
              await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              }),
          ),
        }),
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toMatchObject({ failure: { kind: "gravatar-unreachable" } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Headers arriving and the stream then stalling is the same hang, so the
  // deadline has to outlast the response, not end when it resolves.
  it("gives up on a Gravatar whose body never finishes arriving", async () => {
    vi.useFakeTimers();
    try {
      const pending = importAvatarFromGravatar(
        "ada@example.com",
        environment({
          fetch: vi.fn(
            async (_input, init) =>
              ({
                status: 200,
                ok: true,
                blob: async () =>
                  await new Promise<Blob>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                  }),
              }) as unknown as Response,
          ),
        }),
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toMatchObject({ failure: { kind: "gravatar-unreachable" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
