import { decodeTodoCommand } from "@octant/contracts/todos";
import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { changeMobileTodos, readMobileTodos } from "./mobileTodoClient";

const list = {
  kind: "todo-list",
  hostId: "11111111-1111-4111-8111-111111111111",
  todos: [],
};

function transport(reply: () => Promise<Response>): MobileRemoteTransport & {
  readonly authenticatedFetch: ReturnType<typeof vi.fn>;
} {
  return { hostId: "host", authenticatedFetch: vi.fn(reply) };
}

describe("the phone's to-do client", () => {
  it("reads the list and sends a change over the paired session", async () => {
    const port = transport(async () => Response.json(list));
    expect(await readMobileTodos(port)).toMatchObject({ status: "loaded" });
    await changeMobileTodos(
      port,
      decodeTodoCommand({
        kind: "add-todo",
        todoId: "00000000-0000-4000-8000-000000000001",
        title: "Buy milk",
      }),
    );
    expect(port.authenticatedFetch).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/todos",
    });
    expect(port.authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "POST",
        path: "/api/todos/commands",
        contentType: "application/json",
      }),
    );
  });

  it("answers a refusal and a dropped connection as values", async () => {
    const refused = transport(async () =>
      Response.json(
        {
          kind: "todo-refused",
          reason: "kept-elsewhere",
          message: "Studio keeps the to-do list, so it is changed there.",
        },
        { status: 409 },
      ),
    );
    expect(await readMobileTodos(refused)).toMatchObject({
      status: "refused",
      refusal: { reason: "kept-elsewhere" },
    });
    const offline = transport(async () => {
      throw new Error("offline");
    });
    expect(await readMobileTodos(offline)).toEqual({ status: "failed", reason: "unreachable" });
  });

  it("tells a revoked pairing apart from a computer out of reach", async () => {
    const revoked = transport(async () =>
      Response.json({ error: "The device credential is no longer valid." }, { status: 401 }),
    );
    expect(await readMobileTodos(revoked)).toEqual({ status: "failed", reason: "signed-out" });
  });
});
