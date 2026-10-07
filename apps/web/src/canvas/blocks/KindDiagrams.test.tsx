import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  loginSequenceBlock,
  orderSchemaBlock,
  orderStateBlock,
  releaseMindmapBlock,
  supportFlowBlock,
} from "@octant/domain";
import { CanvasCommentsPanel } from "../CanvasCommentsPanel";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const canvasId = "11111111-1111-4111-8111-111111111111" as never;
const author = {
  kind: "local-user" as const,
  actorId: "88888888-8888-4888-8888-888888888888" as never,
};

describe("sequence and state diagrams", () => {
  it("draws a login sequence and an order state machine a reader can name", () => {
    render(
      <CanvasDocument
        definition={{
          ...canvasFixture,
          blocks: [loginSequenceBlock, orderStateBlock],
        }}
      />,
    );

    expect(screen.getByRole("figure", { name: /Sequence with 3 participants/ })).toBeVisible();
    expect(screen.getByText("Person")).toBeVisible();
    expect(screen.getByText("Paid")).toBeVisible();
    expect(screen.getByRole("figure", { name: /State machine with 8 states/ })).toBeVisible();
    expect(document.querySelector("[data-edge-id='submit'] title")?.textContent).toBe(
      "Submit credentials",
    );
    expect(document.querySelector("[data-node-id='paid']")).not.toBeNull();
  });

  it("offers sequence messages and state nodes as comment anchors", async () => {
    const user = userEvent.setup();
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={{
          ...canvasFixture,
          blocks: [loginSequenceBlock, orderStateBlock],
        }}
        load={async () => ({ kind: "ready", canvasId, sequence: 0, threads: [] })}
        send={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("combobox", { name: "Comment anchor" }));
    expect(
      await screen.findByRole("option", { name: "Sequence · Submit credentials" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "State · Paid" })).toBeVisible();
  });
});

describe("entity-relationship, swimlane, and mind map diagrams", () => {
  it("draws an entity-relationship model, a swimlane, and a mind map a reader can name", () => {
    render(
      <CanvasDocument
        definition={{
          ...canvasFixture,
          blocks: [orderSchemaBlock, supportFlowBlock, releaseMindmapBlock],
        }}
      />,
    );

    expect(
      screen.getByRole("figure", { name: /Entity relationship with 3 entities/ }),
    ).toBeVisible();
    expect(screen.getAllByText("Person").length).toBeGreaterThan(0);
    expect(screen.getByRole("figure", { name: /Swimlane with 3 lanes/ })).toBeVisible();
    expect(screen.getAllByText("Customer").length).toBeGreaterThan(0);
    expect(screen.getByRole("figure", { name: /Mind map with 6 topics/ })).toBeVisible();
    expect(screen.getAllByText("Release readiness").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-node-id='order']")).not.toBeNull();
    expect(document.querySelector("[data-edge-id='person-places-order']")).not.toBeNull();
    expect(document.querySelector("[data-node-id='triage']")).not.toBeNull();
  });

  it("draws a swimlane's connections over its lane bands, where a reader can see them", () => {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [supportFlowBlock] }} />);

    const svg = screen.getByRole("figure", { name: /Swimlane with 3 lanes/ }).querySelector("svg");
    if (svg === null) throw new Error("The swimlane was not drawn.");
    const drawn = [...svg.children];
    const lastBand = Math.max(
      ...drawn.map((child, index) =>
        child.querySelector(".canvas-block__swimlane-band") === null ? -1 : index,
      ),
    );
    const firstConnection = drawn.findIndex((child) => child.hasAttribute("data-edge-id"));
    expect(firstConnection).toBeGreaterThan(lastBand);
  });

  it("gives each picture a screen-reader fallback and a keyboard focus ring", () => {
    render(
      <CanvasDocument
        definition={{
          ...canvasFixture,
          blocks: [orderSchemaBlock, supportFlowBlock, releaseMindmapBlock],
        }}
      />,
    );

    // A table of the schema's attributes is the fallback for the entity model.
    const erFigure = screen.getByRole("figure", { name: /Entity relationship with 3 entities/ });
    expect(erFigure.querySelectorAll("figcaption table tbody tr").length).toBe(7);
    // Numbered steps per lane are the fallback for the swimlane.
    const swimlaneFigure = screen.getByRole("figure", { name: /Swimlane with 3 lanes/ });
    expect(swimlaneFigure.querySelectorAll("figcaption ol").length).toBe(3);
    // Swimlane connections name their steps by label, so a screen reader
    // never hears internal identifiers or misses a connection's own label.
    const swimlaneConnections = swimlaneFigure.querySelectorAll("figcaption > ul li");
    expect(swimlaneConnections.length).toBe(5);
    expect(swimlaneConnections[0]?.textContent).toBe("Report a problem → Is it a defect?");
    expect(swimlaneConnections[2]?.textContent).toBe("Is it a defect? → Fix the defect: yes");
    // A nested list is the fallback for the mind map.
    const mindmapFigure = screen.getByRole("figure", { name: /Mind map with 6 topics/ });
    expect(mindmapFigure.querySelectorAll("figcaption ul ul").length).toBeGreaterThan(0);

    erFigure.focus();
    expect(document.activeElement).toBe(erFigure);
  });

  it("offers entity, step, topic, and connection identifiers as comment anchors", async () => {
    const user = userEvent.setup();
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={{
          ...canvasFixture,
          blocks: [orderSchemaBlock, supportFlowBlock, releaseMindmapBlock],
        }}
        load={async () => ({ kind: "ready", canvasId, sequence: 0, threads: [] })}
        send={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("combobox", { name: "Comment anchor" }));
    expect(await screen.findByRole("option", { name: "Entity · Person" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Step · Fix the defect" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Topic · Release readiness" })).toBeVisible();
  });
});
