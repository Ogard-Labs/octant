import { describe, expect, it } from "vitest";
import {
  decodeToolActionAuthority,
  decodeToolActionCancellation,
  decodeToolActionRequest,
} from "@octant/contracts";
import { authorizeToolAction, canRequestToolCancellation } from "./toolActionPolicy";

const authority = decodeToolActionAuthority({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  projectId: "22222222-2222-4222-8222-222222222222",
  rootId: "33333333-3333-4333-8333-333333333333",
  worktreeId: "44444444-4444-4444-8444-444444444444",
  providerInstanceId: "55555555-5555-4555-8555-555555555555",
  extension: { kind: "core" },
});

const request = decodeToolActionRequest({
  actionId: "66666666-6666-4666-8666-666666666666",
  correlationId: "77777777-7777-4777-8777-777777777777",
  capability: { id: "repository-validation", version: 1 },
  authority,
  intent: "Run validation.",
  approval: { kind: "not-required" },
});

describe("tool action authority", () => {
  it("allows only an exact host, mode, project, root, worktree, provider, and extension scope", () => {
    expect(authorizeToolAction(request, authority)).toEqual({ kind: "allowed" });
    expect(
      authorizeToolAction(
        request,
        decodeToolActionAuthority({
          ...authority,
          projectId: "88888888-8888-4888-8888-888888888888",
        }),
      ),
    ).toEqual({ kind: "unauthorized", reason: "project-mismatch" });
    expect(
      authorizeToolAction(
        request,
        decodeToolActionAuthority({
          ...authority,
          extension: {
            kind: "trusted-extension",
            extensionId: "99999999-9999-4999-8999-999999999999",
          },
        }),
      ),
    ).toEqual({ kind: "unauthorized", reason: "extension-mismatch" });
  });
});

describe("tool action correlation", () => {
  it("accepts cancellation only when action, correlation, and authority all match", () => {
    expect(
      canRequestToolCancellation(
        request,
        decodeToolActionCancellation({
          actionId: request.actionId,
          correlationId: request.correlationId,
          authority,
          reason: "user-requested",
        }),
      ),
    ).toBe(true);
    expect(
      canRequestToolCancellation(
        request,
        decodeToolActionCancellation({
          actionId: request.actionId,
          correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          authority,
          reason: "user-requested",
        }),
      ),
    ).toBe(false);
  });
});
