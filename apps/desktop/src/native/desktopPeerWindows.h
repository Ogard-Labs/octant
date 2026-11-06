// Included by the desktop-main binding after its shared audit/signature policy.
// The status wire stays unchanged; this is a separate fixed window protocol.

constexpr mach_msg_id_t window_request_id = 0x4f435411,
                        window_reply_id = 0x4f435412;
struct WindowWire {
  mach_msg_header_t header{};
  uint32_t magic = wire_magic, protocol = 1, operation = 0;
  uint64_t generation = 0;
  char window[37]{};
  char payload[4096]{};
};
union WindowReceived {
  mach_msg_header_t header;
  unsigned char
      bytes[sizeof(WindowWire) + sizeof(mach_msg_audit_trailer_t) + 8];
};
struct WindowEnvelope {
  WindowReceived &message;
  ~WindowEnvelope() { mach_msg_destroy(&message.header); }
};
struct WindowPending {
  std::mutex lock;
  std::condition_variable changed;
  std::string payload;
  bool answered = false;
  Deadline deadline;
};
struct WindowPeer {
  int watch = -1;
  audit_token_t token{};
  ~WindowPeer() {
    if (watch >= 0)
      ::close(watch);
  }
};
struct WindowNotice {
  std::string peer, window, operation;
  uint64_t request = 0, generation = 0;
  bool exited = false, native_main = false;
};
// A client that accepts the native-main bootstrap fields names this after the
// request payload's leading NUL. The first window server checked only that
// first byte, so it still answers such a client with its original bootstrap,
// and an older client that sends nothing gets that original bootstrap too.
constexpr char native_main_marker[] = "native-main-v1";
bool window_request_payload(const WindowWire &request, bool &native_main) {
  if (request.payload[0] != 0)
    return false;
  const char *text = request.payload + 1;
  const size_t length = strnlen(text, sizeof(request.payload) - 1);
  if (length == sizeof(request.payload) - 1)
    return false;
  native_main = length != 0;
  return length == 0 || std::strcmp(text, native_main_marker) == 0;
}
struct WindowState {
  std::atomic<bool> stopping = false, finished = true;
  std::mutex lock;
  mach_port_t receive = MACH_PORT_NULL;
  std::thread worker;
  napi_threadsafe_function callback = nullptr;
  std::map<uint64_t, std::shared_ptr<WindowPending>> pending;
  uint64_t next_request = 1;
  ~WindowState() {
    if (worker.joinable())
      worker.detach();
  }
};
std::shared_ptr<WindowState> window_state = std::make_shared<WindowState>();
std::atomic<bool> window_start_pending = false, window_call_pending = false,
                  window_stop_pending = false;
