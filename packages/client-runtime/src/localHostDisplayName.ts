export interface LocalHostNavigator {
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
  readonly platform?: string | undefined;
}

export function localHostDisplayName(
  navigatorLike: LocalHostNavigator | undefined = defaultNavigator(),
): string {
  const platform = navigatorLike?.userAgentData?.platform ?? navigatorLike?.platform ?? "";
  return /^(mac|iphone|ipad|ipod)/i.test(platform) ? "This Mac" : "This computer";
}

function defaultNavigator(): LocalHostNavigator | undefined {
  return typeof globalThis.navigator === "undefined" ? undefined : globalThis.navigator;
}
