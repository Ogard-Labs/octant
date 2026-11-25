import {
  createNavigatorFactory,
  getFocusedRouteNameFromRoute,
  TabActions,
  TabRouter,
  useNavigationBuilder,
  type DefaultNavigatorOptions,
  type NavigationAction,
  type ParamListBase,
  type Router,
  type TabActionHelpers,
  type TabNavigationState,
  type TabRouterOptions,
} from "@react-navigation/native";
import { useRef, type ReactNode } from "react";
import { PlaceTabs } from "./PlaceTabs";
import { placeFor, screenHidesNew, type MobilePlaceId } from "./places";

type PlaceTabEvents = {
  tabPress: { data: undefined; canPreventDefault: true };
};

type Props = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  TabNavigationState<ParamListBase>,
  object,
  PlaceTabEvents,
  unknown
> &
  TabRouterOptions & {
    readonly onNew: () => void;
    readonly newDisabled: boolean;
  };

// The library declares the actions a tab router takes as a narrower type than
// the one it dispatches, which exact optional types keep apart.
function placeRouter(
  options: TabRouterOptions,
): Router<TabNavigationState<ParamListBase>, NavigationAction> {
  // Its jump helpers are left out: this navigator dispatches the jump itself.
  const { actionCreators: _jumpHelpers, ...router } = TabRouter(options);
  return {
    ...router,
    getStateForAction: (state, action, config) =>
      router.getStateForAction(
        state,
        action as Parameters<typeof router.getStateForAction>[1],
        config,
      ),
  };
}

/** The places as one tab state. Each keeps its own stack while another is open. */
function PlaceTabNavigator({ onNew, newDisabled, ...options }: Props) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    object,
    PlaceTabEvents
  >(placeRouter, options);
  // A place is mounted the first time it is opened, and kept after that.
  const opened = useRef(new Set<string>());
  const focused = state.routes[state.index];
  if (focused !== undefined) opened.current.add(focused.key);

  const screens: Partial<Record<MobilePlaceId, ReactNode>> = {};
  for (const route of state.routes) {
    if (opened.current.has(route.key)) {
      screens[placeFor(route.name)] = descriptors[route.key]?.render();
    }
  }

  return (
    <NavigationContent>
      <PlaceTabs
        active={placeFor(focused?.name ?? "home")}
        newHidden={
          focused !== undefined && screenHidesNew(getFocusedRouteNameFromRoute(focused) ?? "")
        }
        newDisabled={newDisabled}
        onNew={onNew}
        onSelect={(place) => {
          const route = state.routes.find((entry) => entry.name === place);
          if (route === undefined) return;
          // The place's own stack hears this and returns to its root when it is
          // already the open one.
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (route.key !== focused?.key && !event.defaultPrevented) {
            navigation.dispatch({ ...TabActions.jumpTo(route.name), target: state.key });
          }
        }}
        screens={screens}
      />
    </NavigationContent>
  );
}

export const createPlaceTabNavigator = createNavigatorFactory(PlaceTabNavigator);
