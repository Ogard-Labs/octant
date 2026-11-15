import type { NativeHarnessSlot, NativeHarnessSlotCandidate } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  chooseWorkerModel,
  workerModelHandles,
  workerRolesConfigured,
  type WorkerCandidateFacts,
  type WorkerChoiceFacts,
  type WorkerChoiceRequest,
  type WorkerRoles,
} from "./coordinatorWorkerChoicePolicy";
import { providerAvailabilityFromFailure } from "./providerAvailabilityPolicy";

const host = "00000000-0000-4000-8000-0000000000aa";

function model(provider: string, id: string): NativeHarnessSlotCandidate {
  return { hostId: host, providerInstanceId: provider, modelId: id } as never;
}

const sonnet = model("anthropic", "sonnet");
const opus = model("anthropic", "opus");
const haiku = model("anthropic", "haiku");
const astra = model("openai", "astra");
const glm = model("opencode", "glm");

function slot(
  id: string,
  candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
  flags: Partial<Pick<NativeHarnessSlot, "askBeforeUsing">> = {},
): NativeHarnessSlot {
  return { id: id as never, candidates, ...flags } as NativeHarnessSlot;
}

function roles(
  slots: ReadonlyArray<NativeHarnessSlot>,
  project?: ReadonlyArray<NativeHarnessSlot>,
): WorkerRoles {
  return {
    host: { slots, jobSlots: [] },
    ...(project === undefined ? {} : { project: { slots: project, jobSlots: [] } }),
  };
}

const standard = roles([
  slot("quick", [haiku, glm]),
  slot("default", [sonnet, astra]),
  slot("deep", [opus, astra]),
  slot("slow", [sonnet, astra]),
]);

function facts(
  overrides: Record<string, Partial<WorkerCandidateFacts>> = {},
  seesImagesAvailable = false,
): WorkerChoiceFacts {
  return {
    seesImagesAvailable,
    candidate: (candidate) => ({
      label: String(candidate.modelId),
      providerKind: String(candidate.providerInstanceId),
      allowed: true,
      toolsVerified: true,
      readsImages: true,
      ...overrides[String(candidate.modelId)],
    }),
  };
}

function request(overrides: Partial<WorkerChoiceRequest> = {}): WorkerChoiceRequest {
  return { task: "feature", size: "normal", ...overrides };
}

function picked(choice: ReturnType<typeof chooseWorkerModel>) {
  if (choice.kind === "refused") throw new Error(`refused: ${choice.message}`);
  return choice;
}

