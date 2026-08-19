import { CodeFileListingClientFailure } from "@octant/client-runtime";
import type { CodeCheckoutId, CodeFileChangeNotice, CodeThreadId } from "@octant/contracts";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeTouches, useCodeFileChangeWatch } from "./useCodeFileChangeWatch";

const threadId = "00000000-0000-4000-8000-000000000903" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000902" as unknown as CodeCheckoutId;

/** A watch that ends the same way every time it is opened. */
function watchThat(end: "drops" | "is-refused") {
  return vi.fn(async function* () {
    if (end === "is-refused") {
      throw new CodeFileListingClientFailure("The host refused this Code file watch.", 401);
    }
  });
}

function watching(watch: ReturnType<typeof watchThat>) {
  return renderHook(() =>
    useCodeFileChangeWatch({
      checkoutId,
      client: { watch: watch as never },
      enabled: true,
      onChanged: () => undefined,
      threadId,
    }),
  );
}

function notice(
  paths: ReadonlyArray<string>,
  truncated = false,
): Pick<CodeFileChangeNotice, "paths" | "truncated"> {
  return { paths: paths as never, truncated };
}

describe("useCodeFileChangeWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens a dropped watch", async () => {
    const dropped = watchThat("drops");
    const { unmount } = watching(dropped);

    await vi.advanceTimersByTimeAsync(0);
    expect(dropped).toHaveBeenCalledOnce();

    // A watcher the filesystem or the connection dropped comes back, because
    // stopping would leave the surface stale with no sign that it had.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dropped.mock.calls.length).toBeGreaterThan(1);
    unmount();
  });

  it("never reopens a watch the host refused", async () => {
    const refused = watchThat("is-refused");
    const { unmount } = watching(refused);

    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledOnce();

    // A refusal is the host's answer, not a broken connection: asking again
    // would only be refused again, so the retry timer never runs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refused).toHaveBeenCalledOnce();
    unmount();
  });
});

describe("noticeTouches", () => {
  it("treats a truncated notice as concerning every path", () => {
    expect(noticeTouches(notice([], true) as CodeFileChangeNotice, "src/index.ts")).toBe(true);
  });

  it("matches the named file and files under a named directory", () => {
    expect(noticeTouches(notice(["src/index.ts"]) as CodeFileChangeNotice, "src/index.ts")).toBe(
      true,
    );
    expect(noticeTouches(notice(["src"]) as CodeFileChangeNotice, "src/index.ts")).toBe(true);
  });

  it("does not treat a sibling prefix as the same directory", () => {
    expect(noticeTouches(notice(["src"]) as CodeFileChangeNotice, "src2/index.ts")).toBe(false);
    expect(noticeTouches(notice(["README.md"]) as CodeFileChangeNotice, "src/index.ts")).toBe(
      false,
    );
  });
});
