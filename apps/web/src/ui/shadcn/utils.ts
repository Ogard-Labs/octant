import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names for owned shadcn recipes. */
export function cn(...inputs: Array<ClassValue>): string {
  return twMerge(clsx(inputs));
}
