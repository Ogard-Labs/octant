import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import PublicEntranceSettingsSection, {
  type PublicEntranceSettingsSectionProps,
} from "./PublicEntranceSettingsSection";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");

type Answer = { readonly status: number; readonly body: unknown };
type Answers = Partial<Record<HubAdministrationOperation, Answer | (() => Answer)>>;

function renderEntrance(answers: Answers, props: Partial<PublicEntranceSettingsSectionProps> = {}) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const hub = {
    hubAdministrationRequest: vi.fn(
      async (operation: HubAdministrationOperation, body?: unknown) => {
        calls.push({ operation, body });
        const answer = answers[operation];
        const value = typeof answer === "function" ? answer() : answer;
        return value ?? { status: 200, body: {} };
      },
    ),
  };
  render(<PublicEntranceSettingsSection hub={hub} now={() => NOW} {...props} />);
  return { calls };
}

const ROWS = [
  "hub-public-entrance",
  "hub-public-funnel",
  "hub-public-standby",
  "hub-visitor-links",
  "hub-webhook-endpoints",
  "hub-device-relay",
];

const landing = (settingId: string) =>
  document.querySelector<HTMLElement>(`[data-setting-id="${settingId}"]`);

describe("Public entrance settings", () => {
  const hubWithEntrance = (publicEntrance: unknown) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [{ memberId: "m-1", name: "Mac mini", role: "hub", owner: false }],
        },
      },
    },
    spoke: { membership: "none" },
    publicEntrance,
  });

  it("is off until the window turns it on, and offers Funnel only once it is open", async () => {
    const user = userEvent.setup();
    const { calls } = renderEntrance({
      status: {
        status: 200,
        body: hubWithEntrance({ enabled: false, listening: false, funnel: { enabled: false } }),
      },
      public: { status: 200, body: { status: "changed", enabled: true } },
    });

    const toggle = await screen.findByRole("switch", { name: "Public entrance" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Tailscale Funnel" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(toggle);
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "public")?.body).toEqual({ enabled: true }),
    );
  });

  it("turns Funnel on at port 443 and shows where the person's own front points", async () => {
    const user = userEvent.setup();
    const { calls } = renderEntrance({
      status: {
        status: 200,
        body: hubWithEntrance({
          enabled: true,
          listening: true,
          address: "http://127.0.0.1:41234",
          funnel: { enabled: false },
        }),
      },
      "public-funnel": { status: 200, body: { status: "changed", enabled: true, port: 443 } },
    });

    expect(await screen.findByText(/http:\/\/127\.0\.0\.1:41234/)).toBeVisible();
    await user.click(await screen.findByRole("switch", { name: "Tailscale Funnel" }));
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "public-funnel")?.body).toEqual({
        enabled: true,
        port: 443,
      }),
    );
  });

  const memberWithEntrance = (namedStandby: boolean, serveWhileStandingIn: boolean) => ({
    hub: { enabled: false },
    spoke: {
      membership: "member",
      hub: { memberId: "m-1", name: "Mac mini" },
      grant: { items: ["roster", "standby", "public"], actProjects: [] },
      acceptedMemberIds: [],
      roster: { roster: { members: [] } },
      namedStandby,
    },
    publicEntrance: {
      enabled: false,
      listening: false,
      funnel: { enabled: false },
      serveWhileStandingIn,
    },
  });

  it("lets a named standby choose to serve the public entrance while it stands in", async () => {
    const user = userEvent.setup();
    const { calls } = renderEntrance({
      status: { status: 200, body: memberWithEntrance(true, false) },
      "public-standby": { status: 200, body: { status: "changed", enabled: true } },
    });
    const serve = await screen.findByRole("switch", { name: "Serve the public entrance" });
    expect(serve).not.toBeChecked();
    await user.click(serve);
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "public-standby")?.body).toEqual({
        enabled: true,
      }),
    );
    expect(await screen.findByText(/^Serve the public entrance is on\./)).toBeVisible();
  });

  it("offers a member the hub never named no choice to serve", async () => {
    renderEntrance({ status: { status: 200, body: memberWithEntrance(false, false) } });
    await screen.findByRole("switch", { name: "Public entrance" });
    expect(screen.getByRole("switch", { name: "Serve the public entrance" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("says why the host refused to serve", async () => {
    const user = userEvent.setup();
    renderEntrance({
      status: { status: 200, body: memberWithEntrance(true, false) },
      "public-standby": {
        status: 409,
        body: { status: "refused", kind: "not-a-named-standby" },
      },
    });
    await user.click(await screen.findByRole("switch", { name: "Serve the public entrance" }));
    expect(await screen.findByText("The hub has not named this computer a standby.")).toBeVisible();
  });

  it("keeps a new webhook secret on screen when the next status read fails", async () => {
    const user = userEvent.setup();
    let reads = 0;
    renderEntrance({
      status: () => {
        reads += 1;
        return reads === 1
          ? {
              status: 200,
              body: {
                ...memberWithEntrance(false, false),
                webhooks: { spoke: { endpoints: [], log: [], published: true } },
              },
            }
          : { status: 503, body: { status: "refused", kind: "unavailable" } };
      },
      "webhook-create": {
        status: 200,
        body: {
          status: "created",
          endpointId: "A".repeat(22),
          secret: "whsec_shown-once",
          path: `/hooks/${"A".repeat(22)}`,
          published: true,
        },
      },
    });
    await user.type(await screen.findByLabelText("Name"), "Deploys");
    await user.click(screen.getByRole("button", { name: "Make endpoint" }));
    expect(await screen.findByText("Octant could not read the hub status.")).toBeVisible();
    expect(screen.getByText("whsec_shown-once")).toBeVisible();
  });

  it("says why Tailscale refused Funnel", async () => {
    const user = userEvent.setup();
    renderEntrance({
      status: {
        status: 200,
        body: hubWithEntrance({ enabled: true, listening: true, funnel: { enabled: false } }),
      },
      "public-funnel": { status: 409, body: { status: "refused", kind: "funnel-not-allowed" } },
    });
    await user.click(await screen.findByRole("switch", { name: "Tailscale Funnel" }));
    expect(await screen.findByText(/^Tailscale refused Funnel/)).toBeVisible();
  });
});

describe("Public entrance settings found by search", () => {
  it.each(ROWS)(
    "has a row for %s on a computer in no hub, saying why it is unavailable",
    async (settingId) => {
      renderEntrance(
        {
          status: { status: 200, body: { hub: { enabled: false }, spoke: { membership: "none" } } },
        },
        { focusedSetting: settingId },
      );
      await waitFor(() => expect(landing(settingId)).not.toBeNull());
      expect(landing(settingId)).toHaveTextContent("join a hub");
      await waitFor(() => expect(landing(settingId)).toHaveFocus());
    },
  );

  it("keeps every row in a browser, which has no hub bridge", () => {
    render(<PublicEntranceSettingsSection />);
    expect(ROWS.filter((row) => landing(row) === null)).toEqual([]);
  });

  it.each([
    ["hub-visitor-links", "Visitor links"],
    ["hub-device-relay", "Device relay"],
  ])("lands a search result for %s on its switch", async (settingId, name) => {
    renderEntrance(
      {
        status: {
          status: 200,
          body: {
            hub: { enabled: true },
            spoke: { membership: "none" },
            visitors: {
              hub: { enabled: false, grants: 0, streams: 0 },
              spoke: { links: [], comments: [], published: true },
            },
            relay: { hub: { enabled: false, hosts: 0, tunnels: 0 }, devices: [] },
          },
        },
      },
      { focusedSetting: settingId },
    );
    await waitFor(() => expect(screen.getByRole("switch", { name })).toHaveFocus());
  });
});
