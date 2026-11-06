// A standalone mechanical test build has no Node API exports or advertised
// endpoint. It seeds only its own port to exercise production receive cleanup.
#define OCTANT_PEER_TRANSPORT_TEST
#include "desktopPeerStatus.mm"
#include <cstdio>
#include <cstdlib>

static void check(bool value, const char *message) {
  if (!value) {
    std::fprintf(stderr, "%s\n", message);
    std::exit(2);
  }
}
static mach_port_t port() {
  mach_port_t value = MACH_PORT_NULL;
  check(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &value) ==
            KERN_SUCCESS,
        "port allocate");
  check(mach_port_insert_right(mach_task_self(), value, value,
                               MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS,
        "send right");
  return value;
}
static void send(mach_msg_header_t &header) {
  check(mach_msg(&header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, header.msgh_size,
                 0, MACH_PORT_NULL, 500, MACH_PORT_NULL) == KERN_SUCCESS,
        "bounded send");
}
static bool no_send_refs(mach_port_t value) {
  mach_port_urefs_t refs = 0;
  auto result =
      mach_port_get_refs(mach_task_self(), value, MACH_PORT_RIGHT_SEND, &refs);
  return result == KERN_INVALID_RIGHT || (result == KERN_SUCCESS && refs == 0);
}
int main() {
  alarm(15);
  Scope scope;
  check(read_scope(scope), "valid current login scope");
  auto owned = std::make_shared<State>();
  auto server = port();
  owned->receive = server;
  owned->finished = false;
  Identity self;
  self.scope = scope;
  self.version = "0.0.0-test";
  owned->worker = std::thread(serve, owned, self, server);
  auto oversized_right = port(), malformed_right = port();
  struct Oversized {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t right;
    char padding[2048];
  } large{};
  large.header.msgh_bits =
      MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  large.header.msgh_size = sizeof(large);
  large.header.msgh_remote_port = server;
  large.header.msgh_id = request_id;
  large.body.msgh_descriptor_count = 1;
  large.right.name = oversized_right;
  large.right.disposition = MACH_MSG_TYPE_MOVE_SEND;
  large.right.type = MACH_MSG_PORT_DESCRIPTOR;
  send(large.header);
  struct Malformed {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t right;
  } malformed{};
  malformed.header.msgh_bits =
      MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  malformed.header.msgh_size = sizeof(malformed);
  malformed.header.msgh_remote_port = server;
  malformed.header.msgh_id = request_id;
  malformed.body.msgh_descriptor_count = 1;
  malformed.right.name = malformed_right;
  malformed.right.disposition = MACH_MSG_TYPE_MOVE_SEND;
  malformed.right.type = MACH_MSG_PORT_DESCRIPTOR;
  send(malformed.header);
  auto reply = port();
  StatusMessage request;
  request.header.msgh_bits =
      MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = server;
  request.header.msgh_local_port = reply;
  request.header.msgh_id = request_id;
  send(request.header);
  Received received{};
  check(receive(reply, received, 3000) == KERN_SUCCESS,
        "valid followup survived oversized/malformed messages");
  check(received.header.msgh_size == sizeof(StatusMessage) &&
            received.header.msgh_id == reply_id,
        "bounded refusal shape");
  check(reinterpret_cast<StatusMessage *>(&received)->status == 2,
        "unsigned test peer refused");
  release_received(received);
  check(no_send_refs(oversized_right), "oversized transferred right disposed");
  check(no_send_refs(malformed_right), "malformed transferred right disposed");
  stop(owned);
  owned->worker.join();
  check(owned->finished, "receive worker exited");
  mach_port_destroy(mach_task_self(), reply);
  mach_port_destroy(mach_task_self(), oversized_right);
  mach_port_destroy(mach_task_self(), malformed_right);
  alarm(0);
  std::puts("{\"oversizedFollowup\":true,\"malformedRightsDisposed\":true,"
            "\"unsignedRefused\":true,\"workerJoined\":true}");
}
