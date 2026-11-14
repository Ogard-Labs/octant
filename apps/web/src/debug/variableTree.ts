import type { CodeDebugVariable } from "@octant/contracts/code-debug";
import type { DebugSessionView } from "./useCodeDebugSession";

/** Nested values open at most this deep, so a value that holds itself stops somewhere. */
export const MAX_VARIABLE_DEPTH = 8;

/**
 * One visible line of the Variables tree. The tree is drawn as a flat list so
 * a scope with thousands of values can be virtualized; each row carries the
 * level, sibling count, and position a nested list used to convey.
 */
export type VariableTreeRow =
  | {
      readonly kind: "scope";
      readonly key: string;
      readonly level: 1;
      readonly setSize: number;
      readonly posInSet: number;
      readonly name: string;
      readonly reference: number;
      readonly loaded: boolean;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "variable";
      readonly key: string;
      readonly level: number;
      readonly setSize: number;
      readonly posInSet: number;
      readonly variable: CodeDebugVariable;
      readonly expandable: boolean;
      readonly expanded: boolean;
      readonly loaded: boolean;
    }
  | {
      /** The host cut the list short: said once, after the values it sent. */
      readonly kind: "more";
      readonly key: string;
      readonly level: number;
    };

/**
 * The rows a person can see: every scope, and the values under each scope
 * and variable they opened. A scope is open unless closed; a variable is
 * closed unless opened. Keys are paths, so a variable that keeps its name and
 * position across a step keeps its open state, while a new stop (a new scope
 * reference) starts closed, as the nested tree did.
 */
export function visibleVariableRows(
  view: Pick<DebugSessionView, "scopes" | "children">,
  closedScopes: ReadonlySet<number>,
  openVariables: ReadonlySet<string>,
): ReadonlyArray<VariableTreeRow> {
  const rows: VariableTreeRow[] = [];
  const addVariables = (
    parentKey: string,
    variables: ReadonlyArray<CodeDebugVariable>,
    truncated: boolean,
    level: number,
  ) => {
    variables.forEach((variable, index) => {
      const key = `${parentKey}/${String(index)}:${variable.name}`;
      const expandable = variable.variablesReference > 0 && level - 1 < MAX_VARIABLE_DEPTH;
      const children = expandable ? view.children.get(variable.variablesReference) : undefined;
      const expanded = expandable && openVariables.has(key);
      rows.push({
        kind: "variable",
        key,
        level,
        setSize: variables.length,
        posInSet: index + 1,
        variable,
        expandable,
        expanded,
        loaded: children !== undefined,
      });
      if (expanded && children !== undefined) {
        addVariables(key, children.variables, children.truncated, level + 1);
      }
    });
    if (truncated) rows.push({ kind: "more", key: `${parentKey}/more`, level });
  };
  view.scopes.forEach((scopeView, index) => {
    const reference = scopeView.scope.variablesReference;
    const key = `${scopeView.scope.name}-${String(reference)}`;
    const expanded = scopeView.variables !== undefined && !closedScopes.has(reference);
    rows.push({
      kind: "scope",
      key,
      level: 1,
      setSize: view.scopes.length,
      posInSet: index + 1,
      name: scopeView.scope.name,
      reference,
      loaded: scopeView.variables !== undefined,
      expanded,
    });
    if (expanded && scopeView.variables !== undefined) {
      addVariables(key, scopeView.variables, scopeView.truncated === true, 2);
    }
  });
  return rows;
}
