// Standalone mechanical build: no Node exports, advertised endpoint or
// authenticated test admission. It seeds only this fixture's receive right.
#define OCTANT_PEER_TRANSPORT_TEST
#define OCTANT_WINDOW_TRANSPORT_TEST
#include "desktopPeerStatus.mm"
namespace {
#include "desktopPeerWindows.h"
}
#include <cstdio>
#include <cstdlib>

static void check(bool value, const char *message) {
  if (!value) {
    std::fprintf(stderr, "%s\n", message);
    std::exit(2);
  }
}
static mach_port_t port() {
  mach_port_t result = MACH_PORT_NULL;
  check(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE,
                           &result) == KERN_SUCCESS,
        "allocate fixture right");
  check(mach_port_insert_right(mach_task_self(), result, result,
                               MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS,
        "insert fixture right");
  return result;
}
static void send(mach_msg_header_t &header) {
  check(mach_msg(&header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, header.msgh_size,
                 0, MACH_PORT_NULL, 500, MACH_PORT_NULL) == KERN_SUCCESS,
        "send fixture message");
}
static bool disposed(mach_port_t right) {
  mach_port_urefs_t references = 0;
  const auto result = mach_port_get_refs(mach_task_self(), right,
                                         MACH_PORT_RIGHT_SEND, &references);
  return result == KERN_INVALID_RIGHT ||
         (result == KERN_SUCCESS && references == 0);
}
int main() {
  alarm(15);
  Scope scope;
  check(read_scope(scope), "current native login scope");
  auto owned = std::make_shared<WindowState>();
  window_state = owned;
  auto server = port();
  owned->receive = server;
  owned->finished = false;
  Identity self;
  self.scope = scope;
  self.version = "0.0.0-fixture";
  owned->worker = std::thread(serve_windows, owned, self, server);
  const auto oversizedRight = port(), malformedRight = port();
  struct Oversized {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t right;
    char padding[8192];
  } oversized{};
  oversized.header.msgh_bits =
      MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  oversized.header.msgh_size = sizeof(oversized);
  oversized.header.msgh_remote_port = server;
  oversized.header.msgh_id = window_request_id;
  oversized.body.msgh_descriptor_count = 1;
  oversized.right.name = oversizedRight;
  oversized.right.disposition = MACH_MSG_TYPE_MOVE_SEND;
  oversized.right.type = MACH_MSG_PORT_DESCRIPTOR;
  send(oversized.header);
  struct Malformed {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t right;
  } malformed{};
  malformed.header.msgh_bits =
      MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  malformed.header.msgh_size = sizeof(malformed);
  malformed.header.msgh_remote_port = server;
  malformed.header.msgh_id = window_request_id;
  malformed.body.msgh_descriptor_count = 1;
  malformed.right.name = malformedRight;
  malformed.right.disposition = MACH_MSG_TYPE_MOVE_SEND;
  malformed.right.type = MACH_MSG_PORT_DESCRIPTOR;
  send(malformed.header);
  auto replyPort = port();
  WindowWire request;
  request.operation = 1;
  request.generation = 1;
  std::strcpy(request.window, "00000000-0000-4000-8000-000000000593");
  request.header.msgh_bits =
      MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = server;
  request.header.msgh_local_port = replyPort;
  request.header.msgh_id = window_request_id;
  send(request.header);
  WindowReceived received{};
  check(receive_window(replyPort, received, 3000) == KERN_SUCCESS,
        "valid followup survives malformed/oversized queue messages");
  check(received.header.msgh_size == sizeof(WindowWire) &&
            received.header.msgh_id == window_reply_id,
        "closed window refusal shape");
  const auto *reply = reinterpret_cast<WindowWire *>(&received);
  check(reply->generation == 1 &&
            std::strcmp(reply->window, request.window) == 0 &&
            std::strstr(reply->payload, "refused"),
        "actual unsigned/wrong-identity peer refused");
  mach_msg_destroy(&received.header);
  check(disposed(oversizedRight) && disposed(malformedRight),
        "both unexpected transferred rights disposed");
  const auto closed =
      close_windows(Clock::now() + std::chrono::milliseconds(1000));
  check(closed.kind == "closed" && !owned->worker.joinable(),
        "owned receive worker joined");
  for (auto right : {oversizedRight, malformedRight, replyPort})
    mach_port_destroy(mach_task_self(), right);
  std::puts("{\"kind\":\"window-transport-mechanical-passed\","
            "\"authenticatedAdmissionTested\":false,\"workerJoined\":true}");
}
