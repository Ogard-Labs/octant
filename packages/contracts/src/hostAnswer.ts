import { Effect, Schema, SchemaAST } from "effect";

/**
 * Decodes a host answer (a response body or a stream frame a client reads)
 * the way a client must: fields the client does not know are dropped instead
 * of refusing the whole answer, so a newer host may add an optional field
 * without an older phone, browser, or CLI losing the thread. A known field
 * with the wrong type or an out-of-range value still fails.
 *
 * Host decoders pass `onExcessProperty: "error"` so requests, commands, the
 * journal, projections, and provider/extension payloads keep refusing unknown
 * fields. `decodeHostAnswer` uses Effect's default lenient decoding
 * (`onExcessProperty: "ignore"`) while rewriting any subtree marked with
 * {@link personDecides} so an unknown field inside an ask a person decides on
 * still refuses the whole answer. Use this only where the input is an answer
 * from a host.
 */
export function decodeHostAnswer<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
): (input: unknown) => S["Type"] {
  const rewritten = keepingPersonDecidesStrict(schema.ast);
  const target = rewritten === schema.ast ? schema : Schema.make<S>(rewritten);
  return Schema.decodeUnknownSync(target);
}

const PERSON_DECIDES_ANNOTATION_KEY = "@octant/contracts/person-decides" as const;

/**
 * Marks an ask a person decides on: an approval, a question, or a proposal
 * whose answer grants, approves, or answers on the person's behalf. A client
 * keeps refusing unknown fields inside it, because a field this build cannot
 * show may qualify what the answer authorizes (as `browserOrigin` qualifies a
 * Code approval), and a person must never be shown less than the ask means.
 */
export const personDecides = { [PERSON_DECIDES_ANNOTATION_KEY]: true } as const;

const answerAsts = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

function keepingPersonDecidesStrict(ast: SchemaAST.AST): SchemaAST.AST {
  const known = answerAsts.get(ast);
  if (known !== undefined) return known;
  const rewritten = rewrite(ast);
  answerAsts.set(ast, rewritten);
  return rewritten;
}

function enforceStrictSubtree(ast: SchemaAST.AST): SchemaAST.AST {
  const parser = Schema.decodeUnknownEffect(Schema.make<Schema.Codec<unknown, unknown>>(ast));
  return new SchemaAST.Declaration(
    [],
    () => (input, _self, options) =>
      parser(input, { ...options, onExcessProperty: "error" }).pipe(
        Effect.mapError((error) => error.issue),
      ),
    ast.annotations,
    undefined,
    undefined,
    ast.context,
  );
}

function sameMembers<T>(before: ReadonlyArray<T>, after: ReadonlyArray<T>): boolean {
  return before.every((member, index) => member === after[index]);
}

function rewriteEncoding(encoding: SchemaAST.Encoding | undefined): SchemaAST.Encoding | undefined {
  if (encoding === undefined) return undefined;
  const rewritten = encoding.map((link) => {
    const to = keepingPersonDecidesStrict(link.to);
    return to === link.to ? link : new SchemaAST.Link(to, link.transformation);
  });
  if (sameMembers(encoding, rewritten)) return encoding;
  const [first, ...rest] = rewritten;
  return first === undefined ? undefined : [first, ...rest];
}

function isPersonDecides(ast: SchemaAST.AST): boolean {
  if (ast.annotations?.[PERSON_DECIDES_ANNOTATION_KEY] === true) return true;
  return (
    ast.checks?.some((check) => check.annotations?.[PERSON_DECIDES_ANNOTATION_KEY] === true) ??
    false
  );
}

// Rebuilds only the nodes on a path to a `personDecides` annotation, so
// unrelated subtrees keep their identity and Effect's per-node parser cache.
function rewrite(ast: SchemaAST.AST): SchemaAST.AST {
  if (isPersonDecides(ast)) {
    return enforceStrictSubtree(ast);
  }
  const encoding = rewriteEncoding(ast.encoding);
  switch (ast._tag) {
    case "Objects": {
      const types = ast.propertySignatures.map((property) =>
        keepingPersonDecidesStrict(property.type),
      );
      const indexTypes = ast.indexSignatures.map((index) => keepingPersonDecidesStrict(index.type));
      if (
        encoding === ast.encoding &&
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
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (property, index) =>
            new SchemaAST.PropertySignature(property.name, types[index] ?? property.type),
        ),
        ast.indexSignatures.map(
          (signature, index) =>
            new SchemaAST.IndexSignature(signature.parameter, indexTypes[index] ?? signature.type),
        ),
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Arrays": {
      const elements = ast.elements.map(keepingPersonDecidesStrict);
      const rest = ast.rest.map(keepingPersonDecidesStrict);
      if (
        encoding === ast.encoding &&
        sameMembers(ast.elements, elements) &&
        sameMembers(ast.rest, rest)
      ) {
        return ast;
      }
      return new SchemaAST.Arrays(
        ast.isMutable,
        elements,
        rest,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Union": {
      const types = ast.types.map(keepingPersonDecidesStrict);
      if (encoding === ast.encoding && sameMembers(ast.types, types)) return ast;
      return new SchemaAST.Union(
        types,
        ast.options,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      );
    }
    case "Declaration": {
      const typeParameters = ast.typeParameters.map(keepingPersonDecidesStrict);
      if (encoding === ast.encoding && sameMembers(ast.typeParameters, typeParameters)) return ast;
      return new SchemaAST.Declaration(
        typeParameters,
        ast.run,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
        ast.encodingRun,
      );
    }
    case "Suspend": {
      // A recursive schema reaches itself through `thunk`, so the target is
      // rewritten lazily, on first decode, after this node is memoized.
      const target = ast.thunk;
      return new SchemaAST.Suspend(
        () => keepingPersonDecidesStrict(target()),
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
      );
    }
    default:
      return ast;
  }
}
