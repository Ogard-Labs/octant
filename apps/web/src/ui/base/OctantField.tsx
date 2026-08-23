import type { ComponentProps } from "react";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../shadcn/field";

export function OctantFieldGroup(props: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup {...props} />;
}

export function OctantField(props: ComponentProps<typeof Field>) {
  return <Field {...props} />;
}

export function OctantFieldLabel(props: ComponentProps<typeof FieldLabel>) {
  return <FieldLabel {...props} />;
}

export function OctantFieldDescription(props: ComponentProps<typeof FieldDescription>) {
  return <FieldDescription {...props} />;
}

export function OctantFieldError(props: ComponentProps<typeof FieldError>) {
  return <FieldError {...props} />;
}
