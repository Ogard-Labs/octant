import { Option, Schema, SchemaAST } from "effect";

/**
 * Decodes a host answer (a response body or a stream frame a client reads)
 * the way a client must: fields the client does not know are dropped instead
 * of refusing the whole answer, so a newer host may add an optional field
 * without an older phone, browser, or CLI losing the thread. A known field
 * with the wrong type or an out-of-range value still fails.
 *
 * Contract structs carry `parseOptions: { onExcessProperty: "error" }`, and
 * Effect lets that annotation win over options passed at the decode call, so
 * the leniency has to be applied to a copy of the schema. The schema itself is
 * never changed: everything the host decodes (requests, commands, the journal,
 * projections, provider and extension payloads) keeps refusing unknown
 * fields. Use this only where the input is an answer from a host.
 *
 * An ask a person decides on (marked with {@link personDecides}) stays strict
 * inside a lenient answer: an unknown field there refuses the whole answer.
 */
export function decodeHostAnswer<A, I>(schema: Schema.Schema<A, I, never>): (input: unknown) => A {
  return Schema.decodeUnknownSync(Schema.make<A, I, never>(ignoringUnknownFields(schema.ast)));
}

const PersonDecidesAnnotationId: unique symbol = Symbol.for("@octant/contracts/person-decides");

/**
 * Marks an ask a person decides on: an approval, a question, or a proposal
 * whose answer grants, approves, or answers on the person's behalf. A client
 * keeps refusing unknown fields inside it, because a field this build cannot
 * show may qualify what the answer authorizes (as `browserOrigin` qualifies a
 * Code approval), and a person must never be shown less than the ask means.
 */
export const personDecides = { [PersonDecidesAnnotationId]: true } as const;

const answerAsts = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

function ignoringUnknownFields(ast: SchemaAST.AST): SchemaAST.AST {
  const known = answerAsts.get(ast);
  if (known !== undefined) return known;
  const rewritten = rewrite(ast);
  answerAsts.set(ast, rewritten);
  return rewritten;
}

function ignoringAnnotations(ast: SchemaAST.AST): SchemaAST.Annotations | undefined {
  const parseOptions = SchemaAST.getParseOptionsAnnotation(ast);
  if (Option.isNone(parseOptions) || parseOptions.value.onExcessProperty === undefined) {
    return undefined;
  }
  return {
    ...ast.annotations,
    [SchemaAST.ParseOptionsAnnotationId]: { ...parseOptions.value, onExcessProperty: "ignore" },
  };
}

// Effect hands a node's merged parse options down to every node beneath it,
// so forcing the ask's own node strict keeps its whole subtree strict too.
function keepingStrict(ast: SchemaAST.AST): SchemaAST.AST {
  const parseOptions = SchemaAST.getParseOptionsAnnotation(ast);
  if (Option.isSome(parseOptions) && parseOptions.value.onExcessProperty === "error") return ast;
  return SchemaAST.annotations(ast, {
    [SchemaAST.ParseOptionsAnnotationId]: {
      ...Option.getOrUndefined(parseOptions),
      onExcessProperty: "error",
    },
  });
}

function sameMembers(before: ReadonlyArray<SchemaAST.AST>, after: ReadonlyArray<SchemaAST.AST>) {
  return before.every((member, index) => member === after[index]);
}

// Rebuilds only the nodes on a path to a strict annotation, so unrelated
// subtrees keep their identity and Effect's per-node parser cache.
function rewrite(ast: SchemaAST.AST): SchemaAST.AST {
  if (ast.annotations[PersonDecidesAnnotationId] === true) return keepingStrict(ast);
  const annotations = ignoringAnnotations(ast);
  switch (ast._tag) {
    case "TypeLiteral": {
      const types = ast.propertySignatures.map((property) => ignoringUnknownFields(property.type));
      const indexTypes = ast.indexSignatures.map((index) => ignoringUnknownFields(index.type));
      if (
        annotations === undefined &&
        sameMembers(
          ast.propertySignatures.map((property) => property.type),
          types,
        ) &&
        sameMembers(
          ast.indexSignatures.map((index) => index.type),
          indexTypes,
        )
      ) {
        return ast;
      }
      return new SchemaAST.TypeLiteral(
        ast.propertySignatures.map(
          (property, index) =>
            new SchemaAST.PropertySignature(
              property.name,
              types[index] ?? property.type,
              property.isOptional,
              property.isReadonly,
              property.annotations,
            ),
        ),
        ast.indexSignatures.map(
          (signature, index) =>
            new SchemaAST.IndexSignature(
              signature.parameter,
              indexTypes[index] ?? signature.type,
              signature.isReadonly,
            ),
        ),
        annotations ?? ast.annotations,
      );
    }
    case "TupleType": {
      const elements = ast.elements.map((element) => ignoringUnknownFields(element.type));
      const rest = ast.rest.map((member) => ignoringUnknownFields(member.type));
      if (
        annotations === undefined &&
        sameMembers(
          ast.elements.map((element) => element.type),
          elements,
        ) &&
        sameMembers(
          ast.rest.map((member) => member.type),
          rest,
        )
      ) {
        return ast;
      }
      return new SchemaAST.TupleType(
        ast.elements.map(
          (element, index) =>
            new SchemaAST.OptionalType(
              elements[index] ?? element.type,
              element.isOptional,
              element.annotations,
            ),
        ),
        ast.rest.map(
          (member, index) => new SchemaAST.Type(rest[index] ?? member.type, member.annotations),
        ),
        ast.isReadonly,
        annotations ?? ast.annotations,
      );
    }
    case "Union": {
      const types = ast.types.map(ignoringUnknownFields);
      if (annotations === undefined && sameMembers(ast.types, types)) return ast;
      return SchemaAST.Union.make(types, annotations ?? ast.annotations);
    }
    case "Refinement": {
      const from = ignoringUnknownFields(ast.from);
      if (annotations === undefined && from === ast.from) return ast;
      return new SchemaAST.Refinement(from, ast.filter, annotations ?? ast.annotations);
    }
    case "Transformation": {
      const from = ignoringUnknownFields(ast.from);
      const to = ignoringUnknownFields(ast.to);
      if (annotations === undefined && from === ast.from && to === ast.to) return ast;
      return new SchemaAST.Transformation(
        from,
        to,
        ast.transformation,
        annotations ?? ast.annotations,
      );
    }
    case "Declaration": {
      const typeParameters = ast.typeParameters.map(ignoringUnknownFields);
      if (annotations === undefined && sameMembers(ast.typeParameters, typeParameters)) return ast;
      return new SchemaAST.Declaration(
        typeParameters,
        ast.decodeUnknown,
        ast.encodeUnknown,
        annotations ?? ast.annotations,
      );
    }
    case "Suspend": {
      // A recursive schema reaches itself through `f`, so the target is
      // rewritten lazily, on first decode, after this node is memoized.
      const target = ast.f;
      return new SchemaAST.Suspend(
        () => ignoringUnknownFields(target()),
        annotations ?? ast.annotations,
      );
    }
    default:
      return ast;
  }
}
