import { CodeUtilityModule, type CodeUtilityProps } from "./CodeUtilityModule";
export default function SimulatorModule(props: CodeUtilityProps) {
  return <CodeUtilityModule {...props} surface="ios-simulator" />;
}
