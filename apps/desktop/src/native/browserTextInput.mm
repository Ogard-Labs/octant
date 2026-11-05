#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cmath>
#include <cstring>
#include <cstdint>

namespace {
const napi_type_tag ownerTag = {0x24973a891d254c65, 0x895e2df7938b964e};
struct OwnedView { __weak NSView *view; };
napi_value object(napi_env env) { napi_value value; napi_create_object(env, &value); return value; }
void text(napi_env env, napi_value value, const char *key, const char *input) { napi_value item; napi_create_string_utf8(env, input, NAPI_AUTO_LENGTH, &item); napi_set_named_property(env, value, key, item); }
void number(napi_env env, napi_value value, const char *key, double input) { napi_value item; napi_create_double(env, input, &item); napi_set_named_property(env, value, key, item); }
napi_value refused(napi_env env) { auto value = object(env); text(env, value, "status", "unavailable"); return value; }
bool browserMain(napi_env env) {
  if (![NSThread isMainThread]) return false;
  napi_value global, process, type; char name[24] = {}; size_t length = 0;
  return napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, "process", &process) == napi_ok && napi_get_named_property(env, process, "type", &type) == napi_ok && napi_get_value_string_utf8(env, type, name, sizeof(name), &length) == napi_ok && length == 7 && std::strcmp(name, "browser") == 0;
}
OwnedView *owner(napi_env env, napi_value value) {
  bool tagged = false; void *data = nullptr;
  return napi_check_object_type_tag(env, value, &ownerTag, &tagged) == napi_ok && tagged && napi_unwrap(env, value, &data) == napi_ok ? static_cast<OwnedView *>(data) : nullptr;
}
bool bounded(NSRect value) {
  return std::isfinite(value.origin.x) && std::isfinite(value.origin.y) && std::isfinite(value.size.width) && std::isfinite(value.size.height) && value.origin.x >= 0 && value.origin.y >= 0 && value.size.width >= 0 && value.size.height > 0 && value.origin.x + value.size.width <= 1920 && value.origin.y + value.size.height <= 1200;
}
napi_value read(napi_env env, napi_callback_info info) {
  if (!browserMain(env)) return refused(env);
  size_t argc = 2; napi_value args[2], self;
  if (napi_get_cb_info(env, info, &argc, args, &self, nullptr) != napi_ok || argc != 1) return refused(env);
  auto state = owner(env, self); double offset = 0;
  if (state == nullptr || napi_get_value_double(env, args[0], &offset) != napi_ok || !std::isfinite(offset) || std::floor(offset) != offset || offset < 0 || offset > 1048576) return refused(env);
  @autoreleasepool { @try {
    NSView *view = state->view;
    if (view == nil || view.window == nil) return refused(env);
    NSWindow *window = view.window; NSResponder *responder = window.firstResponder;
    if (![responder isKindOfClass:[NSView class]]) return refused(env);
    NSView *target = (NSView *)responder;
    if ((target != view && ![target isDescendantOf:view]) || ![target conformsToProtocol:@protocol(NSTextInputClient)]) return refused(env);
    NSRange actual = NSMakeRange(NSNotFound, 0);
    // Chromium's cached selectedRange/hasMarkedText can lag a hidden page. Only
    // the host-observed requested UTF16 offset and the returned actual range count.
    NSRect screen = [(id<NSTextInputClient>)target firstRectForCharacterRange:NSMakeRange(static_cast<NSUInteger>(offset), 0) actualRange:&actual];
    if (actual.location != static_cast<NSUInteger>(offset) || actual.length > 1) return refused(env);
    NSRect local = [view convertRect:[window convertRectFromScreen:screen] fromView:nil];
    if (!view.isFlipped) local.origin.y = NSHeight(view.bounds) - NSMaxY(local);
    if (!bounded(local)) return refused(env);
    auto value = object(env); text(env, value, "status", "observed");
    number(env, value, "x", local.origin.x); number(env, value, "y", local.origin.y);
    number(env, value, "width", local.size.width); number(env, value, "height", local.size.height);
    return value;
  } @catch (NSException *exception) { (void)exception; return refused(env); } }
}
napi_value close(napi_env env, napi_callback_info info) {
  if (!browserMain(env)) return refused(env);
  size_t argc = 1; napi_value args[1], self;
  if (napi_get_cb_info(env, info, &argc, args, &self, nullptr) != napi_ok || argc != 0) return refused(env);
  auto state = owner(env, self); if (state == nullptr) return refused(env);
  state->view = nil; auto value = object(env); text(env, value, "status", "closed"); return value;
}
void finalize(napi_env, void *data, void *) { delete static_cast<OwnedView *>(data); }
napi_value bind(napi_env env, napi_callback_info info) {
  if (!browserMain(env)) return refused(env);
  size_t argc = 2; napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) return refused(env);
  bool buffer = false; void *bytes = nullptr; size_t size = 0; uintptr_t pointer = 0;
  if (napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size != sizeof(pointer)) return refused(env);
  std::memcpy(&pointer, bytes, size); if (pointer == 0) return refused(env);
  // This main-only constructor is called once with our own live BrowserWindow.
  // Later reads use a tagged opaque object and a weak view, never a wire pointer.
  NSView *view = (__bridge NSView *)(reinterpret_cast<void *>(pointer));
  if (![view isKindOfClass:[NSView class]] || view.window == nil) return refused(env);
  auto state = new OwnedView{view}; auto value = object(env);
  if (napi_wrap(env, value, state, finalize, nullptr, nullptr) != napi_ok) { delete state; return refused(env); }
  napi_type_tag_object(env, value, &ownerTag);
  napi_property_descriptor methods[] = {{"read", nullptr, read, nullptr, nullptr, nullptr, napi_default, nullptr}, {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, value, 2, methods); return value;
}
napi_value initialize(napi_env env, napi_value exports) {
  napi_value function; napi_create_function(env, "bind", NAPI_AUTO_LENGTH, bind, nullptr, &function); napi_set_named_property(env, exports, "bind", function); return exports;
}
}
NAPI_MODULE(browser_text_input, initialize)
