import { describe, expect, it } from "vitest";
import { parseCodeDeepLink } from "./codeDeepLinks";

const ids = {
  project: "10000000-0000-4000-8000-000000000001",
  thread: "20000000-0000-4000-8000-000000000001",
  checkout: "30000000-0000-4000-8000-000000000001",
  file: "40000000-0000-4000-8000-000000000001",
  test: "50000000-0000-4000-8000-000000000001",
};

describe("parseCodeDeepLink", () => {
  it.each([
    [`octant://code/project/${ids.project}`, { kind: "project", projectId: ids.project }],
    [`octant://code/thread/${ids.thread}`, { kind: "thread", threadId: ids.thread }],
    [
      `octant://code/file/${ids.thread}/${ids.checkout}/${ids.file}?path=src%2Fapp.ts&line=12&column=4`,
      {
        kind: "file",
        threadId: ids.thread,
        checkoutId: ids.checkout,
        fileId: ids.file,
        relativePath: "src/app.ts",
        line: 12,
        column: 4,
      },
    ],
    [
      `octant://code/diff/${ids.thread}/${ids.checkout}`,
      { kind: "diff", threadId: ids.thread, checkoutId: ids.checkout },
    ],
    [
      `octant://code/test/${ids.thread}/${ids.test}`,
      { kind: "test", threadId: ids.thread, testRunId: ids.test },
    ],
    [
      `octant://code/new?projectId=${ids.project}&checkoutId=${ids.checkout}`,
      { kind: "new-thread", projectId: ids.project, checkoutId: ids.checkout },
    ],
  ])("accepts the strict Code route %s", (url, expected) => {
    expect(parseCodeDeepLink(url)).toEqual(expected);
  });

  it.each([
    "https://code/thread/20000000-0000-4000-8000-000000000001",
    "octant://chat/thread/20000000-0000-4000-8000-000000000001",
    `octant://code/thread/${ids.thread}?prompt=do+it`,
    `octant://code/new?projectId=${ids.project}&checkoutId=${ids.checkout}&access=full-access`,
    `octant://code/file/${ids.thread}/${ids.checkout}/${ids.file}?path=src%2Fapp.ts&line=0&column=1`,
    `octant://code/file/${ids.thread}/${ids.checkout}/${ids.file}?path=src%2Fapp.ts&line=1&line=2&column=1`,
    `octant://code/file/${ids.thread}/${ids.checkout}/${ids.file}?path=..%2Fsecret&line=1&column=1`,
    `octant://code/thread/not-a-uuid`,
    "octant://code/new",
  ])("rejects non-canonical or authority-bearing input %s", (url) => {
    expect(() => parseCodeDeepLink(url)).toThrow("invalid Code deep link");
  });
});
