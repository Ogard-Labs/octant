import { createContext, useContext, type ReactNode } from "react";

const UsageNames = createContext<ReadonlyMap<string, string>>(new Map());

export function UsageNamesProvider(props: {
  readonly names: ReadonlyMap<string, string>;
  readonly children: ReactNode;
}) {
  return <UsageNames.Provider value={props.names}>{props.children}</UsageNames.Provider>;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  provider: "Provider",
  "chat-thread": "Chat",
  "work-thread": "Work task",
  "code-thread": "Code task",
  project: "Project",
  host: "Host",
  thread: "Task",
};

/** Resolve only already-loaded identities; opening Usage never fetches task content. */
export function UsageName(props: { readonly kind: string; readonly id: string }) {
  const names = useContext(UsageNames);
  const known = names.get(props.kind === "thread" ? props.id : `${props.kind}/${props.id}`);
  const fallback =
    props.id.length > 24
      ? `${KIND_LABELS[props.kind] ?? "Item"} · ${props.id.slice(0, 8)}…`
      : props.id;
  return <span title={props.id}>{known ?? fallback}</span>;
}
