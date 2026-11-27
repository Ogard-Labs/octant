import { WebhookSignatureScheme } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import HubWebhooksSection, { schemeName } from "./HubWebhooksSection";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const ENDPOINT_ID = "AAAAAAAAAAAAAAAAAAAAAA";

type Answer = { readonly status: number; readonly body: unknown };

function body(options: {
  readonly endpoints?: ReadonlyArray<Record<string, unknown>>;
  readonly log?: ReadonlyArray<Record<string, unknown>>;
  readonly hub?: Record<string, unknown>;
}) {
  return {
    spoke: { endpoints: options.endpoints ?? [], log: options.log ?? [], published: true },
    ...(options.hub === undefined ? {} : { hub: options.hub }),
  };
}

const deploys = {
  endpointId: ENDPOINT_ID,
  scheme: "github",
  label: "Deploys",
  createdAt: NOW - 60_000,
  path: `/hooks/${ENDPOINT_ID}`,
  deliveries: 2,
};

function renderSection(options: {
  readonly view: unknown;
  readonly answers?: Partial<Record<HubAdministrationOperation, Answer>>;
  readonly publicGranted?: boolean;
  readonly member?: boolean;
}) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const request = vi.fn(async (operation: HubAdministrationOperation, sent?: unknown) => {
    calls.push({ operation, body: sent });
    return options.answers?.[operation] ?? { status: 200, body: {} };
  });
  const onChanged = vi.fn(async () => undefined);
  render(
    <HubWebhooksSection
      body={options.view}
      member={options.member ?? true}
      now={() => NOW}
      onChanged={onChanged}
      publicGranted={options.publicGranted ?? true}
      request={request}
    />,
  );
  return { calls, onChanged };
}

describe("HubWebhooksSection", () => {
  it("offers every signing scheme the contract names", async () => {
    const user = userEvent.setup();
    renderSection({ view: body({}) });
    await user.click(screen.getByRole("combobox", { name: "Signing" }));
    for (const scheme of WebhookSignatureScheme.literals) {
      expect(await screen.findByRole("option", { name: schemeName(scheme) })).toBeInTheDocument();
    }
  });

  it("shows a new endpoint's secret once, and forgets it when the person is done", async () => {
    const user = userEvent.setup();
    const { calls, onChanged } = renderSection({
      view: body({}),
      answers: {
        "webhook-create": {
          status: 200,
          body: {
            status: "created",
            endpointId: ENDPOINT_ID,
            secret: "whsec_shown-once",
            path: `/hooks/${ENDPOINT_ID}`,
            published: true,
          },
        },
      },
    });
    await user.type(screen.getByLabelText("Name"), "Deploys");
    await user.click(screen.getByRole("combobox", { name: "Signing" }));
    await user.click(await screen.findByRole("option", { name: "GitHub" }));
    await user.click(screen.getByRole("button", { name: "Make endpoint" }));

    const shown = await screen.findByRole("group", { name: "New endpoint secret" });
    expect(within(shown).getByText("whsec_shown-once")).toBeInTheDocument();
    expect(within(shown).getByText(`/hooks/${ENDPOINT_ID}`)).toBeInTheDocument();
    expect(calls).toContainEqual({
      operation: "webhook-create",
      body: { scheme: "github", label: "Deploys" },
    });
    expect(onChanged).toHaveBeenCalled();

    await user.click(within(shown).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("whsec_shown-once")).not.toBeInTheDocument();
  });

  it("says to tick Public before an endpoint can be made", () => {
    renderSection({ view: body({}), publicGranted: false });
    expect(
      screen.getByText("Tick Public in this computer's hub grant to make one."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make endpoint" })).toBeDisabled();
  });

  it("rotates an endpoint only after the person confirms, and shows the new secret", async () => {
    const user = userEvent.setup();
    const { calls } = renderSection({
      view: body({ endpoints: [deploys] }),
      answers: {
        "webhook-rotate": {
          status: 200,
          body: {
            status: "created",
            endpointId: "BBBBBBBBBBBBBBBBBBBBBB",
            secret: "whsec_rotated",
            path: "/hooks/BBBBBBBBBBBBBBBBBBBBBB",
            published: false,
          },
        },
      },
    });
    expect(
      screen.getByText(/GitHub · \/hooks\/A+ · 2 waiting for the routine/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rotate Deploys" }));
    expect(calls.some((call) => call.operation === "webhook-rotate")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Rotate endpoint" }));

    expect(await screen.findByText("whsec_rotated")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The hub has not taken the endpoint yet; this computer tries again shortly.",
      ),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      operation: "webhook-rotate",
      body: { endpointId: ENDPOINT_ID },
    });
  });

  it("removes an endpoint after the person confirms, and says why a refusal happened", async () => {
    const user = userEvent.setup();
    renderSection({
      view: body({ endpoints: [deploys] }),
      answers: {
        "webhook-remove": {
          status: 409,
          body: { status: "refused", kind: "unknown-endpoint" },
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Remove Deploys" }));
    await user.click(screen.getByRole("button", { name: "Remove endpoint" }));
    expect(
      await screen.findByText("That endpoint is gone. The list is up to date now."),
    ).toBeInTheDocument();
  });

  it("lists recent deliveries newest first, with what became of each", () => {
    renderSection({
      view: body({
        endpoints: [deploys],
        log: [
          { at: NOW - 3 * 60_000, endpointId: ENDPOINT_ID, outcome: "accepted" },
          { at: NOW - 60_000, endpointId: ENDPOINT_ID, outcome: "bad-signature" },
        ],
      }),
    });
    const rows = within(screen.getByRole("list", { name: "Recent deliveries" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      "DeploysRefused: the signature did not match · 1 minute ago",
      "DeploysAccepted · 3 minutes ago",
    ]);
  });

  it("shows the hub only its counts, with nothing to make", async () => {
    renderSection({
      view: body({ hub: { endpoints: 3, queued: 1, forwarded: 9, refused: 2, expired: 0 } }),
      member: false,
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "As the hub: holding 3 endpoints, 1 queued, 9 forwarded, 2 refused, 0 expired.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Make endpoint" })).not.toBeInTheDocument();
  });
});
