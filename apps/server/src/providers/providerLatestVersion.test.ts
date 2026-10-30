import { describe, expect, it } from "vitest";
import { createProviderLatestVersionCheck } from "./providerLatestVersion";

function fixture(body: unknown, status = 200) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, requests };
}

describe("provider latest-version check", () => {
  it("reads the latest dist-tag with a plain GET that sends nothing else", async () => {
    const { fetch, requests } = fixture({ latest: "0.166.0", beta: "0.1.1" });
    const check = createProviderLatestVersionCheck({ fetch });
    await expect(check("@openai/codex")).resolves.toBe("0.166.0");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://registry.npmjs.org/-/package/@openai/codex/dist-tags");
    expect([...(requests[0]?.headers.keys() ?? [])].sort()).toEqual(["accept", "user-agent"]);
  });

  it("asks the registry once a day per package", async () => {
    let now = 0;
    const { fetch, requests } = fixture({ latest: "1.0.0" });
    const check = createProviderLatestVersionCheck({ fetch, now: () => now });
    await check("cline");
    await check("cline");
    expect(requests).toHaveLength(1);
    now += 25 * 60 * 60 * 1000;
    await check("cline");
    expect(requests).toHaveLength(2);
  });

  it("stays quiet when the registry refuses or answers nonsense", async () => {
    await expect(
      createProviderLatestVersionCheck({ fetch: fixture({}, 503).fetch })("cline"),
    ).resolves.toBeUndefined();
    await expect(
      createProviderLatestVersionCheck({ fetch: fixture({ latest: "<script>" }).fetch })("cline"),
    ).resolves.toBeUndefined();
    const failing = async () => {
      throw new Error("offline");
    };
    await expect(
      createProviderLatestVersionCheck({ fetch: failing })("cline"),
    ).resolves.toBeUndefined();
  });

  it("sends nothing while marketplace fetches are turned off", async () => {
    const { fetch, requests } = fixture({ latest: "1.0.0" });
    let allowed = false;
    const check = createProviderLatestVersionCheck({ fetch, isAllowed: () => allowed });
    await expect(check("cline")).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
    allowed = true;
    await expect(check("cline")).resolves.toBe("1.0.0");
  });
});
