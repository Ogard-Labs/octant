import { decodeCanvasBlockId } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { importCanvasMermaid, type CanvasMermaidImport } from "./canvasMermaidImport";
import { validateCanvasDefinition } from "./canvasPolicy";

const blockId = decodeCanvasBlockId("imported");

function imported(source: string) {
  const result = importCanvasMermaid(source, blockId);
  if (result.status !== "imported") throw new Error(`refused: ${result.detail}`);
  return result.block;
}

function refusal(source: string): Extract<CanvasMermaidImport, { status: "refused" }> {
  const result = importCanvasMermaid(source, blockId);
  if (result.status !== "refused") throw new Error("expected a refusal");
  return result;
}

describe("importing a Mermaid flowchart", () => {
  const loop = [
    "flowchart TD",
    "  %% the core loop",
    "  start([Start run]) --> explore[Explore zone]",
    "  explore --> fight{Encounter?}",
    "  fight -->|win| loot[Collect loot]",
    "  fight -. flee .-> done([Return to camp])",
    "  loot --> upgrade[Upgrade gear] --> done",
    "  subgraph camp [Camp]",
    "    done",
    "  end",
  ].join("\n");

  it("becomes a typed diagram with shaped nodes, styled edges, and a group", () => {
    const block = imported(loop);
    expect(block).toMatchObject({
      kind: "diagram",
      flow: "down",
      nodes: [
        { nodeId: "start", label: "Start run", role: "terminator" },
        { nodeId: "explore", label: "Explore zone", role: "process" },
        { nodeId: "fight", label: "Encounter?", role: "decision" },
        { nodeId: "loot", label: "Collect loot", role: "process" },
        { nodeId: "done", label: "Return to camp", role: "terminator" },
        { nodeId: "upgrade", label: "Upgrade gear", role: "process" },
      ],
      edges: [
        { source: "start", target: "explore", style: "arrow" },
        { source: "explore", target: "fight", style: "arrow" },
        { source: "fight", target: "loot", style: "arrow", label: "win" },
        { source: "fight", target: "done", style: "dashed", label: "flee" },
        { source: "loot", target: "upgrade", style: "arrow" },
        { source: "upgrade", target: "done", style: "arrow" },
      ],
      groups: [{ groupId: "camp", label: "Camp", nodeIds: ["done"] }],
    });
  });

  it("is a block the Canvas policy admits in a current document", () => {
    const block = imported(loop);
    expect(() =>
      validateCanvasDefinition({
        schemaVersion: block.schemaVersion,
        title: "Loop",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: "22222222-2222-4222-8222-222222222222",
          threadId: "33333333-3333-4333-8333-333333333333",
          actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
          providerInstanceId: "44444444-4444-4444-8444-444444444444",
          modelId: "octant-test-model",
          createdAt: "2026-08-01T21:00:00.000Z",
        },
        sourceManifest: [],
        blocks: [block],
      }),
    ).not.toThrow();
  });

  it("reads graph LR, a plain line, a text label, and an underscored id", () => {
    const block = imported("graph LR\n  api_gateway(Gateway) -- reads --- db[Store]");
    expect(block).toMatchObject({
      flow: "right",
      nodes: [
        { nodeId: "api-gateway", label: "Gateway" },
        { nodeId: "db", label: "Store", role: "process" },
      ],
      edges: [{ source: "api-gateway", target: "db", style: "line", label: "reads" }],
    });
  });

  it("refuses styling, interaction, other shapes, and other links, naming the line", () => {
    for (const [statement, line] of [
      ["  classDef hot fill:#f00", 2],
      ['  click a href "https://example.com"', 2],
      ["  style a fill:#f00", 2],
      ["  a <--> b", 2],
      ["  a -.- b", 2],
      ["  a{{Hexagon}} --> b", 2],
      ["  a[[Subroutine]] --> b", 2],
      ["  a>Flag] --> b", 2],
    ] as const) {
      const result = refusal(`flowchart TD\n${statement}`);
      expect(result.reason).toBe("unsupported-construct");
      expect(result.line).toBe(line);
    }
  });

  it("refuses an unknown direction, subgraphs nested past the catalog's depth, and two ids that collide", () => {
    expect(refusal("flowchart XY\n a --> b").reason).toBe("unsupported-construct");
    const deep =
      "flowchart TD\n subgraph one\n subgraph two\n subgraph three\n subgraph four\n a\n end\n end\n end\n end";
    expect(refusal(deep)).toMatchObject({ reason: "unsupported-construct", line: 5 });
    expect(refusal("flowchart TD\n a_b --> a-b").reason).toBe("unsupported-construct");
    expect(
      refusal("flowchart TD\n subgraph one\n a\n end\n subgraph two\n a --> b\n end"),
    ).toMatchObject({ reason: "unsupported-construct", line: 6 });
  });

  it("reads a bottom-up or right-to-left flowchart as the same graph, laid out down or right", () => {
    expect(imported("flowchart BT\n a --> b")).toMatchObject({
      flow: "down",
      edges: [{ source: "a", target: "b" }],
    });
    expect(imported("graph RL\n a --> b")).toMatchObject({
      flow: "right",
      edges: [{ source: "a", target: "b" }],
    });
  });

  it("reads a circle as a terminator and a cylinder as a database node", () => {
    expect(imported("flowchart TD\n s((Start)) --> db[(Orders<br/>store)]")).toMatchObject({
      nodes: [
        { nodeId: "s", label: "Start", role: "terminator" },
        { nodeId: "db", label: "Orders store", icon: "database" },
      ],
    });
  });

  it("refuses two ampersand lists whose pairs outnumber a diagram's links, without building them", () => {
    const many = (prefix: string) =>
      Array.from({ length: 200 }, (_, index) => `${prefix}${String(index)}`).join(" & ");
    expect(refusal(`flowchart TD\n ${many("a")} --> ${many("b")}`)).toMatchObject({
      reason: "unsupported-construct",
      line: 2,
    });
  });

  it("reads thick and longer links as arrows, and fans an ampersand list out into one edge per pair", () => {
    const block = imported(
      "flowchart LR\n a ==> b\n b == heavy ==> c\n c ---> d\n d -.-> e\n a & b --> x & y",
    );
    expect(block).toMatchObject({
      edges: [
        { source: "a", target: "b", style: "arrow" },
        { source: "b", target: "c", style: "arrow", label: "heavy" },
        { source: "c", target: "d", style: "arrow" },
        { source: "d", target: "e", style: "dashed" },
        { source: "a", target: "x", style: "arrow" },
        { source: "a", target: "y", style: "arrow" },
        { source: "b", target: "x", style: "arrow" },
        { source: "b", target: "y", style: "arrow" },
      ],
    });
    // An ampersand inside a label is the label's.
    expect(imported("flowchart TD\n rd[Research & Development] --> ops")).toMatchObject({
      nodes: [{ nodeId: "rd", label: "Research & Development" }, { nodeId: "ops" }],
    });
  });

  it("nests a subgraph inside its parent, keeps a node in its innermost one, and skips a direction hint", () => {
    const block = imported(
      [
        "flowchart TD",
        "  subgraph cloud [Cloud]",
        "    direction LR",
        "    subgraph zone [Zone A]",
        "      api --> db",
        "    end",
        "  end",
        "  user --> api",
      ].join("\n"),
    );
    expect(block).toMatchObject({
      groups: [
        { groupId: "cloud", label: "Cloud", nodeIds: [] },
        { groupId: "zone", label: "Zone A", nodeIds: ["api", "db"], parentGroupId: "cloud" },
      ],
    });
    expect(() =>
      validateCanvasDefinition({
        schemaVersion: block.schemaVersion,
        title: "Zones",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: "22222222-2222-4222-8222-222222222222",
          threadId: "33333333-3333-4333-8333-333333333333",
          actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
          providerInstanceId: "44444444-4444-4444-8444-444444444444",
          modelId: "octant-test-model",
          createdAt: "2026-08-01T21:00:00.000Z",
        },
        sourceManifest: [],
        blocks: [block],
      }),
    ).not.toThrow();
  });
});

