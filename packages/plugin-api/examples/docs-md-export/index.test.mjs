import { describe, expect, test } from "vitest";
import { createPageHostExportTarget, DEFAULT_API_BASE } from "./index.mjs";

function document(input = {}) {
  const body = input.body ?? "# Launch plan\n";
  return {
    schemaVersion: 1,
    kind: "canvas-export-output",
    format: input.format ?? "markdown",
    title: input.title ?? "Launch plan",
    body,
    metadata: {
      canvasId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
      byteLength: new TextEncoder().encode(body).length,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

function fakeFetch(status, payload, fail = false) {
  const calls = [];
  const fetchImpl = (input, init) => {
    calls.push({ input, init });
    if (fail) return Promise.reject(new Error("network down"));
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  };
  return { calls, fetchImpl };
}

function targetWith(fetchImpl, config = {}) {
  return createPageHostExportTarget({
    targetId: "docs-md-example",
    label: "docs-md (example)",
    fetch: fetchImpl,
    credentialRef: "example-account-key",
    ...config,
  });
}

describe("example page-host export target", () => {
  test("declares its contribution with id, label, and formats", () => {
    const target = createPageHostExportTarget({
      targetId: "docs-md-example",
      label: "docs-md (example)",
    });
    expect(target.contribution).toEqual({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: "docs-md-example",
      label: "docs-md (example)",
      formats: ["markdown"],
    });
  });

  test("describes the unlisted destination on the card", () => {
    const target = createPageHostExportTarget({});
    expect(target.describeDestination().note).toContain("anyone with the link");
  });

  test("refuses a format it did not declare without any network call", async () => {
    const { calls, fetchImpl } = fakeFetch(201, { id: "p1", url: "https://x/" });
    const target = targetWith(fetchImpl, { formats: ["markdown"] });
    const delivery = await target.exportDocument(document({ format: "html" }));
    expect(delivery.kind).toBe("refused");
    expect(delivery.code).toBe("unsupported-format");
    expect(calls).toEqual([]);
  });

  test("posts the rendered document as the person's account and returns the link receipt", async () => {
    const { calls, fetchImpl } = fakeFetch(201, {
      id: "page-1",
      url: "https://docs-md.example/quiet-harbor-7k2pd",
    });
    const target = targetWith(fetchImpl);
    // the plugin uses global fetch; swap it for the fake
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const delivery = await target.exportDocument(document({}));
      expect(delivery).toEqual({
        kind: "receipt",
        receipt: {
          kind: "link",
          href: "https://docs-md.example/quiet-harbor-7k2pd",
          remoteId: "page-1",
        },
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0].input.url).toBe(`${DEFAULT_API_BASE}/pages`);
    expect(calls[0].input.headers.get("x-octant-credential-ref")).toBe("example-account-key");
    expect(calls[0].input.headers.has("authorization")).toBe(false);
    expect((await calls[0].input.json()).title).toBe("Launch plan");
  });

  test("refuses a credential reference without a host fetch port before sending anything", async () => {
    const { calls, fetchImpl } = fakeFetch(201, { url: "https://pages.example/page" });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      expect(
        await createPageHostExportTarget({ credentialRef: "example-account-key" }).exportDocument(
          document(),
        ),
      ).toMatchObject({ kind: "refused", code: "not-connected" });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("maps an unauthorized answer to a typed refusal", async () => {
    const { fetchImpl } = fakeFetch(401, {});
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const delivery = await targetWith(fetchImpl).exportDocument(document({}));
      expect(delivery).toEqual({
        kind: "refused",
        code: "unauthorized",
        message: "The page host refused the API key.",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each([
    "not json",
    "{}",
    '{"url":"javascript:alert(1)"}',
    '{"url":"https://pages.example/page","id":7}',
  ])("refuses an unusable successful response without reporting a link: %s", async (body) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status: 201 });
    try {
      await expect(createPageHostExportTarget({}).exportDocument(document())).resolves.toEqual({
        kind: "refused",
        code: "malformed",
        message: "The page host returned an invalid page receipt.",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("reports an unreadable successful response as unavailable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("truncated"));
          },
        }),
        { status: 201 },
      );
    try {
      await expect(
        createPageHostExportTarget({}).exportDocument(document()),
      ).resolves.toMatchObject({
        kind: "refused",
        code: "unavailable",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("maps a network failure to unavailable", async () => {
    const { fetchImpl } = fakeFetch(0, {}, true);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const delivery = await targetWith(fetchImpl).exportDocument(document({}));
      expect(delivery).toEqual({
        kind: "refused",
        code: "unavailable",
        message: "The page host could not be reached.",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
