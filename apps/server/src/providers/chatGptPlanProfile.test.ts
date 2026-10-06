import { describe, expect, it } from "vitest";
import {
  CHATGPT_PLAN_FORBIDDEN_FIELDS,
  chatGptPlanErrorFailure,
  chatGptPlanErrorState,
  chatGptPlanRefusalFailure,
  inspectChatGptPlanRequestBody,
  isChatGptPlanDescriptor,
} from "./chatGptPlanProfile";

function validBody(): Record<string, unknown> {
  return {
    model: "gpt-5",
    store: false,
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    instructions: "You are helpful.",
    tools: [{ type: "function", name: "lookup", description: "Look up", parameters: {} }],
  };
}

describe("isChatGptPlanDescriptor", () => {
  it("selects the plan profile only for the plan descriptor id", () => {
    expect(isChatGptPlanDescriptor("chatgpt-plan")).toBe(true);
    expect(isChatGptPlanDescriptor("openrouter")).toBe(false);
    expect(isChatGptPlanDescriptor(undefined)).toBe(false);
  });
});

describe("inspectChatGptPlanRequestBody", () => {
  it("accepts a body that satisfies the plan wire contract", () => {
    expect(inspectChatGptPlanRequestBody(validBody())).toBeUndefined();
  });

  it("refuses every forbidden field with a typed reason", () => {
    for (const field of CHATGPT_PLAN_FORBIDDEN_FIELDS) {
      const body = { ...validBody(), [field]: field === "temperature" ? 0.7 : "x" };
      expect(inspectChatGptPlanRequestBody(body)).toEqual({ kind: "forbidden-field", field });
    }
  });

  it("refuses store other than false", () => {
    expect(inspectChatGptPlanRequestBody({ ...validBody(), store: true })).toEqual({
      kind: "forbidden-field",
      field: "metadata",
    });
    expect(inspectChatGptPlanRequestBody({ ...validBody(), store: undefined })).toEqual({
      kind: "forbidden-field",
      field: "metadata",
    });
  });

  it("refuses stream other than true", () => {
    expect(inspectChatGptPlanRequestBody({ ...validBody(), stream: false })).toEqual({
      kind: "forbidden-field",
      field: "metadata",
    });
  });

  it("refuses a non-array input", () => {
    expect(inspectChatGptPlanRequestBody({ ...validBody(), input: "hi" })).toEqual({
      kind: "forbidden-field",
      field: "metadata",
    });
  });

  it("refuses an explicit system-role message item", () => {
    const body = validBody();
    body.input = [
      { type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] },
    ];
    expect(inspectChatGptPlanRequestBody(body)).toEqual({ kind: "system-message-item" });
  });

  it("accepts developer-role message items", () => {
    const body = validBody();
    body.input = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "sys" }] },
    ];
    expect(inspectChatGptPlanRequestBody(body)).toBeUndefined();
  });

  it("refuses hosted tools with the tool type named", () => {
    const body = validBody();
    body.tools = [{ type: "web_search" }];
    expect(inspectChatGptPlanRequestBody(body)).toEqual({
      kind: "hosted-tool",
      tool: "web_search",
    });
  });

  it("refuses a hosted tool with an unknown type", () => {
    const body = validBody();
    body.tools = [{ name: "mystery" }];
    expect(inspectChatGptPlanRequestBody(body)).toEqual({ kind: "hosted-tool", tool: "unknown" });
  });

  it("refuses a non-record body", () => {
    expect(inspectChatGptPlanRequestBody("nope")).toEqual({
      kind: "forbidden-field",
      field: "metadata",
    });
  });
});

describe("chatGptPlanRefusalFailure", () => {
  it("maps a forbidden field to an unsupported failure naming the field", () => {
    expect(chatGptPlanRefusalFailure({ kind: "forbidden-field", field: "temperature" })).toEqual({
      category: "unsupported",
      message: 'The ChatGPT plan route does not accept the "temperature" parameter.',
    });
  });

  it("maps a hosted tool to an unsupported failure naming the tool", () => {
    const failure = chatGptPlanRefusalFailure({ kind: "hosted-tool", tool: "code_interpreter" });
    expect(failure.category).toBe("unsupported");
    expect(failure.message).toContain("code_interpreter");
  });

  it("maps a system message item to a protocol failure", () => {
    expect(chatGptPlanRefusalFailure({ kind: "system-message-item" }).category).toBe("protocol");
  });

  it("maps plan usage disabled to an unauthorized failure", () => {
    expect(chatGptPlanRefusalFailure({ kind: "plan-usage-disabled" }).category).toBe(
      "unauthorized",
    );
  });
});

