import { CodeUtilityModule, type CodeUtilityProps } from "./CodeUtilityModule";
export default function TestsModule(props: CodeUtilityProps) {
  return <CodeUtilityModule {...props} surface="tests" />;
}
