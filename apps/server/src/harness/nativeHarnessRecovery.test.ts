import type { NativeHarnessSessionView, Project } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  nativeHarnessRecoveryBlockers,
  type NativeHarnessRecoveryFacts,
} from "./nativeHarnessRecovery";

const root = "/Users/me/work/reports";

function view(mode: "code" | "work", projectId?: string): NativeHarnessSessionView {
  return {
    session: {
      threadId: "00000000-0000-4000-8000-000000000020",
      mode,
      ...(projectId === undefined ? {} : { projectId }),
      lead: { providerInstanceId: "00000000-0000-4000-8000-000000000001" },
    },
  } as never;
}

function facts(overrides: Partial<NativeHarnessRecoveryFacts> = {}): NativeHarnessRecoveryFacts {
  return {
    providerInstance: () => ({ enabled: true }),
    codeCheckout: () => ({ availability: "available" }),
    project: () =>
      ({ type: "work", lifecycle: "active", binding: { canonicalRoot: root } }) as never as Project,
    directory: async (path) => path,
    ...overrides,
  };
}

describe("what stands between a restart's recovery and a resume", () => {
  it("lets a Code thread resume only once its checkout has been confirmed since the restart", async () => {
    expect(await nativeHarnessRecoveryBlockers(facts(), view("code"))).toEqual([]);
    expect(
      await nativeHarnessRecoveryBlockers(
        facts({ codeCheckout: () => ({ availability: "waiting" }) }),
        view("code"),
      ),
    ).toEqual([expect.stringContaining("has not been checked since the restart")]);
    expect(
      await nativeHarnessRecoveryBlockers(facts({ codeCheckout: () => undefined }), view("code")),
    ).toEqual(["The thread's checkout is no longer available."]);
  });

  it("refuses a Work thread whose folder is gone or now resolves somewhere else", async () => {
    const work = view("work", "00000000-0000-4000-8000-000000000030");
    expect(await nativeHarnessRecoveryBlockers(facts(), work)).toEqual([]);
    expect(
      await nativeHarnessRecoveryBlockers(facts({ directory: async () => undefined }), work),
    ).toEqual(["The Work Project's folder is missing or has moved."]);
    expect(
      await nativeHarnessRecoveryBlockers(
        facts({ directory: async () => "/Users/me/elsewhere" }),
        work,
      ),
    ).toEqual(["The Work Project's folder is missing or has moved."]);
  });

  it("names a model endpoint that was removed or turned off", async () => {
    expect(
      await nativeHarnessRecoveryBlockers(
        facts({ providerInstance: () => ({ enabled: false }) }),
        view("code"),
      ),
    ).toEqual([expect.stringContaining("turned off")]);
  });
});
