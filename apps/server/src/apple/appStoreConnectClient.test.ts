import { describe, expect, it } from "vitest";
import { createAppStoreConnectApi, type AppStoreConnectFetch } from "./appStoreConnectClient";

const TOKEN = "signed.token.value";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly body: unknown;
}

/** A stand-in for App Store Connect that answers each request in turn. */
function stubbedApi(answers: ReadonlyArray<{ readonly status: number; readonly body: unknown }>) {
  const sent: Sent[] = [];
  let next = 0;
  const fetch: AppStoreConnectFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    sent.push({
      method: init.method ?? "GET",
      url,
      authorization: headers.get("authorization"),
      redirect: init.redirect,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[next] ?? { status: 500, body: {} };
    next += 1;
    return Response.json(answer.body, { status: answer.status });
  };
  return { api: createAppStoreConnectApi(fetch), sent };
}

describe("App Store Connect API client", () => {
  it("reads one version and its selected build from the API host only, with the signed token", async () => {
    const { api, sent } = stubbedApi([
      {
        status: 200,
        body: {
          data: [{ type: "apps", id: "1234567890", attributes: { bundleId: "app.fixture" } }],
        },
      },
      {
        status: 200,
        body: {
          data: [
            {
              type: "appStoreVersions",
              id: "ver-1",
              attributes: { versionString: "1.2", appVersionState: "PREPARE_FOR_SUBMISSION" },
              relationships: { build: { data: { type: "builds", id: "build-7" } } },
            },
          ],
          included: [
            {
              type: "builds",
              id: "build-7",
              attributes: { version: "7", processingState: "VALID" },
            },
          ],
        },
      },
    ]);
    await expect(
      api.readVersion(TOKEN, { bundleIdentifier: "app.fixture", version: "1.2" }),
    ).resolves.toEqual({
      kind: "found",
      version: {
        appId: "1234567890",
        versionId: "ver-1",
        state: "PREPARE_FOR_SUBMISSION",
        build: { buildNumber: "7", processingState: "VALID" },
      },
    });
    for (const request of sent) {
      expect(new URL(request.url).origin).toBe("https://api.appstoreconnect.apple.com");
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.redirect).toBe("error");
    }
  });

  it("submits a version as one review submission and withdraws the draft when App Store Connect refuses it", async () => {
    const created = { status: 201, body: { data: { type: "reviewSubmissions", id: "sub-1" } } };
    const accepted = await (async () => {
      const { api, sent } = stubbedApi([
        created,
        { status: 201, body: { data: { type: "reviewSubmissionItems", id: "item-1" } } },
        { status: 200, body: { data: { type: "reviewSubmissions", id: "sub-1" } } },
      ]);
      const step = await api.submitForReview(TOKEN, { appId: "1234567890", versionId: "ver-1" });
      return { step, sent };
    })();
    expect(accepted.step).toEqual({ kind: "done", id: "sub-1" });
    expect(
      accepted.sent.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual([
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/sub-1",
    ]);
    expect(accepted.sent[2]?.body).toEqual({
      data: { type: "reviewSubmissions", id: "sub-1", attributes: { submitted: true } },
    });

    const { api, sent } = stubbedApi([
      created,
      {
        status: 409,
        body: { errors: [{ title: "Conflict", detail: "The version is missing screenshots." }] },
      },
      { status: 200, body: { data: { type: "reviewSubmissions", id: "sub-1" } } },
    ]);
    await expect(
      api.submitForReview(TOKEN, { appId: "1234567890", versionId: "ver-1" }),
    ).resolves.toEqual({ kind: "refused", reason: "The version is missing screenshots." });
    expect(sent.at(-1)?.body).toEqual({
      data: { type: "reviewSubmissions", id: "sub-1", attributes: { canceled: true } },
    });
    expect(sent).toHaveLength(3);
  });

  it("releases a version with one release request and counts nothing it cannot read", async () => {
    const released = stubbedApi([
      { status: 201, body: { data: { type: "appStoreVersionReleaseRequests", id: "rel-1" } } },
    ]);
    await expect(released.api.release(TOKEN, { versionId: "ver-1" })).resolves.toEqual({
      kind: "done",
      id: "rel-1",
    });
    expect(released.sent[0]?.body).toEqual({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "ver-1" } } },
      },
    });
    const unreadable = stubbedApi([{ status: 502, body: "gateway" }]);
    await expect(unreadable.api.release(TOKEN, { versionId: "ver-1" })).resolves.toEqual({
      kind: "unclassified",
    });
    expect(unreadable.sent).toHaveLength(1);
  });
});