describe("importing the other Mermaid diagram kinds", () => {
  it("reads a sequence with aliases, messages, a note, and an activation", () => {
    const block = imported(
      [
        "sequenceDiagram",
        "  actor person as Person",
        "  participant web as Browser",
        "  person->>web: Submit credentials",
        "  activate web",
        "  web->>auth: Sign in",
        "  auth-->>web: Session",
        "  deactivate web",
        "  Note right of web: Cookie is HttpOnly",
      ].join("\n"),
    );
    expect(block).toMatchObject({
      kind: "sequence",
      participants: [
        { participantId: "person", label: "Person" },
        { participantId: "web", label: "Browser" },
        { participantId: "auth", label: "auth" },
      ],
      messages: [
        { messageId: "m1", from: "person", to: "web", label: "Submit credentials" },
        { messageId: "m2", from: "web", to: "auth" },
        { messageId: "m3", from: "auth", to: "web", label: "Session" },
      ],
      activations: [{ participantId: "web", startMessageId: "m2", endMessageId: "m3" }],
      notes: [{ participantId: "web", text: "Cookie is HttpOnly", afterMessageId: "m3" }],
    });
    expect(refusal("sequenceDiagram\n a->>b: hi\n loop Every minute\n b->>a: ok\n end").line).toBe(
      3,
    );
  });

  it("reads a state machine with a start, an end, an alias, and a composite state", () => {
    const block = imported(
      [
        "stateDiagram-v2",
        '  state "Awaiting payment" as Pending',
        "  [*] --> Pending",
        "  Pending --> Paid : pay",
        "  state Paid {",
        "    Authorized --> Captured : capture",
        "  }",
        "  Paid --> [*]",
      ].join("\n"),
    );
    expect(block).toMatchObject({
      kind: "state",
      states: [
        { stateId: "Pending", label: "Awaiting payment" },
        { stateId: "pseudo:start", role: "initial" },
        { stateId: "Paid", label: "Paid" },
        { stateId: "Authorized", parentId: "Paid" },
        { stateId: "Captured", parentId: "Paid" },
        { stateId: "pseudo:end", role: "final" },
      ],
      transitions: [
        { source: "pseudo:start", target: "Pending", label: "→" },
        { source: "Pending", target: "Paid", label: "pay" },
        { source: "Authorized", target: "Captured", label: "capture" },
        { source: "Paid", target: "pseudo:end" },
      ],
    });
    expect(refusal("stateDiagram\n A --> B\n note right of A : hi").reason).toBe(
      "unsupported-construct",
    );
  });

  it("keeps a start and an end apart from states the author named start and end", () => {
    const block = imported(
      ["stateDiagram-v2", "  [*] --> start", "  start --> end", "  end --> [*]"].join("\n"),
    );
    if (block.kind !== "state") throw new Error("expected a state machine");
    const initial = block.states.find((entry) => entry.role === "initial");
    const final = block.states.find((entry) => entry.role === "final");
    expect(block.states.map((entry) => String(entry.stateId))).toContain("start");
    expect(block.states.map((entry) => String(entry.stateId))).toContain("end");
    expect(block.states).toHaveLength(4);
    expect(block.transitions.map((entry) => [String(entry.source), String(entry.target)])).toEqual([
      [String(initial?.stateId), "start"],
      ["start", "end"],
      ["end", String(final?.stateId)],
    ]);
  });

  it("reads a sequence's activation shorthand, its lost and async arrows, and skips autonumber", () => {
    const block = imported(
      [
        "sequenceDiagram",
        "  autonumber",
        "  Client->>+API: request",
        "  API-)Queue: enqueue",
        "  API--xClient: dropped",
        "  API-->>-Client: response",
      ].join("\n"),
    );
    if (block.kind !== "sequence") throw new Error("not a sequence");
    expect(block.messages.map((entry) => [entry.from, entry.to, entry.label])).toEqual([
      ["Client", "API", "request"],
      ["API", "Queue", "enqueue"],
      ["API", "Client", "dropped"],
      ["API", "Client", "response"],
    ]);
    expect(block.activations).toMatchObject([
      { participantId: "API", startMessageId: "m1", endMessageId: "m4" },
    ]);
    expect(refusal("sequenceDiagram\n  A->>B: hi\n  B-->>-A: bye").line).toBe(3);
  });

  it("reads a state's description as its label and skips a direction hint", () => {
    const block = imported(
      "stateDiagram-v2\n  direction LR\n  idle : Waiting for work\n  [*] --> idle\n  idle --> busy : job",
    );
    if (block.kind !== "state") throw new Error("not a state diagram");
    expect(block.states).toMatchObject([
      { stateId: "idle", label: "Waiting for work" },
      { stateId: "pseudo:start" },
      { stateId: "busy", label: "busy" },
    ]);
  });

  it("refuses a note that spans two participants rather than pinning it to one", () => {
    const refused = refusal("sequenceDiagram\n  A->>B: hi\n  Note over A,B: shared");
    expect(refused.reason).toBe("unsupported-construct");
    expect(refused.line).toBe(3);
  });

  it("refuses a foreign or unique key marker it cannot keep instead of dropping it", () => {
    for (const marker of ["FK", "UK", "PK, FK"]) {
      const refused = refusal(`erDiagram\n  ORDER {\n    uuid customer_id ${marker}\n  }`);
      expect(refused.reason).toBe("unsupported-construct");
      expect(refused.line).toBe(3);
    }
  });

  it("reads an entity-relationship diagram with cardinalities, attributes, and keys", () => {
    const block = imported(
      [
        "erDiagram",
        "  CUSTOMER ||--o{ ORDER : places",
        "  ORDER }|--|| PRODUCT : contains",
        "  CUSTOMER {",
        "    uuid id PK",
        "    string email",
        "  }",
      ].join("\n"),
    );
    expect(block).toMatchObject({
      kind: "er",
      entities: [
        {
          entityId: "CUSTOMER",
          attributes: [
            { name: "id", type: "uuid", key: true },
            { name: "email", type: "string" },
          ],
        },
        { entityId: "ORDER" },
        { entityId: "PRODUCT" },
      ],
      relationships: [
        { sourceCardinality: "one", targetCardinality: "many", label: "places" },
        { sourceCardinality: "one-or-many", targetCardinality: "one", label: "contains" },
      ],
    });
    expect(refusal('erDiagram\n A {\n string name "the name"\n }').line).toBe(3);
  });

  it("reads a mind map's tree from its indentation", () => {
    const block = imported(
      [
        "mindmap",
        "  root((Release))",
        "    Scope",
        "      API",
        "    Risks",
        "      [Migration]",
      ].join("\n"),
    );
    expect(block).toMatchObject({
      kind: "mindmap",
      nodes: [
        { nodeId: "t1", label: "Release" },
        { nodeId: "t2", label: "Scope", parentId: "t1" },
        { nodeId: "t3", label: "API", parentId: "t2" },
        { nodeId: "t4", label: "Risks", parentId: "t1" },
        { nodeId: "t5", label: "Migration", parentId: "t4" },
      ],
    });
    expect(refusal("mindmap\n  Root\n    A\n      ::icon(fa fa-book)").reason).toBe(
      "unsupported-construct",
    );
    expect(refusal("mindmap\n  Root\n  Second root").reason).toBe("unsupported-construct");
  });

  it("refuses a mind map topic whose shape it cannot read instead of importing its markup as the label", () => {
    for (const topic of [
      ")Cloud(",
      "))Bang((",
      "id)Cloud(",
      "id))Bang((",
      "id{{Hexagon}}",
      "release.v1)Cloud(",
      "phase one))Bang((",
      "Cost (USD) estimate",
    ]) {
      expect(refusal(`mindmap\n  Root\n    ${topic}`).reason).toBe("unsupported-construct");
    }
  });

  it("reads a mind map topic's id as Mermaid does: everything before its shape", () => {
    expect(
      imported(
        'mindmap\n  Root\n    id(Rounded)\n    release.v1[Scope]\n    phase one((Launch))\n    q["Cost (USD)"]',
      ),
    ).toMatchObject({
      nodes: [
        { nodeId: "t1", label: "Root" },
        { nodeId: "t2", label: "Rounded", parentId: "t1" },
        { nodeId: "t3", label: "Scope", parentId: "t1" },
        { nodeId: "t4", label: "Launch", parentId: "t1" },
        { nodeId: "t5", label: "Cost (USD)", parentId: "t1" },
      ],
    });
  });

  it("keeps a semicolon in a mind map topic as part of the topic", () => {
    // A flowchart ends a statement with a semicolon; a mind map topic is its line.
    expect(imported("mindmap\n  Release\n    Scope; risks")).toMatchObject({
      nodes: [
        { nodeId: "t1", label: "Release" },
        { nodeId: "t2", label: "Scope; risks", parentId: "t1" },
      ],
    });
    expect(imported("graph LR; a --> b; b --> c")).toMatchObject({
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    });
  });

  it("reads a node whose id starts with a styling keyword or ends in o or x as a node", () => {
    // `class`, `style`, `title`, and `click` are refused as statements, not
    // as the first letters of an id; `o--` and `x--` are refused as links,
    // not as the last letter of an id before an arrow.
    expect(
      imported("flowchart TD\n  classroom --> styles[CSS]\n  titleBar --> clickCount"),
    ).toMatchObject({
      edges: [
        { source: "classroom", target: "styles" },
        { source: "titleBar", target: "clickCount" },
      ],
    });
    expect(imported("flowchart TD\n  todo-->done\n  box---lid")).toMatchObject({
      edges: [
        { source: "todo", target: "done", style: "arrow" },
        { source: "box", target: "lid", style: "line" },
      ],
    });
    // The statements and the links themselves are still refused.
    expect(refusal("flowchart TD\n  a --> b\n  class a hot").line).toBe(3);
    expect(refusal("flowchart TD\n  a o--o b").reason).toBe("unsupported-construct");
    expect(refusal("flowchart TD\n  a x--x b").reason).toBe("unsupported-construct");
  });

  it("refuses a non-identifying relationship it has no way to keep instead of drawing it as identifying", () => {
    const refused = refusal("erDiagram\n  ORDER }|..|| PRODUCT : contains");
    expect(refused.reason).toBe("unsupported-construct");
    expect(refused.line).toBe(2);
  });
});

describe("Mermaid the reader does not import", () => {
  it("keeps any other diagram type, an empty source, and an oversized source out", () => {
    expect(refusal("gantt\n  title Plan").reason).toBe("unsupported-diagram");
    expect(refusal('pie\n  "A" : 1').reason).toBe("unsupported-diagram");
    expect(refusal("").reason).toBe("empty");
    expect(refusal("flowchart TD").reason).toBe("empty");
    expect(refusal(`flowchart TD\n${"a --> b\n".repeat(5_000)}`).reason).toBe("too-large");
  });

  it("refuses a translation past the catalog's budgets as an invalid result", () => {
    const wide = Array.from({ length: 600 }, (_value, index) => `  n${String(index)}`).join("\n");
    expect(refusal(`flowchart TD\n${wide}`).reason).toBe("invalid-result");
  });
});