describe("chooseWorkerModel", () => {
  it("maps size to Quick edit, Builder and Hard problems, and a review to Reviewer", () => {
    expect(picked(chooseWorkerModel(standard, facts(), request({ size: "quick" })))).toMatchObject({
      kind: "start",
      role: "quick",
      candidate: haiku,
      rank: "main",
    });
    expect(picked(chooseWorkerModel(standard, facts(), request()))).toMatchObject({
      role: "default",
      candidate: sonnet,
    });
    expect(picked(chooseWorkerModel(standard, facts(), request({ size: "hard" })))).toMatchObject({
      role: "deep",
      candidate: opus,
    });
    expect(
      picked(chooseWorkerModel(standard, facts(), request({ task: "review", size: "quick" }))),
    ).toMatchObject({ role: "slow", candidate: sonnet });
  });

  it("sends a high-risk review to Hard problems", () => {
    expect(
      picked(chooseWorkerModel(standard, facts(), request({ task: "review", risk: "high" }))),
    ).toMatchObject({ role: "deep", candidate: opus });
  });

  it("uses Builder's list when the asked role is empty, and says so", () => {
    const choice = picked(
      chooseWorkerModel(roles([slot("default", [sonnet])]), facts(), request({ size: "hard" })),
    );
    expect(choice).toMatchObject({ role: "default", candidate: sonnet, rank: "main" });
    expect(choice.reason).toContain("Hard problems has no models");
  });

  it("lets a Project's role choice win over Settings", () => {
    const choice = picked(
      chooseWorkerModel(
        roles([slot("default", [sonnet, astra])], [slot("default", [astra])]),
        facts(),
        request(),
      ),
    );
    expect(choice.candidate).toEqual(astra);
    expect(choice.rank).toBe("main");
  });

  it("starts the first ready fallback when the main model is at its usage limit and records why", () => {
    const choice = picked(
      chooseWorkerModel(
        standard,
        facts({ sonnet: { usageLimit: { until: "2026-11-15T14:00:00.000Z" } } }),
        request(),
      ),
    );
    expect(choice).toMatchObject({ candidate: astra, rank: { fallback: 1 } });
    expect(choice.reason).toBe("main sonnet at usage limit until 14:00 UTC");
  });

  it("filters every hard rule: signed out, down, not offered, not allowed, unverified tools", () => {
    const blocked: ReadonlyArray<[Partial<WorkerCandidateFacts>, string]> = [
      [{ notReady: "not-signed-in" }, "not-signed-in"],
      [{ notReady: "provider-down" }, "provider-down"],
      [{ notReady: "model-not-offered" }, "model-not-offered"],
      [{ allowed: false }, "not-allowed"],
      [{ toolsVerified: false }, "tools-not-verified"],
    ];
    for (const [fact, reason] of blocked) {
      const choice = picked(chooseWorkerModel(standard, facts({ sonnet: fact }), request()));
      expect(choice.candidate).toEqual(astra);
      expect(choice.passedOver).toEqual([
        { candidate: sonnet, role: "default", reasons: [reason] },
      ]);
    }
  });

  it("drops a model that cannot read images when images are needed and Sees images is empty", () => {
    const blind = facts({ sonnet: { readsImages: false } });
    expect(
      picked(chooseWorkerModel(standard, blind, request({ needsImages: true }))).candidate,
    ).toEqual(astra);
    expect(picked(chooseWorkerModel(standard, blind, request())).candidate).toEqual(sonnet);
    const withSeesImages = facts({ sonnet: { readsImages: false } }, true);
    expect(
      picked(chooseWorkerModel(standard, withSeesImages, request({ needsImages: true }))).candidate,
    ).toEqual(sonnet);
  });

  it("keeps a review off the reviewed worker's provider while another provider is left", () => {
    const choice = picked(
      chooseWorkerModel(
        standard,
        facts(),
        request({ task: "review", reviewedProviderKind: "anthropic" }),
      ),
    );
    expect(choice.candidate).toEqual(astra);
    expect(choice.passedOver[0]?.reasons).toEqual(["same-provider-as-reviewed"]);
    const onlySame = picked(
      chooseWorkerModel(
        standard,
        facts({ astra: { notReady: "provider-down" } }),
        request({ task: "review", reviewedProviderKind: "anthropic" }),
      ),
    );
    expect(onlySame.candidate).toEqual(sonnet);
  });

  it("climbs one tier for a retry and never goes down", () => {
    expect(
      picked(
        chooseWorkerModel(
          standard,
          facts(),
          request({ size: "quick", retries: { role: "quick" } }),
        ),
      ).role,
    ).toBe("default");
    expect(
      picked(
        chooseWorkerModel(
          standard,
          facts(),
          request({ size: "quick", retries: { role: "default" } }),
        ),
      ).role,
    ).toBe("deep");
    expect(
      picked(
        chooseWorkerModel(standard, facts(), request({ size: "quick", retries: { role: "deep" } })),
      ).role,
    ).toBe("deep");
    expect(
      picked(chooseWorkerModel(standard, facts(), request({ size: "quick", retries: {} }))).role,
    ).toBe("deep");
    const down = chooseWorkerModel(
      standard,
      facts(),
      request({ retries: { role: "default" }, role: "quick-edit", why: "cheap" }),
    );
    expect(down).toMatchObject({ kind: "refused", reason: "policy" });
  });

  it("borrows the next tier when the whole list is unavailable", () => {
    const choice = picked(
      chooseWorkerModel(
        standard,
        facts({ haiku: { notReady: "provider-down" }, glm: { usageLimit: {} } }),
        request({ size: "quick" }),
      ),
    );
    expect(choice).toMatchObject({
      role: "quick",
      candidate: sonnet,
      rank: { borrowed: "default" },
    });
    expect(choice.passedOver.map((verdict) => verdict.candidate)).toEqual([haiku, glm]);
  });

  it("borrows Builder for Hard problems and flags the lower tier", () => {
    const choice = picked(
      chooseWorkerModel(
        roles([slot("default", [sonnet]), slot("deep", [opus])]),
        facts({ opus: { usageLimit: {} } }),
        request({ size: "hard" }),
      ),
    );
    expect(choice).toMatchObject({
      role: "deep",
      candidate: sonnet,
      rank: { borrowed: "default", lowerTier: true },
    });
    expect(choice.reason).toContain("lower tier: all Hard problems models unavailable");
  });

  it("refuses with every reason when nothing is left anywhere", () => {
    const down = Object.fromEntries(
      ["sonnet", "astra", "opus"].map((id) => [id, { notReady: "provider-down" as const }]),
    );
    const choice = chooseWorkerModel(standard, facts(down), request());
    expect(choice.kind).toBe("refused");
    if (choice.kind !== "refused") return;
    expect(choice.reason).toBe("no-eligible-model");
    expect(choice.perCandidate.map((verdict) => verdict.candidate)).toEqual([
      sonnet,
      astra,
      opus,
      astra,
    ]);
  });

  it("refuses any override without a why", () => {
    expect(chooseWorkerModel(standard, facts(), request({ role: "hard-problems" }))).toMatchObject({
      kind: "refused",
      reason: "policy",
    });
    expect(chooseWorkerModel(standard, facts(), request({ model: "b1" }))).toMatchObject({
      kind: "refused",
      reason: "policy",
    });
  });

  it("starts an explicit role with its why", () => {
    expect(
      picked(
        chooseWorkerModel(
          standard,
          facts(),
          request({ role: "hard-problems", why: "cross-package" }),
        ),
      ),
    ).toMatchObject({ role: "deep", candidate: opus });
  });

  it("starts a named model only when it passes the filter, and refuses it with its reasons", () => {
    const handles = workerModelHandles(standard);
    expect(handles.map((entry) => entry.handle)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    const astraHandle = handles.find((entry) => entry.candidate === astra)?.handle;
    expect(
      picked(
        chooseWorkerModel(standard, facts(), request({ model: astraHandle, why: "long context" })),
      ),
    ).toMatchObject({ candidate: astra, rank: "chosen" });
    const refused = chooseWorkerModel(
      standard,
      facts({ astra: { usageLimit: {} } }),
      request({ model: astraHandle, why: "long context" }),
    );
    expect(refused).toMatchObject({
      kind: "refused",
      reason: "model-not-eligible",
      perCandidate: [{ candidate: astra, reasons: ["at-usage-limit"] }],
    });
    expect(chooseWorkerModel(standard, facts(), request({ model: "b99", why: "x" }))).toMatchObject(
      { kind: "refused", reason: "model-not-eligible" },
    );
  });

  it("turns a start in an ask-first role into a proposal, a retry that climbs into one included", () => {
    const asking = roles([
      slot("quick", [haiku]),
      slot("default", [sonnet]),
      slot("deep", [opus], { askBeforeUsing: true }),
    ]);
    expect(chooseWorkerModel(asking, facts(), request({ size: "hard" })).kind).toBe("propose");
    expect(chooseWorkerModel(asking, facts(), request()).kind).toBe("start");
    expect(chooseWorkerModel(asking, facts(), request({ retries: { role: "default" } })).kind).toBe(
      "propose",
    );
  });

  it("never returns a model outside the roles", () => {
    const listed = new Set(
      standard.host.slots.flatMap((entry) => entry.candidates.map((c) => String(c.modelId))),
    );
    const sizes = ["quick", "normal", "hard"] as const;
    const tasks = ["small-fix", "feature", "ui", "tests", "docs", "review"] as const;
    for (const size of sizes) {
      for (const task of tasks) {
        for (const down of [{}, { sonnet: { notReady: "provider-down" as const } }]) {
          const choice = chooseWorkerModel(standard, facts(down), request({ size, task }));
          if (choice.kind !== "refused")
            expect(listed.has(String(choice.candidate.modelId))).toBe(true);
        }
      }
    }
  });

  it("reads roles as configured only when Builder has a model", () => {
    expect(workerRolesConfigured(standard)).toBe(true);
    expect(workerRolesConfigured(roles([slot("deep", [opus])]))).toBe(false);
    expect(workerRolesConfigured(roles([], [slot("default", [sonnet])]))).toBe(true);
  });
});

describe("providerAvailabilityFromFailure", () => {
  it("reads a usage limit until its reset and an unavailable or overloaded provider as down", () => {
    expect(
      providerAvailabilityFromFailure({
        category: "rate-limited",
        usageLimit: { kind: "exhausted", resetsAt: "2026-11-15T14:00:00.000Z" as never },
      }),
    ).toEqual({ kind: "usage-limit", until: "2026-11-15T14:00:00.000Z" });
    expect(providerAvailabilityFromFailure({ category: "unavailable" })).toEqual({ kind: "down" });
    expect(providerAvailabilityFromFailure({ category: "rate-limited" })).toEqual({ kind: "down" });
    expect(providerAvailabilityFromFailure({ category: "unauthenticated" })).toBeUndefined();
    expect(providerAvailabilityFromFailure({ category: "provider-failed" })).toBeUndefined();
  });
});