describe("chatGptPlanErrorState", () => {
  it("maps the usage limit code to a usage-limit state with the manage-usage link", () => {
    expect(chatGptPlanErrorState("subscription_sharing_usage_limit_exceeded", 429)).toEqual({
      kind: "usage-limit",
      manageUsageUrl: "https://chatgpt.com/settings/usage",
    });
  });

  it("maps the unavailable codes to an unavailable state", () => {
    expect(chatGptPlanErrorState("subscription_sharing_usage_unavailable", 503)).toEqual({
      kind: "unavailable",
    });
    expect(chatGptPlanErrorState("subscription_sharing_user_unavailable", 503)).toEqual({
      kind: "unavailable",
    });
  });

  it("maps the unsupported capability code to a state naming the code", () => {
    expect(chatGptPlanErrorState("subscription_sharing_unsupported_capability", 400)).toEqual({
      kind: "unsupported-capability",
      code: "subscription_sharing_unsupported_capability",
    });
  });

  it("maps the invalid-user and scope codes to unauthenticated", () => {
    expect(chatGptPlanErrorState("subscription_sharing_invalid_user", 401)).toEqual({
      kind: "unauthenticated",
    });
    expect(chatGptPlanErrorState("chatpass_v2_scope_not_authorized", 403)).toEqual({
      kind: "unauthenticated",
    });
    expect(chatGptPlanErrorState("chatpass_v2_invalid_authorization_context", 403)).toEqual({
      kind: "unauthenticated",
    });
  });

  it("maps the not-eligible and route codes to not-eligible", () => {
    expect(chatGptPlanErrorState("subscription_sharing_user_not_eligible", 403)).toEqual({
      kind: "not-eligible",
    });
    expect(chatGptPlanErrorState("subscription_sharing_route_not_supported", 403)).toEqual({
      kind: "not-eligible",
    });
  });

  it("falls back on the HTTP status for unknown codes", () => {
    expect(chatGptPlanErrorState("something_else", 401)).toEqual({ kind: "unauthenticated" });
    expect(chatGptPlanErrorState("something_else", 403)).toEqual({ kind: "unauthenticated" });
    expect(chatGptPlanErrorState("something_else", 503)).toEqual({ kind: "unavailable" });
    expect(chatGptPlanErrorState(undefined, 500)).toEqual({ kind: "unknown" });
  });
});

describe("chatGptPlanErrorFailure", () => {
  it("maps a usage limit to a rate-limited failure with the manage-usage link", () => {
    const failure = chatGptPlanErrorFailure({
      kind: "usage-limit",
      manageUsageUrl: "https://chatgpt.com/settings/usage",
    });
    expect(failure.category).toBe("rate-limited");
    expect(failure.message).toContain("https://chatgpt.com/settings/usage");
  });

  it("maps unavailable to an unavailable failure", () => {
    expect(chatGptPlanErrorFailure({ kind: "unavailable" }).category).toBe("unavailable");
  });

  it("maps unsupported capability to an unsupported failure", () => {
    expect(chatGptPlanErrorFailure({ kind: "unsupported-capability", code: "x" }).category).toBe(
      "unsupported",
    );
  });

  it("maps unauthenticated to an unauthenticated failure", () => {
    expect(chatGptPlanErrorFailure({ kind: "unauthenticated" }).category).toBe("unauthenticated");
  });

  it("maps not-eligible to an unauthorized failure", () => {
    expect(chatGptPlanErrorFailure({ kind: "not-eligible" }).category).toBe("unauthorized");
  });

  it("maps unknown to a provider-failed failure", () => {
    expect(chatGptPlanErrorFailure({ kind: "unknown" }).category).toBe("provider-failed");
  });
});