std::atomic<unsigned> window_validations = 0;
std::string window_endpoint(const Scope &scope) {
  return "app.octant.desktop.windows.v1." + std::to_string(scope.euid) + "." +
         std::to_string(scope.session);
}
std::string peer_key(audit_token_t token) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(&token, sizeof(token), hash);
  static constexpr char hex[] = "0123456789abcdef";
  std::string result;
  for (auto byte : hash) {
    result += hex[byte >> 4];
    result += hex[byte & 15];
  }
  return result;
}
bool window_audit(const WindowReceived &received, audit_token_t &token) {
  const size_t size = received.header.msgh_size;
  if (size != sizeof(WindowWire))
    return false;
  const size_t offset = (size + 3) & ~size_t(3);
  if (offset + sizeof(mach_msg_audit_trailer_t) > sizeof(received))
    return false;
  const auto *trailer = reinterpret_cast<const mach_msg_audit_trailer_t *>(
      received.bytes + offset);
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      trailer->msgh_trailer_size < sizeof(*trailer))
    return false;
  token = trailer->msgh_audit;
  return true;
}
kern_return_t receive_window(mach_port_t port, WindowReceived &received,
                             unsigned milliseconds) {
  std::memset(&received, 0, sizeof(received));
  return mach_msg(&received.header,
                  MACH_RCV_MSG | MACH_RCV_TIMEOUT |
                      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                  0, sizeof(received), port, milliseconds, MACH_PORT_NULL);
}
void emit_window(const std::shared_ptr<WindowState> &owned,
                 std::unique_ptr<WindowNotice> notice) {
  std::lock_guard guard(owned->lock);
#ifndef OCTANT_WINDOW_TRANSPORT_TEST
  if (!owned->stopping && owned->callback &&
      napi_call_threadsafe_function(owned->callback, notice.get(),
                                    napi_tsfn_nonblocking) == napi_ok)
    notice.release();
#else
  (void)notice;
#endif
}
bool peer_has_exited(WindowPeer &peer) {
  struct kevent event{};
  const timespec immediate{};
  const int result = kevent(peer.watch, nullptr, 0, &event, 1, &immediate);
  return result < 0 || (result == 1 && (event.fflags & NOTE_EXIT));
}
std::unique_ptr<WindowPeer> watch_window_peer(audit_token_t token,
                                              const Identity &self,
                                              Deadline deadline) {
  auto peer = std::make_unique<WindowPeer>();
  peer->token = token;
  peer->watch = kqueue();
  if (peer->watch < 0)
    return nullptr;
  struct kevent event{};
  EV_SET(&event, audit_token_to_pid(token), EVFILT_PROC,
         EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
  if (kevent(peer->watch, &event, 1, nullptr, 0, nullptr) != 0)
    return nullptr;
  // Installing a PID watch alone does not bind an incarnation. Re-check the
  // kernel audit token after installation, and refuse an already-dead peer.
  Identity verified;
  std::string reason;
  if (!validate_identity(token, self.scope, false, self.team, verified,
                         deadline, reason) ||
      peer_has_exited(*peer))
    return nullptr;
  return peer;
}
void stop_windows() {
  const auto owned = window_state;
  owned->stopping = true;
  std::lock_guard guard(owned->lock);
  if (owned->receive != MACH_PORT_NULL) {
    mach_port_destroy(mach_task_self(), owned->receive);
    owned->receive = MACH_PORT_NULL;
  }
  for (const auto &[id, pending] : owned->pending) {
    (void)id;
    pending->changed.notify_all();
  }
}
void serve_windows(std::shared_ptr<WindowState> owned, Identity self,
                   mach_port_t port) {
  std::map<std::string, std::unique_ptr<WindowPeer>> peers;
  while (!owned->stopping) {
    for (auto it = peers.begin(); it != peers.end();) {
      if (!peer_has_exited(*it->second)) {
        ++it;
        continue;
      }
      auto notice = std::make_unique<WindowNotice>();
      notice->exited = true;
      notice->peer = it->first;
      emit_window(owned, std::move(notice));
      it = peers.erase(it);
    }
    WindowReceived received{};
    const auto code = receive_window(port, received, 100);
    if (code == MACH_RCV_TIMED_OUT || code == MACH_RCV_TOO_LARGE)
      continue;
    if (code != KERN_SUCCESS)
      break;
    WindowEnvelope envelope{received};
    audit_token_t token{};
    auto *request = reinterpret_cast<WindowWire *>(&received);
    bool native_main = false;
    if ((received.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
        !window_audit(received, token) ||
        received.header.msgh_id != window_request_id ||
        request->magic != wire_magic || request->protocol != 1 ||
        request->operation < 1 || request->operation > 3 ||
        request->generation < 1 || request->generation > 9007199254740991ULL ||
        request->window[36] != 0 || std::strlen(request->window) != 36 ||
        !window_request_payload(*request, native_main) ||
        received.header.msgh_remote_port == MACH_PORT_NULL ||
        MACH_MSGH_BITS_REMOTE(received.header.msgh_bits) !=
            MACH_MSG_TYPE_PORT_SEND_ONCE) {
      continue;
    }
    const auto deadline = Clock::now() + operation_bound;
    Identity peer;
    std::string reason;
    bool accepted = false;
    ++validations;
    try {
      accepted = validate_identity(token, self.scope, false, self.team, peer,
                                   deadline, reason);
    } catch (...) {
    }
    --validations;
    const auto key = peer_key(token);
    if (accepted && !peers.contains(key)) {
      if (peers.size() >= 32)
        accepted = false;
      else {
        auto watched = watch_window_peer(token, self, deadline);
        if (!watched)
          accepted = false;
        else
          peers.emplace(key, std::move(watched));
      }
    }
    std::string payload =
        "{\"kind\":\"refused\",\"reason\":\"invalid-request\"}";
    if (accepted && !owned->stopping && !expired(deadline)) {
      auto pending = std::make_shared<WindowPending>();
      pending->deadline = deadline;
      uint64_t id;
      {
        std::lock_guard guard(owned->lock);
        id = owned->next_request++;
        owned->pending.emplace(id, pending);
      }
      auto notice = std::make_unique<WindowNotice>();
      notice->request = id;
      notice->peer = key;
      notice->window = request->window;
      notice->generation = request->generation;
      notice->native_main = native_main;
      notice->operation = request->operation == 1   ? "register"
                          : request->operation == 2 ? "renew"
                                                    : "revoke";
      emit_window(owned, std::move(notice));
      {
        std::unique_lock guard(pending->lock);
        pending->changed.wait_until(guard, deadline, [&] {
          return owned->stopping || pending->answered;
        });
        if (pending->answered && !expired(deadline))
          payload = pending->payload;
      }
      {
        std::lock_guard guard(owned->lock);
        owned->pending.erase(id);
      }
    }
    if (!owned->stopping && !expired(deadline)) {
      WindowWire reply;
      reply.operation = request->operation;
      reply.generation = request->generation;
      std::memcpy(reply.window, request->window, sizeof(reply.window));
      std::memcpy(reply.payload, payload.data(),
                  std::min(payload.size(), sizeof(reply.payload) - 1));
      reply.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
      reply.header.msgh_size = sizeof(reply);
      reply.header.msgh_remote_port = received.header.msgh_remote_port;
      reply.header.msgh_id = window_reply_id;
      received.header.msgh_remote_port = MACH_PORT_NULL;
      if (mach_msg(&reply.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                   sizeof(reply), 0, MACH_PORT_NULL, 100,
                   MACH_PORT_NULL) != KERN_SUCCESS)
        mach_msg_destroy(&reply.header);
    }
  }
  {
    std::lock_guard guard(owned->lock);
    if (owned->receive != MACH_PORT_NULL) {
      mach_port_destroy(mach_task_self(), owned->receive);
      owned->receive = MACH_PORT_NULL;
    }
  }
  peers.clear();
  owned->finished = true;
}
Result start_windows(Deadline deadline) {
  Identity self;
  Result result;
  if (!self_identity(true, self, deadline, result.reason))
    return result;
  auto owned = window_state;
  std::lock_guard guard(owned->lock);
  if (owned->stopping || !owned->callback)
    return result;
  if (owned->receive != MACH_PORT_NULL)
    return {"started", {}, {}};
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) !=
      KERN_SUCCESS)
    return result;
  mach_port_limits_t limits{4};
  if (mach_port_set_attributes(mach_task_self(), port, MACH_PORT_LIMITS_INFO,
                               reinterpret_cast<mach_port_info_t>(&limits),
                               MACH_PORT_LIMITS_INFO_COUNT) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), port, port,
                             MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS ||
      bootstrap_register(bootstrap_port, window_endpoint(self.scope).data(),
                         port) != KERN_SUCCESS ||
      expired(deadline)) {
    mach_port_destroy(mach_task_self(), port);
    return result;
  }
  owned->receive = port;
  owned->finished = false;
  try {
    owned->worker = std::thread([owned, self, port] {
      try {
        serve_windows(owned, self, port);
      } catch (...) {
        stop_windows();
        owned->finished = true;
      }
    });
  } catch (...) {
    owned->receive = MACH_PORT_NULL;
    owned->finished = true;
    mach_port_destroy(mach_task_self(), port);
    return result;
  }
  return {"started", {}, {}};
}
std::string call_window(uint32_t operation, const std::string &window,
                        uint64_t generation, Deadline deadline) {
  Identity self;
  std::string reason;
  auto refusal = [](const std::string &why) {
    return "{\"kind\":\"refused\",\"reason\":\"" + why + "\"}";
  };
  if (!self_identity(false, self, deadline, reason))
    return refusal(reason);
  mach_port_t server = MACH_PORT_NULL, reply = MACH_PORT_NULL;
  if (bootstrap_look_up(bootstrap_port, window_endpoint(self.scope).c_str(),
                        &server) != KERN_SUCCESS)
    return refusal("not-running");
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply) !=
      KERN_SUCCESS) {
    mach_port_deallocate(mach_task_self(), server);
    return refusal("native-unavailable");
  }
  WindowWire request;
  request.operation = operation;
  request.generation = generation;
  std::memcpy(request.window, window.c_str(), window.size() + 1);
  std::memcpy(request.payload + 1, native_main_marker, sizeof(native_main_marker));
  request.header.msgh_bits =
      MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = server;
  request.header.msgh_local_port = reply;
  request.header.msgh_id = window_request_id;
  auto code = mach_msg(&request.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                       sizeof(request), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  std::string answer = refusal("invalid-peer");
  if (code == KERN_SUCCESS) {
    WindowReceived received{};
    const auto remaining = std::max<int64_t>(
        1, std::chrono::duration_cast<std::chrono::milliseconds>(deadline -
                                                                 Clock::now())
               .count());
    code = receive_window(reply, received, static_cast<unsigned>(remaining));
    if (code == KERN_SUCCESS) {
      audit_token_t token{};
      auto *message = reinterpret_cast<WindowWire *>(&received);
      if (!(received.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
          window_audit(received, token) &&
          received.header.msgh_id == window_reply_id &&
          message->magic == wire_magic && message->protocol == 1 &&
          message->operation == operation &&
          message->generation == generation &&
          std::memcmp(message->window, request.window,
                      sizeof(message->window)) == 0 &&
          std::memchr(message->payload, 0, sizeof(message->payload))) {
        Identity peer;
        if (validate_identity(token, self.scope, true, self.team, peer,
                              deadline, reason))
          answer = message->payload;
      }
      mach_msg_destroy(&received.header);
    }
  }
  mach_port_destroy(mach_task_self(), reply);
  mach_port_deallocate(mach_task_self(), server);
  return expired(deadline) || code == MACH_RCV_TIMED_OUT
             ? refusal("deadline-exceeded")
             : answer;
}
Result close_windows(Deadline deadline) {
  stop_windows();
  auto owned = window_state;
  while ((!owned->finished || window_validations.load() != 0) &&
         !expired(deadline))
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (!owned->finished || window_validations.load() != 0)
    return {"failed", "deadline-exceeded", {}};
  std::lock_guard guard(owned->lock);
  if (owned->worker.joinable())
    owned->worker.join();
#ifndef OCTANT_WINDOW_TRANSPORT_TEST
  if (owned->callback) {
    napi_release_threadsafe_function(owned->callback, napi_tsfn_abort);
    owned->callback = nullptr;
  }
#endif
  return {"closed", {}, {}};
}
#ifndef OCTANT_WINDOW_TRANSPORT_TEST
void window_callback(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<WindowNotice> notice(static_cast<WindowNotice *>(data));
  if (!env || !callback)
    return;
  napi_value event, request, number, ignored, global;
  napi_create_object(env, &event);
  set(env, event, "kind", notice->exited ? "peer-exited" : "request");
  if (notice->exited)
    set(env, event, "peer", notice->peer);
  else {
    napi_create_object(env, &request);
    set(env, request, "peer", notice->peer);
    set(env, request, "windowId", notice->window);
    set(env, request, "operation", notice->operation);
    napi_create_double(env, static_cast<double>(notice->request), &number);
    napi_set_named_property(env, request, "requestId", number);
    napi_create_double(env, static_cast<double>(notice->generation), &number);
    napi_set_named_property(env, request, "generation", number);
    napi_get_boolean(env, notice->native_main, &number);
    napi_set_named_property(env, request, "nativeMain", number);
    napi_set_named_property(env, event, "request", request);
  }
  napi_get_global(env, &global);
  napi_call_function(env, global, callback, 1, &event, &ignored);
}
struct WindowJob {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string name, window, payload;
  uint64_t generation = 0;
  uint32_t operation = 0;
  Result result;
  Deadline deadline;
  bool executed = false;
};
void window_execute(napi_env, void *data) {
  auto &job = *static_cast<WindowJob *>(data);
  job.executed = true;
  try {
    if (job.name == "listenWindows")
      job.result = start_windows(job.deadline);
    else if (job.name == "stopWindows")
      job.result = close_windows(job.deadline);
    else
      job.payload =
          call_window(job.operation, job.window, job.generation, job.deadline);
  } catch (...) {
    job.result = {"refused", "native-unavailable", {}};
  }
  if (job.name != "stopWindows")
    --window_validations;
}
void window_complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<WindowJob> job(static_cast<WindowJob *>(data));
  if (!job->executed && job->name != "stopWindows")
    --window_validations;
  napi_value value;
  napi_create_object(env, &value);
  set(env, value, "kind", job->result.kind);
  if (!job->result.reason.empty())
    set(env, value, "reason", job->result.reason);
  if (status == napi_ok && !job->payload.empty()) {
    napi_value global, json, parse, input;
    napi_get_global(env, &global);
    napi_get_named_property(env, global, "JSON", &json);
    napi_get_named_property(env, json, "parse", &parse);
    napi_create_string_utf8(env, job->payload.c_str(), job->payload.size(),
                            &input);
    if (napi_call_function(env, json, parse, 1, &input, &value) != napi_ok) {
      bool pending = false;
      napi_is_exception_pending(env, &pending);
      if (pending) {
        napi_value error;
        napi_get_and_clear_last_exception(env, &error);
      }
      napi_create_object(env, &value);
      set(env, value, "kind", "refused");
      set(env, value, "reason", "invalid-receipt");
    }
  }
  napi_resolve_deferred(env, job->deferred, value);
  napi_delete_async_work(env, job->work);
  if (job->name == "listenWindows")
    window_start_pending = false;
  else if (job->name == "stopWindows")
    window_stop_pending = false;
  else
    window_call_pending = false;
}
bool window_string(napi_env env, napi_value value, std::string &result,
                   size_t cap) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > cap)
    return false;
  result.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, result.data(), result.size(),
                                 &length) != napi_ok)
    return false;
  result.resize(length);
  return result.find('\0') == std::string::npos;
}
napi_value window_operation(napi_env env, napi_callback_info info) {
  napi_value args[3];
  size_t argc = 3;
  void *raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &raw);
  const std::string name = static_cast<const char *>(raw);
  auto job = std::make_unique<WindowJob>();
  job->name = name;
  job->deadline = Clock::now() + operation_bound;
  napi_value promise;
  napi_create_promise(env, &job->deferred, &promise);
  bool valid = pthread_main_np();
  if (name == "listenWindows") {
    napi_valuetype type;
    valid = valid && argc == 1 && napi_typeof(env, args[0], &type) == napi_ok &&
            type == napi_function;
  } else if (name == "stopWindows")
    valid = valid && argc == 0;
  else {
    double generation = 0;
    valid = valid && argc == 2 &&
            window_string(env, args[0], job->window, 36) &&
            job->window.size() == 36 &&
            napi_get_value_double(env, args[1], &generation) == napi_ok &&
            generation >= 1 && generation <= 9007199254740991.0 &&
            std::floor(generation) == generation;
    if (valid)
      job->generation = static_cast<uint64_t>(generation);
    job->operation = name == "openWindow" ? 1 : name == "renewWindow" ? 2 : 3;
  }
  std::atomic<bool> &busy = name == "listenWindows" ? window_start_pending
                            : name == "stopWindows" ? window_stop_pending
                                                    : window_call_pending;
  if (!valid || busy.exchange(true)) {
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "kind", "refused");
    set(env, result, "reason", "native-unavailable");
    napi_resolve_deferred(env, job->deferred, result);
    return promise;
  }
  if (name == "listenWindows") {
    napi_value resource;
    napi_create_string_utf8(env, "desktop-client-windows", NAPI_AUTO_LENGTH,
                            &resource);
    std::lock_guard guard(window_state->lock);
    if (window_state->callback ||
        napi_create_threadsafe_function(
            env, args[0], nullptr, resource, 32, 1, nullptr, nullptr, nullptr,
            window_callback, &window_state->callback) != napi_ok) {
      busy = false;
      napi_value result;
      napi_create_object(env, &result);
      set(env, result, "kind", "refused");
      set(env, result, "reason", "native-unavailable");
      napi_resolve_deferred(env, job->deferred, result);
      return promise;
    }
    napi_unref_threadsafe_function(env, window_state->callback);
  }
  if (name == "stopWindows")
    stop_windows();
  else
    ++window_validations;
  napi_value resource;
  napi_create_string_utf8(env, "desktop-client-window", NAPI_AUTO_LENGTH,
                          &resource);
  if (napi_create_async_work(env, nullptr, resource, window_execute,
                             window_complete, job.get(),
                             &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    busy = false;
    if (name != "stopWindows")
      --window_validations;
    if (job->work)
      napi_delete_async_work(env, job->work);
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "kind", "refused");
    set(env, result, "reason", "native-unavailable");
    napi_resolve_deferred(env, job->deferred, result);
    return promise;
  }
  job.release();
  return promise;
}
napi_value window_reply(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t argc = 3;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool accepted = false;
  double id = 0;
  if (pthread_main_np() && argc == 2 &&
      napi_get_value_double(env, args[0], &id) == napi_ok && id >= 1 &&
      id <= 9007199254740991.0 && std::floor(id) == id) {
    napi_value global, json, stringify, encoded;
    std::string payload;
    napi_get_global(env, &global);
    napi_get_named_property(env, global, "JSON", &json);
    napi_get_named_property(env, json, "stringify", &stringify);
    if (napi_call_function(env, json, stringify, 1, &args[1], &encoded) ==
            napi_ok &&
        window_string(env, encoded, payload, 4095)) {
      std::lock_guard guard(window_state->lock);
      const auto found = window_state->pending.find(static_cast<uint64_t>(id));
      if (!window_state->stopping && found != window_state->pending.end() &&
          !expired(found->second->deadline)) {
        std::lock_guard pending_guard(found->second->lock);
        if (!found->second->answered) {
          found->second->payload = payload;
          found->second->answered = true;
          found->second->changed.notify_all();
          accepted = true;
        }
      }
    }
  }
  bool pending_exception = false;
  napi_is_exception_pending(env, &pending_exception);
  if (pending_exception) {
    napi_value error;
    napi_get_and_clear_last_exception(env, &error);
  }
  napi_get_boolean(env, accepted, &result);
  return result;
}
void install_window_exports(napi_env env, napi_value exports) {
  for (const char *name : {"listenWindows", "stopWindows", "openWindow",
                           "renewWindow", "revokeWindow"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, window_operation,
                         const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  napi_value reply;
  napi_create_function(env, "replyWindow", NAPI_AUTO_LENGTH, window_reply,
                       nullptr, &reply);
  napi_set_named_property(env, exports, "replyWindow", reply);
}

#endif
