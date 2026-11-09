import { describe, expect, it } from "vitest";
import { createServerResourceRoutes } from "./serverResourceRoutes";

describe("the server resources route", () => {
  it("refuses a caller with no window capability and leaks no figures", async () => {
    let asked = false;
    const routes = createServerResourceRoutes({
      windows: { resolve: () => undefined } as never,
      readerFor: () => {
        asked = true;
        return undefined;
      },
    });
    const response = await routes(
      new Request("http://127.0.0.1/api/server-projects/resources?projectId=p"),
    );
    expect(response?.status).toBe(401);
    expect(asked).toBe(false);
  });

  it("ignores other paths", async () => {
    const routes = createServerResourceRoutes({
      windows: {} as never,
      readerFor: () => undefined,
    });
    expect(await routes(new Request("http://127.0.0.1/api/other"))).toBeUndefined();
  });
});
