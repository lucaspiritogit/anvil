#include <node_api.h>
#include <string>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

struct Result {
  napi_deferred deferred;
  std::string status;
  std::string error;
};

static std::string Status(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "granted";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

static void Complete(napi_env env, napi_value, void*, void* data) {
  auto* result = static_cast<Result*>(data);
  // Node may be shutting down when the system finishes its callback.
  if (env) {
    napi_value value;
    if (result->error.empty()) {
      napi_create_string_utf8(env, result->status.c_str(), NAPI_AUTO_LENGTH, &value);
      napi_resolve_deferred(env, result->deferred, value);
    } else {
      napi_value message;
      napi_create_string_utf8(env, result->error.c_str(), NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &value);
      napi_reject_deferred(env, result->deferred, value);
    }
  }
  delete result;
}

static napi_value Authorization(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  bool request = false;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr);
  if (argc) napi_get_value_bool(env, argument, &request);
  auto* result = new Result;
  napi_value promise, name;
  napi_create_promise(env, &result->deferred, &promise);
  napi_create_string_utf8(env, "Anvil notification authorization", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  napi_status created = napi_create_threadsafe_function(
      env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, nullptr, Complete, &callback);
  if (created != napi_ok) {
    delete result;
    napi_throw_error(env, nullptr, "Could not create notification authorization callback");
    return nullptr;
  }
  // A pending system prompt must not keep Anvil alive during shutdown.
  napi_unref_threadsafe_function(env, callback);
  void (^finish)(void) = ^{
    napi_status queued = napi_call_threadsafe_function(callback, result, napi_tsfn_nonblocking);
    if (queued != napi_ok)
      delete result;
    // napi_closing means Node has already retired this producer during teardown.
    if (queued != napi_closing)
      napi_release_threadsafe_function(callback, napi_tsfn_release);
  };
  @try {
    UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
      if (request && settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                             completionHandler:^(BOOL granted, NSError* error) {
          result->status = granted ? "granted" : "denied";
          if (error) result->error = error.localizedDescription.UTF8String;
          finish();
        }];
      } else {
        result->status = Status(settings.authorizationStatus);
        finish();
      }
    }];
  } @catch (NSException* exception) {
    result->error = exception.reason.UTF8String;
    finish();
  }
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "authorization", NAPI_AUTO_LENGTH, Authorization, nullptr, &function);
  napi_set_named_property(env, exports, "authorization", function);
  return exports;
}
