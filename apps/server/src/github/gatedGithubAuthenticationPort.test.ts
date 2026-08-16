import { describe, expect, it, vi } from "vitest";
import { createGatedGithubAuthenticationPort } from "./gatedGithubAuthenticationPort";

function createRealPort() {
  return {
    observe: vi.fn(async () => ({ state: "authenticated" }) as never),
    execute: vi.fn(async () => ({ kind: "ok" }) as never),
    close: vi.fn(),
  };
}

describe("createGatedGithubAuthenticationPort", () => {
  it("passes observe and execute through to the real port when effective", async () => {
    const port = createRealPort();
    const gated = createGatedGithubAuthenticationPort({ port, effective: () => true });
    const signal = new AbortController().signal;

    await gated.observe(signal);
    await gated.execute({ kind: "sign-out" } as never, signal);

    expect(port.observe).toHaveBeenCalledWith(signal);
    expect(port.execute).toHaveBeenCalledWith({ kind: "sign-out" }, signal);
  });

  it("returns unavailable without touching the real port when disabled", async () => {
    const port = createRealPort();
    const gated = createGatedGithubAuthenticationPort({ port, effective: () => false });

    const observation = await gated.observe(new AbortController().signal);

    expect(observation).toEqual({ kind: "unavailable" });
    expect(port.observe).not.toHaveBeenCalled();
  });

  it("throws on execute without touching the real port when disabled", async () => {
    const port = createRealPort();
    const gated = createGatedGithubAuthenticationPort({ port, effective: () => false });

    await expect(
      gated.execute({ kind: "sign-out" } as never, new AbortController().signal),
    ).rejects.toThrow();
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("always delegates close, even when disabled", () => {
    const port = createRealPort();
    const gated = createGatedGithubAuthenticationPort({ port, effective: () => false });

    gated.close();

    expect(port.close).toHaveBeenCalledOnce();
  });
});
