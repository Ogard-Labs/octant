// Mechanical cleanup uses no Node exports, peer admission or application
// launch.
#define OCTANT_PEER_TRANSPORT_TEST
#include "desktopPeerStatus.mm"
#include <cstdio>
#include <cstdlib>
static void check(bool value) {
  if (!value)
    std::exit(2);
}
int main() {
  auto late = std::make_shared<PendingLaunch>();
  check(launches.load() == 1);
  const auto refusal =
      close_status(Clock::now() + std::chrono::milliseconds(10));
  check(refusal.kind == "failed" && refusal.reason == "deadline-exceeded");
  check(!late->finished && launches.load() == 1);
  finish_launch(late, false);
  finish_launch(late, true);
  check(launches.load() == 0 && late->finished && !late->accepted);
  check(close_status(Clock::now() + std::chrono::milliseconds(10)).kind ==
        "closed");
  auto completed = std::make_shared<PendingLaunch>();
  finish_launch(completed, true);
  finish_launch(completed, false);
  check(launches.load() == 0 && completed->accepted);
  check(close_status(Clock::now() + std::chrono::milliseconds(10)).kind ==
        "closed");
  std::puts("pending launch cleanup passed");
}
