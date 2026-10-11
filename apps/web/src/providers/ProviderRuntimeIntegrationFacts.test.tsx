import type { ProviderModelId, ProviderRuntimeIntegration } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderRuntimeIntegrationFacts } from "./ProviderRuntimeIntegrationFacts";

const sessionActivity = {
  source: "session",
  observes: ["replies", "tool-calls", "approvals"],
} as const;

function renderFacts(
  integration: ProviderRuntimeIntegration | undefined,
  verifiedToolModelIds?: ReadonlyArray<string>,
) {
  render(
    <ProviderRuntimeIntegrationFacts
      instanceId="runtime"
      observed={{
        ...(integration === undefined ? {} : { integration }),
        ...(verifiedToolModelIds === undefined
          ? {}
          : { verifiedToolModelIds: verifiedToolModelIds as ReadonlyArray<ProviderModelId> }),
      }}
    />,
  );
}

function fact(label: string): HTMLElement {
  const section = screen.getByRole("region", { name: "Integration" });
  const term = within(section).getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`No value for ${label}`);
  return value;
}

describe("provider runtime integration facts", () => {
  it("names the transport Octant's tools reach the session through", () => {
    renderFacts({
      tools: { status: "available", transport: "session-mcp-bridge" },
      activity: sessionActivity,
      resume: "precise",
    });
    expect(fact("Octant tools")).toHaveTextContent(
      "AvailableThrough a loopback MCP server registered for each session.",
    );
    expect(screen.getByText(/never writes this runtime’s MCP or hook configuration/)).toBeVisible();
  });

  it("says tools are not available on a runtime that did not confirm its transport, and why", () => {
    renderFacts({
      tools: {
        status: "unavailable",
        transport: "session-mcp-bridge",
        reason: "runtime-not-confirmed",
      },
      activity: sessionActivity,
      resume: "precise",
    });
    const tools = fact("Octant tools");
    expect(tools).toHaveTextContent("Not available on this runtime");
    expect(tools).toHaveTextContent(
      "This runtime’s version, platform, or setup did not confirm a loopback MCP server registered for each session.",
    );
    expect(tools).toHaveTextContent("Browser and Computer cannot be used here.");
  });

  it("says a runtime Octant has no tool transport to cannot use Browser or Computer", () => {
    renderFacts({
      tools: { status: "unavailable", reason: "no-transport" },
      activity: sessionActivity,
      resume: "best-effort",
    });
    expect(fact("Octant tools")).toHaveTextContent(
      "Octant has no way to offer its tools to this runtime. Browser and Computer cannot be used here.",
    );
  });

  it("says an unconfirmed check established nothing about tools", () => {
    renderFacts({
      tools: { status: "unavailable", transport: "sdk-tool-server", reason: "not-confirmed" },
      activity: { source: "none" },
      resume: "precise",
    });
    expect(fact("Octant tools")).toHaveTextContent(
      "The last connection check did not confirm them.",
    );
  });

  it("asks for a verified model before an endpoint gets tools, and counts the verified ones", () => {
    const unverified = {
      tools: {
        status: "unavailable",
        transport: "request-tool-calls",
        reason: "model-verification-required",
      },
      activity: sessionActivity,
      resume: "best-effort",
    } as const;
    renderFacts(unverified);
    expect(fact("Octant tools")).toHaveTextContent(
      "Not available on this runtimeVerify a model’s tools to offer them.",
    );
    document.body.innerHTML = "";

    renderFacts(unverified, ["model-a", "model-b"]);
    expect(fact("Octant tools")).toHaveTextContent(
      "Verified models only2 verified models, through tool calls in each request. Other models are Chat only, without Browser or Computer.",
    );
  });

  it("lists what a live session reports, or that nothing is observed", () => {
    renderFacts({
      tools: { status: "available", transport: "app-server-dynamic-tools" },
      activity: sessionActivity,
      resume: "precise",
    });
    expect(fact("Activity")).toHaveTextContent(
      "Session eventsReplies, tool calls, and approvals, as the live session reports them.",
    );
    document.body.innerHTML = "";

    renderFacts({
      tools: { status: "unavailable", reason: "no-transport" },
      activity: { source: "none" },
      resume: "none",
    });
    expect(fact("Activity")).toHaveTextContent(
      "Nothing observedNo session runs on this runtime here.",
    );
  });

  it("states each resume quality", () => {
    const base = {
      tools: { status: "available", transport: "request-tool-calls" },
      activity: sessionActivity,
    } as const;
    renderFacts({ ...base, resume: "precise" });
    expect(fact("Resume")).toHaveTextContent(
      "PreciseA follow-up reopens the runtime’s own session.",
    );
    document.body.innerHTML = "";

    renderFacts({ ...base, resume: "best-effort" });
    expect(fact("Resume")).toHaveTextContent(
      "Best effortThe endpoint keeps no session, so Octant sends the thread’s history again",
    );
    document.body.innerHTML = "";

    renderFacts({ ...base, resume: "none" });
    expect(fact("Resume")).toHaveTextContent("NoneThis runtime cannot reopen an earlier session.");
  });

  it("claims nothing when the server reported no integration", () => {
    renderFacts(undefined);
    expect(screen.queryByRole("region", { name: "Integration" })).not.toBeInTheDocument();
  });
});
