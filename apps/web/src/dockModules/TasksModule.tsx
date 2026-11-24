import "./tasks-dock.css";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { ThreadTasksPanel } from "../transcript/ThreadTasksPanel";
import { useThreadTaskList } from "../transcript/threadTaskLists";
import { OctantEmpty } from "../ui/base/OctantEmpty";

type Props = Pick<ThreadUtilityDockContentProps, "subject">;

/**
 * The thread's newest task list, kept in view beside the thread for a person
 * who opened it from More tools. It is the list the transcript shows, read
 * from the thread's own view, so the two never disagree.
 */
export default function TasksModule(props: Props) {
  const tasks = useThreadTaskList(props.subject.threadId);
  return (
    <section aria-label="Tasks" className="tasks-dock">
      {tasks === undefined ? (
        <OctantEmpty
          message="When the agent writes a task list for its work, it shows here."
          state="neutral"
          title="No task list yet"
        />
      ) : (
        <ThreadTasksPanel alwaysOpen tasks={tasks} />
      )}
    </section>
  );
}
