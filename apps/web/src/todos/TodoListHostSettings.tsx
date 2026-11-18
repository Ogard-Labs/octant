import type { StableHostId } from "@octant/contracts/remote-access";
import type { TodoListHostChoice, TodoListHostView } from "@octant/contracts/todos";
import { createContext, useContext, useState } from "react";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantSelectField } from "../ui/base/OctantSelect";

export type TodoListHostRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: TodoListHostView }
  | { readonly status: "failed"; readonly message: string };

/** A computer this window is paired with, which could keep the list. */
export interface TodoListHostComputer {
  readonly hostId: StableHostId;
  readonly name: string;
}

export interface TodoListHostSettingsValue {
  readonly read: TodoListHostRead;
  readonly computers: ReadonlyArray<TodoListHostComputer>;
  /** Resolves to the host's refusal or failure, or undefined once saved. */
  readonly choose: (choice: TodoListHostChoice) => Promise<string | undefined>;
}

export const TodoListHostSettingsContext = createContext<TodoListHostSettingsValue | undefined>(
  undefined,
);

const THIS_HOST = "this-host";

const FACT =
  "One computer keeps your to-do list. Every window and phone you connect shows it. A computer you choose is reached through this window's pairing with it.";

/** Settings › To-dos: which computer keeps the person's list. */
export function TodoListHostSettings() {
  const value = useContext(TodoListHostSettingsContext);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (value === undefined || value.read.status !== "ready") {
    return (
      <SettingsSection description={FACT} title="To-dos">
        <SettingsState kind={value?.read.status === "failed" ? "error" : "loading"}>
          {value?.read.status === "failed" ? value.read.message : "Reading where the list is kept…"}
        </SettingsState>
      </SettingsSection>
    );
  }
  const { view } = value.read;
  const current = view.choice.kind === "this-host" ? THIS_HOST : String(view.choice.hostId);
  const computers = [...value.computers];
  // A computer chosen from another window may not be paired from this one; it
  // still shows, so the setting never reads as something it is not.
  if (
    view.choice.kind === "other-host" &&
    !computers.some((computer) => String(computer.hostId) === current)
  ) {
    computers.push({ hostId: view.choice.hostId, name: view.choice.name });
  }
  const options = [
    { id: THIS_HOST, label: "This computer" },
    ...computers.map((computer) => ({ id: String(computer.hostId), label: computer.name })),
  ];
  const locked = !view.ownListEmpty && view.choice.kind === "this-host";
  return (
    <SettingsSection description={FACT} title="To-dos">
      <div className="setgroup">
        <SettingRow
          description={
            locked
              ? "This computer already keeps to-dos, so the list stays here. Moving it is not possible yet."
              : computers.length === 0
                ? "To keep the list on another computer, pair it in Other computers."
                : "The list can move only while this computer has no to-dos."
          }
          label="Keep the list on"
          scope="host"
          settingId="todo-list-host"
        >
          <OctantSelectField
            aria-label="Keep the list on"
            disabled={busy || locked}
            onValueChange={async (id) => {
              const computer = computers.find((entry) => String(entry.hostId) === id);
              const choice: TodoListHostChoice =
                id === THIS_HOST || computer === undefined
                  ? { kind: "this-host" }
                  : { kind: "other-host", hostId: computer.hostId, name: computer.name };
              setBusy(true);
              setProblem(await value.choose(choice));
              setBusy(false);
            }}
            options={options}
            value={current}
          />
        </SettingRow>
        {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
      </div>
    </SettingsSection>
  );
}
