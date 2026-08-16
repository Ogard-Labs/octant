import { describe, expect, it } from "vitest";
import {
  WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY,
  classifyPromotionAuthority,
  classifyPromotionTransition,
  detectPromotionContextLeakage,
  isApprovalGatedCodeExecutionPolicy,
  validatePromotionContextAuthority,
} from "./workPromotionPolicy";

const selectedContext = {
  summary: "Refactor the report generator into a small CLI",
  artifactRefs: ["opaque-artifact-token-1"],
} as const;

describe("isApprovalGatedCodeExecutionPolicy", () => {
  it("approves the approval-gated policy", () => {
    expect(isApprovalGatedCodeExecutionPolicy("approval-gated")).toBe(true);
  });

  it("rejects full-access", () => {
    expect(isApprovalGatedCodeExecutionPolicy("full-access")).toBe(false);
  });

  it("rejects plan", () => {
    expect(isApprovalGatedCodeExecutionPolicy("plan")).toBe(false);
  });

  it("exports the required policy constant as approval-gated", () => {
    expect(WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY).toBe("approval-gated");
  });
});

describe("detectPromotionContextLeakage", () => {
  it("reports clean when the canonical root is absent from summary and refs", () => {
    expect(
      detectPromotionContextLeakage({
        summary: "clean summary",
        artifactRefs: ["opaque-artifact-token-1"],
        workCanonicalRoot: "/work",
      }),
    ).toBe("clean");
  });

  it("reports leaked when the canonical root appears in the summary", () => {
    expect(
      detectPromotionContextLeakage({
        summary: "the file at /work/notes.md should move",
        artifactRefs: ["opaque-artifact-token-1"],
        workCanonicalRoot: "/work",
      }),
    ).toBe("leaked");
  });

  it("reports leaked when the canonical root appears in an artifact ref", () => {
    expect(
      detectPromotionContextLeakage({
        summary: "clean summary",
        artifactRefs: ["/work/secrets"],
        workCanonicalRoot: "/work",
      }),
    ).toBe("leaked");
  });

  it("reports clean when no canonical root is supplied", () => {
    expect(
      detectPromotionContextLeakage({
        summary: "clean summary",
        artifactRefs: ["opaque-artifact-token-1"],
      }),
    ).toBe("clean");
  });
});

describe("validatePromotionContextAuthority", () => {
  it("reports clean for a sanitized selection against a known root", () => {
    expect(
      validatePromotionContextAuthority({
        summary: selectedContext.summary,
        artifactRefs: ["opaque-artifact-token-1"],
        workCanonicalRoot: "/work",
      }),
    ).toBe("clean");
  });

  it("reports leaked when the selection summary carries the canonical root", () => {
    expect(
      validatePromotionContextAuthority({
        summary: "see /work/report for the source",
        artifactRefs: ["opaque-artifact-token-1"],
        workCanonicalRoot: "/work",
      }),
    ).toBe("leaked");
  });
});

describe("classifyPromotionTransition", () => {
  it("allows approve from a proposed proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "proposed", transition: "approve" })).toBe(
      "allow",
    );
  });

  it("allows dismiss from a proposed proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "proposed", transition: "dismiss" })).toBe(
      "allow",
    );
  });

  it("allows expire from a proposed proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "proposed", transition: "expire" })).toBe(
      "allow",
    );
  });

  it("denies approve from an already-approved proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "approved", transition: "approve" })).toBe(
      "deny",
    );
  });

  it("denies dismiss from an already-dismissed proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "dismissed", transition: "dismiss" })).toBe(
      "deny",
    );
  });

  it("denies any transition from an expired proposal", () => {
    expect(classifyPromotionTransition({ currentStatus: "expired", transition: "approve" })).toBe(
      "deny",
    );
    expect(classifyPromotionTransition({ currentStatus: "expired", transition: "expire" })).toBe(
      "deny",
    );
  });
});

describe("classifyPromotionAuthority", () => {
  const clean = {
    originProjectType: "work",
    targetProjectType: "code",
    proposedCodeExecutionPolicy: "approval-gated",
    contextLeakage: "clean",
  } as const;

  it("allows a well-formed work-to-code promotion with approval-gated Code", () => {
    expect(classifyPromotionAuthority(clean)).toBe("allow");
  });

  it("denies when the origin is not a Work Project", () => {
    expect(classifyPromotionAuthority({ ...clean, originProjectType: "chat" })).toBe("deny");
  });

  it("denies when the target is not a Code Project", () => {
    expect(classifyPromotionAuthority({ ...clean, targetProjectType: "work" })).toBe("deny");
  });

  it("denies when the proposed Code execution policy is full-access", () => {
    expect(
      classifyPromotionAuthority({ ...clean, proposedCodeExecutionPolicy: "full-access" }),
    ).toBe("deny");
  });

  it("denies when the proposed Code execution policy is plan", () => {
    expect(classifyPromotionAuthority({ ...clean, proposedCodeExecutionPolicy: "plan" })).toBe(
      "deny",
    );
  });

  it("denies when the selected context leaks Work filesystem authority", () => {
    expect(classifyPromotionAuthority({ ...clean, contextLeakage: "leaked" })).toBe("deny");
  });
});
