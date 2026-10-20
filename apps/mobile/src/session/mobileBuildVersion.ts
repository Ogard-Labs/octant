import Constants from "expo-constants";
import { MOBILE_PRODUCT_NAME } from "../copy";

/**
 * The build identifier sent to hosts. It reads the app version from the Expo
 * config so it moves with each release instead of staying at a literal that
 * nobody updates; "unknown" marks a runtime that exposes no config.
 */
export function mobileBuildVersion(): string {
  return `${MOBILE_PRODUCT_NAME}-mobile/${Constants.expoConfig?.version ?? "unknown"}`;
}
