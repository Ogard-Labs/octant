import { describe, expect, it, vi } from "vitest";
import { createDesktopClientLifetime } from "./desktopClientLifetime";

function fixture() {
  let count = 1;
  const closeLocalWindows = vi.fn(async (): Promise<"closed" | "failed"> => "closed");
  const quitHost = vi.fn(
    async (_stillRequested: () => boolean): Promise<"accepted" | "cancelled"> => "accepted",
  );
  const lifetime = createDesktopClientLifetime({
    currentNightlyWindows: () => count,
    closeLocalWindows,
    quitHost,
  });
  return {
    lifetime,
    closeLocalWindows,
    quitHost,
    count: (next: number) => {
      count = next;
      lifetime.nightlyWindowsChanged();
    },
  };
}

describe("shared desktop client lifetime", () => {
  it("closes local windows while another client retains the host, then confirms the final exit once", async () => {
    const f = fixture();
    expect(await f.lifetime.requestLocalQuit()).toBe("retained");
    expect(f.closeLocalWindows).toHaveBeenCalledOnce();
    expect(f.quitHost).not.toHaveBeenCalled();
    f.count(0);
    f.count(0);
    await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledOnce());
    expect(await f.lifetime.reopen()).toBe(false);
  });

  it("leaves the host available when its last-client active-work confirmation is cancelled", async () => {
    const f = fixture();
    f.quitHost.mockResolvedValue("cancelled");
    await f.lifetime.requestLocalQuit();
    f.count(0);
    await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledOnce());
    expect(await f.lifetime.reopen()).toBe(true);
    expect(f.quitHost).toHaveBeenCalledOnce();
  });

  it("invalidates pending local openings and a queued final exit when the person reopens during close", async () => {
    const f = fixture();
    const oldAdmission = f.lifetime.localWindowAdmission();
    let finish = () => {};
    f.closeLocalWindows.mockImplementationOnce(
      () =>
        new Promise<"closed">((resolve) => {
          finish = () => resolve("closed");
        }),
    );
    const closing = f.lifetime.requestLocalQuit();
    f.count(0);
    const reopening = f.lifetime.reopen();
    expect(oldAdmission()).toBe(false);
    finish();
    await closing;
    expect(await reopening).toBe(true);
    expect(f.lifetime.localWindowAdmission()()).toBe(true);
    expect(f.quitHost).not.toHaveBeenCalled();
  });

  it("does not close local windows or retain an absent client", async () => {
    const f = fixture();
    f.count(0);
    expect(await f.lifetime.requestLocalQuit()).toBe("quit-required");
    expect(f.closeLocalWindows).not.toHaveBeenCalled();
    expect(f.quitHost).not.toHaveBeenCalled();
  });

  it("keeps a refused local close from becoming a host exit", async () => {
    const f = fixture();
    f.closeLocalWindows.mockResolvedValueOnce("failed");
    expect(await f.lifetime.requestLocalQuit()).toBe("failed");
    f.count(0);
    expect(f.quitHost).not.toHaveBeenCalled();
    expect(await f.lifetime.reopen()).toBe(true);
  });

  it("bounds first-client headless waiting without extending the deadline for empty notifications", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.count(0);
    try {
      f.lifetime.waitForFirstNightlyWindow();
      await vi.advanceTimersByTimeAsync(29_000);
      f.count(0);
      expect(f.quitHost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.quitHost).toHaveBeenCalledOnce();
    } finally {
      f.lifetime.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels headless grace for a real client and uses its final departure instead", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.count(0);
    try {
      f.lifetime.waitForFirstNightlyWindow();
      f.count(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.quitHost).not.toHaveBeenCalled();
      f.count(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.quitHost).toHaveBeenCalledOnce();
    } finally {
      f.lifetime.dispose();
      vi.useRealTimers();
    }
  });
});

it("does not invalidate an ordinary pending window when another ordinary reopen arrives", async () => {
  const f = fixture();
  const admitted = f.lifetime.localWindowAdmission();
  expect(await f.lifetime.reopen()).toBe(true);
  expect(await f.lifetime.reopen()).toBe(true);
  expect(admitted()).toBe(true);
});

it("withdraws a conditional last-client quit when a new client arrives during confirmation", async () => {
  const f = fixture();
  let confirm = () => {};
  let stops = 0;
  f.quitHost.mockImplementationOnce(async (stillRequested?: () => boolean) => {
    await new Promise<void>((resolve) => {
      confirm = resolve;
    });
    if (stillRequested !== undefined && !stillRequested()) return "cancelled";
    stops++;
    return "accepted";
  });
  await f.lifetime.requestLocalQuit();
  f.count(0);
  await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledOnce());
  f.count(1);
  confirm();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stops).toBe(0);
  expect(await f.lifetime.reopen()).toBe(true);
});

it("lets ordinary reopen withdraw a last-client quit before its confirmation is accepted", async () => {
  const f = fixture();
  let confirm = () => {};
  let stops = 0;
  f.quitHost.mockImplementationOnce(async (stillRequested?: () => boolean) => {
    await new Promise<void>((resolve) => {
      confirm = resolve;
    });
    if (stillRequested !== undefined && !stillRequested()) return "cancelled";
    stops++;
    return "accepted";
  });
  await f.lifetime.requestLocalQuit();
  f.count(0);
  await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledOnce());
  const reopening = f.lifetime.reopen();
  confirm();
  expect(await reopening).toBe(true);
  expect(stops).toBe(0);
});

it("reevaluates an empty retained host after a new client comes and goes during the older confirmation", async () => {
  const f = fixture();
  let confirm = () => {};
  f.quitHost.mockImplementationOnce(async (stillRequested?: () => boolean) => {
    await new Promise<void>((resolve) => {
      confirm = resolve;
    });
    return stillRequested?.() === false ? "cancelled" : "accepted";
  });
  await f.lifetime.requestLocalQuit();
  f.count(0);
  await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledOnce());
  f.count(1);
  f.count(0);
  confirm();
  await vi.waitFor(() => expect(f.quitHost).toHaveBeenCalledTimes(2));
});

it("shows the window a reopen asks for when a quit retired the opening it joined", async () => {
  const f = fixture();
  let construct = () => {};
  const constructed = new Promise<void>((resolve) => {
    construct = resolve;
  });
  const admissions: boolean[] = [];
  const create = vi.fn(async (stillRequested: () => boolean) => {
    await constructed;
    admissions.push(stillRequested());
    if (!stillRequested()) throw new Error("replaced");
  });
  const opening = f.lifetime.openLocalWindow(create);
  expect(await f.lifetime.requestLocalQuit()).toBe("retained");
  expect(await f.lifetime.reopen()).toBe(true);
  construct();
  await opening;
  expect(admissions).toEqual([false, true]);
});

it("keeps a host-only launch from waiting for Nightly once the person reopens Stable during host startup", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.count(0);
  try {
    const waitForFirstNightlyWindow = f.lifetime.firstNightlyWindowWait();
    expect(await f.lifetime.reopen()).toBe(true);
    waitForFirstNightlyWindow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.quitHost).not.toHaveBeenCalled();
    expect(f.lifetime.localWindowAdmission()()).toBe(true);
  } finally {
    f.lifetime.dispose();
    vi.useRealTimers();
  }
});
