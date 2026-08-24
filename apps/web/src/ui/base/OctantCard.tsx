import type { ComponentProps } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../shadcn/card";

export function OctantCard(props: ComponentProps<typeof Card>) {
  return <Card {...props} />;
}

export function OctantCardHeader(props: ComponentProps<typeof CardHeader>) {
  return <CardHeader {...props} />;
}

export function OctantCardTitle(props: ComponentProps<typeof CardTitle>) {
  return <CardTitle {...props} />;
}

export function OctantCardDescription(props: ComponentProps<typeof CardDescription>) {
  return <CardDescription {...props} />;
}

export function OctantCardContent(props: ComponentProps<typeof CardContent>) {
  return <CardContent {...props} />;
}

export function OctantCardFooter(props: ComponentProps<typeof CardFooter>) {
  return <CardFooter {...props} />;
}
