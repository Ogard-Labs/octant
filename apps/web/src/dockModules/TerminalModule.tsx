import { CodeUtilityModule, type CodeUtilityProps } from "./CodeUtilityModule";
export default function TerminalModule(props: CodeUtilityProps) {
  return <CodeUtilityModule {...props} surface="terminal" />;
}
