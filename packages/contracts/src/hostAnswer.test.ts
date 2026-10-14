import { Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vitest";
import * as contracts from "./index";
import { CodeRuntimeWork, decodeCodeRuntimeWork } from "./code";
import { CodeOperationStreamFrame } from "./codeOperations";
import { decodeHostAnswer } from "./hostAnswer";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

interface Folder {
  readonly name: string;
  readonly children: ReadonlyArray<Folder>;
}
const Folder: Schema.Schema<Folder> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Schema<Folder> => Folder)),
}).annotations(strict);

describe("decodeHostAnswer", () => {
  it("ignores unknown fields at every depth while the shared decoder keeps refusing them", () => {
    const answer = {
      name: "root",
      added: 1,
      children: [{ name: "leaf", children: [], addedLater: true }],
    };
    expect(() => Schema.decodeUnknownSync(Folder)(answer)).toThrow(/is unexpected/);
    expect(decodeHostAnswer(Folder)(answer)).toEqual({
      name: "root",
      children: [{ name: "leaf", children: [] }],
    });
  });

  it("still refuses a known field with the wrong type", () => {
    expect(() =>
      decodeHostAnswer(Folder)({ name: "root", children: [{ name: 3, children: [] }] }),
    ).toThrow(/Expected string/);
  });

  it("keeps the evidence reference of Code runtime work", () => {
    const work = {
      id: "88000000-0000-4000-8000-000000000001",
      threadId: "84000000-0000-4000-8000-000000000001",
      kind: "delivery",
      state: "completed",
      updatedAt: "2026-10-14T10:00:00.000Z",
      evidenceContentId: "87000000-0000-4000-8000-000000000001",
      digest: "a".repeat(64),
      byteLength: 12,
    };
    expect(decodeCodeRuntimeWork(work)).toMatchObject({ byteLength: 12 });
    expect(decodeHostAnswer(CodeRuntimeWork)(work)).toMatchObject({ byteLength: 12 });
  });

  const frame = (event: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
    threadId: "84000000-0000-4000-8000-000000000001",
    operationId: "86000000-0000-4000-8000-000000000001",
    cursor: 3,
    occurredAt: "2026-10-14T10:00:00.000Z",
    event,
    ...extras,
  });
  const approvalAsk = {
    kind: "approval-requested",
    approvalId: "89000000-0000-4000-8000-000000000001",
    action: "provider-tool",
    summary: "Open example.com",
  };

  it("still refuses an ask a person decides on that carries a field this build does not know", () => {
    const answer = frame({ ...approvalAsk, browserOrigin: "https://example.com" });
    expect(() => decodeHostAnswer(CodeOperationStreamFrame)(answer)).toThrow(/is unexpected/);
  });

  it("reads the answer around an ask leniently when the ask itself is whole", () => {
    const answer = frame(approvalAsk, { replayHint: "newer hosts add this" });
    expect(decodeHostAnswer(CodeOperationStreamFrame)(answer)).toEqual(frame(approvalAsk));
  });

  it("reads an answer leniently where no ask is present", () => {
    const answer = frame(
      { kind: "operation-state", state: "running", stage: "tools" },
      { hint: 1 },
    );
    expect(decodeHostAnswer(CodeOperationStreamFrame)(answer)).toEqual(
      frame({ kind: "operation-state", state: "running" }),
    );
  });

  it("has no contract union whose earlier member would swallow a later member's fields", () => {
    expect(unionsThatDropFieldsWhenLenient()).toEqual([]);
  });
});

// A union takes its first member that decodes. Once unknown fields are
// ignored, a member listed before a strict superset of itself would accept the
// superset's value and drop the extra fields, so the more specific member must
// come first. This walks every exported contract schema for that order.
function unionsThatDropFieldsWhenLenient(): ReadonlyArray<string> {
  const found = new Set<string>();
  const seen = new Set<SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST, owner: string, suspended: number): void => {
    // Recursive schemas reached through a type-side copy unfold without end,
    // so one level through a suspension is enough to see every union.
    if (seen.has(ast) || suspended > 1) return;
    seen.add(ast);
    switch (ast._tag) {
      case "TypeLiteral":
        ast.propertySignatures.forEach((property) => visit(property.type, owner, suspended));
        ast.indexSignatures.forEach((index) => visit(index.type, owner, suspended));
        return;
      case "TupleType":
        ast.elements.forEach((element) => visit(element.type, owner, suspended));
        ast.rest.forEach((member) => visit(member.type, owner, suspended));
        return;
      case "Union":
        checkUnion(ast, owner, found);
        ast.types.forEach((member) => visit(member, owner, suspended));
        return;
      case "Refinement":
        visit(ast.from, owner, suspended);
        return;
      case "Transformation":
        visit(ast.from, owner, suspended);
        visit(ast.to, owner, suspended);
        return;
      case "Declaration":
        ast.typeParameters.forEach((parameter) => visit(parameter, owner, suspended));
        return;
      case "Suspend":
        visit(ast.f(), owner, suspended + 1);
        return;
      default:
        return;
    }
  };
  for (const [name, value] of Object.entries(contracts)) {
    if (Schema.isSchema(value)) visit(value.ast, name, 0);
  }
  return [...found];
}

function checkUnion(union: SchemaAST.Union, owner: string, found: Set<string>): void {
  const members = union.types.map(encodedStruct);
  members.forEach((earlier, i) => {
    members.slice(i + 1).forEach((later, offset) => {
      if (earlier === undefined || later === undefined) return;
      if (earlier.indexSignatures.length > 0 || later.indexSignatures.length > 0) return;
      const laterFields = new Map(later.propertySignatures.map((field) => [field.name, field]));
      const accepts = earlier.propertySignatures.every((field) => {
        const match = laterFields.get(field.name);
        if (match === undefined) return field.isOptional;
        const mine = literalValues(field.type);
        const theirs = literalValues(match.type);
        return mine === undefined || theirs === undefined || mine.some((v) => theirs.includes(v));
      });
      const earlierNames = new Set(earlier.propertySignatures.map((field) => field.name));
      const dropped = [...laterFields.keys()].filter((name) => !earlierNames.has(name));
      if (accepts && dropped.length > 0) {
        found.add(
          `${owner}: member ${i} drops ${dropped.map(String).join(", ")} of member ${i + 1 + offset}`,
        );
      }
    });
  });
}

function encodedStruct(ast: SchemaAST.AST): SchemaAST.TypeLiteral | undefined {
  switch (ast._tag) {
    case "TypeLiteral":
      return ast;
    case "Refinement":
    case "Transformation":
      return encodedStruct(ast.from);
    default:
      return undefined;
  }
}

function literalValues(ast: SchemaAST.AST): ReadonlyArray<SchemaAST.LiteralValue> | undefined {
  switch (ast._tag) {
    case "Literal":
      return [ast.literal];
    case "Refinement":
      return literalValues(ast.from);
    case "Union": {
      const values: Array<SchemaAST.LiteralValue> = [];
      for (const member of ast.types) {
        const inner = literalValues(member);
        if (inner === undefined) return undefined;
        values.push(...inner);
      }
      return values;
    }
    default:
      return undefined;
  }
}
