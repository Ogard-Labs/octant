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
    expect(refusal("graph LR\n  api_gateway(Gateway) -- reads --- db[(Store)]").line).toBe(2);
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
      ["  a ==> b", 2],
      ["  a <--> b", 2],
      ["  a -.- b", 2],
      ["  a((Circle)) --> b", 2],
      ["  a>Flag] --> b", 2],
      ["  a & b --> c", 2],
    ] as const) {
      const result = refusal(`flowchart TD\n${statement}`);
      expect(result.reason).toBe("unsupported-construct");
      expect(result.line).toBe(line);
    }
  });

  it("refuses a bottom-up direction, a nested subgraph, and two ids that collide", () => {
    expect(refusal("flowchart BT\n a --> b").reason).toBe("unsupported-construct");
    expect(refusal("flowchart TD\n subgraph one\n subgraph two\n a\n end\n end").reason).toBe(
      "unsupported-construct",
    );
    expect(refusal("flowchart TD\n a_b --> a-b").reason).toBe("unsupported-construct");
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
        "  ORDER }|..|| PRODUCT : contains",
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
