{
  "targets": [{
    "target_name": "authorization",
    "sources": ["authorization.mm"],
    "link_settings": { "libraries": ["-framework Foundation", "-framework UserNotifications"] },
    "xcode_settings": { "CLANG_ENABLE_OBJC_ARC": "YES", "MACOSX_DEPLOYMENT_TARGET": "12.0" }
  }]
}
