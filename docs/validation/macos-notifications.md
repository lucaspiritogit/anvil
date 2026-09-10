# macOS notification authorization and delivery

Anvil uses the bundle identity `dev.anvil.app`. Notification preferences belong to
that application identity, not to the renderer origin or the selected workspace.
Use **Anvil → Notifications…** to inspect OS authorization and open System Settings.
Enable **Allow Notifications**, select a banner/alert style, and check Focus modes.

## Implementation

The lockfile installs Electron **44.3.0**. Its
[native presenter](https://github.com/electron/electron/blob/v44.3.0/shell/browser/notifications/mac/notification_presenter_mac.mm)
requests authorization when created, but
[notification scheduling](https://github.com/electron/electron/blob/v44.3.0/shell/browser/notifications/mac/cocoa_notification.mm)
does not await that request. The public Electron API has no equivalent of
`UNUserNotificationCenter.getNotificationSettings`. `Notification.isSupported()`
and browser notification permission are not OS authorization checks.
The [44.3.0 API implementation](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_notification.cc)
also shows that `isSupported()` creates the presenter. Anvil therefore waits for
authorization before even calling `isSupported()`, avoiding a competing implicit
request from Electron. Regression assertions cover both pending and denied states.

The small in-process N-API module in `native/mac-notifications` queries Apple's
UserNotifications framework under Anvil's own identity. It requests alert, sound,
and badge permission only when the OS reports not determined. Delivery waits for
that result; concurrent events share one authorization operation. Later events
query again to detect permission changes in System Settings. Denied events are
discarded, not replayed after permission changes. The first failure in a session
offers recovery; the application menu remains available afterward.

Notifications stay strongly referenced until failure, dismissal, or shutdown.
At most 100 native objects are retained; the oldest is closed when the limit is
reached. Pending authorization cannot deliver after disposal. Native callbacks
use a Node thread-safe function and do not keep the process alive during shutdown.
Windows and Linux keep Electron's existing delivery behavior without loading the
macOS module. Subtask transition wiring is a separate queued issue.

## Build prerequisites

Run `npm ci` locally. On macOS, postinstall and build compile the bridge using Xcode Command
Line Tools, Python, node-gyp, and headers for the installed Electron version.
The current build targets the host architecture, matching `pack:mac` and `dist:mac`.
Cross-architecture or universal packaging requires rebuilding/combining all native
modules for the target architecture; it is not provided by these scripts.

`pack:mac` and `dist:mac` no longer force `mac.identity=null`, and require successful
code signing. Install a valid Developer ID Application certificate/private key in
the build keychain, or configure electron-builder's `CSC_LINK` and
`CSC_KEY_PASSWORD` securely. Do not commit credentials. The application ID remains
stable. Distribution outside the local machine additionally needs the appropriate
Apple notarization setup. See [Electron's macOS notification requirements](https://www.electronjs.org/docs/latest/tutorial/notifications#macos).

Development launches use the Electron bundle and its permissions, even though the
window is named Anvil Dev. They do not verify the packaged Anvil identity.
Do not accept a build exit code alone as proof of notification delivery.

## Required native acceptance checks

On a Mac with a signed bundle and a fresh test account/authorization state:

1. Run `npm run pack:mac` and inspect the actual artifact:
   `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Anvil.app` and
   `codesign -dv --verbose=4 release/mac-arm64/Anvil.app` (use `release/mac` on x64).
2. Launch the bundle with a temporary `ANVIL_DATA_DIR` so production tasks are not
   touched. A separate data directory does not reset OS notification permission.
3. Trigger a task status transition. Verify exactly one native authorization
   prompt; allow it and verify the triggering notification appears once.
4. In a separate fresh OS authorization state, deny permission. Trigger more
   transitions and verify no repeated OS prompts and no stale alerts.
5. Open **Anvil → Notifications…**, enable notifications in System Settings, and
   trigger a new transition. Verify delivery without restarting Anvil.
6. Repeat with the window minimized and a background workspace. Inspect the
   recovery dialog and menu visually. Do not equate Electron's `show` event with
   a visible banner: it only confirms scheduling.

Do not reset the user's notification database to obtain a fresh test state.

For a repeatable native probe, run:

```sh
node scripts/probe-mac-notifications.cjs release/mac-arm64/Anvil.app/Contents/MacOS/Anvil
node scripts/probe-mac-notifications.cjs release/mac-arm64/Anvil.app/Contents/MacOS/Anvil --request
```

The first command only queries OS authorization. The second may request permission
and sends a diagnostic notification only after authorization succeeds. It keeps the
app open for 15 seconds after scheduling for visual inspection. Both use a temporary
Anvil data directory and leave OS notification preferences intact. The probe times
out after 45 seconds if native authorization cannot complete. It never reports a
scheduled event as proof of a visible banner.

## Validation on 2026-09-10

Environment: macOS Darwin 25.5.0, arm64, Node 24.14.1, Electron 44.3.0.

- `npm ci`: exit 0; local dependencies and Electron SQLite rebuild installed.
- `node scripts/build-mac-notifications.cjs`: exit 0; compiled the N-API bridge.
- `npm install --save-dev node-gyp@^12.4.0`: exit 0; explicit build dependency.
- `npm test -- tests/task-notifications.test.ts tests/notification-delivery.test.ts`:
  exit 0, 2 files / 9 tests passed.
- `npm run typecheck`: exit 0.
- `npm run typecheck:tests`: exit 0.
- Initial `npm run pack:mac` after removing `identity=null`: exit 0, but builder
  reported skipped signing. `security find-identity -v -p codesigning` reported
  zero valid identities. This demonstrated that removing the override alone was
  insufficient.
- `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Anvil.app`:
  exit 1, “code has no resources but signature indicates they must be present”.
- `codesign -dv --verbose=4 release/mac-arm64/Anvil.app`: exit 0, but reported
  `Identifier=Electron`, `Signature=adhoc`, `Info.plist=not bound`, and
  `Sealed Resources=none` (the executable's linker signature, not a signed bundle).
- Launched that actual bundle with Playwright's Electron launcher and an isolated
  temporary data directory. The bridge query returned `not-determined`. Its
  authorization request rejected with `UNErrorDomain error 1`; Electron's native
  `Notification.show()` also emitted `failed` with `UNErrorDomain error 1`.
  The application menu contained `Notifications…`. An initial probe failed due
  to Playwright's evaluation context lacking global `require`; the corrected
  probe used `process.mainModule.require` and completed with exit 0.
- Final `npm run pack:mac` with `forceCodeSigning=true`: exit 1 at signing with
  no valid identity, after successful typechecking and production compilation.
  Full output was streamed to `/tmp/anvil-pack-mac.log`.
- Diagnostic-only `codesign --force --deep --sign - --identifier dev.anvil.app
  release/mac-arm64/Anvil.app`: exit 0. Subsequent deep/strict verification exited
  0, and signature inspection reported `Identifier=dev.anvil.app`, a sealed
  resource envelope, `Signature=adhoc`, and no TeamIdentifier. This is not a
  Developer ID distribution signature. An authorization request in this bundle
  eventually rejected with “Notifications are not allowed for this application”.
  A raw Electron notification emitted `show` afterward, which only establishes
  scheduling, not visible delivery. No visible prompt, grant, or banner was observed.
- `screencapture -x /tmp/anvil-notification-screen.png`: exit 1, “could not create
  image from display”. The session cannot capture the native desktop for manual
  prompt/recovery inspection. Ad hoc signing alone is therefore not established
  as sufficient for native delivery on this machine.
- Repeated `npm run pack:mac` after adding automatic native compilation: native
  compilation, typechecking, and bundling succeeded; exit 1 again at signing.
  A final native teardown guard was compiled successfully; SHA-256 comparison
  confirmed that the rebuilt bridge and the packaged bridge were identical.
  This packaging run replaced the diagnostic ad hoc signed artifact with an
  unsigned artifact. `git diff --check` exited 0.

Native allow/deny/re-enable and visible foreground/minimized delivery acceptance
remain unverified. Unit tests and the successful bundle build are not substitutes
for these checks. No renderer was changed, so the conditional SettingsPage browser
suite does not apply.

## Resumed validation on 2026-09-10

The interrupted issue was verified against the owning task, requeued, and restarted
on the original branch. No other issue was claimed.

- Inspected Electron 44.3.0's `Notification::IsSupported()` and corrected the
  premature presenter initialization described above.
- `npm test -- tests/task-notifications.test.ts tests/notification-delivery.test.ts`:
  exit 0, 2 files / 9 tests, including new assertions that pending/denied permission
  does not call the side-effectful support check.
- `npm run typecheck` and `npm run typecheck:tests`: both exit 0.
- `npm run pack:mac`: exit 1 at signing after successful native compilation,
  typechecking, and bundling. Output streamed to `/tmp/anvil-pack-mac-resume.log`.
  `security find-identity -v -p codesigning` still reports zero valid identities.
- Deep/strict `codesign` verification of `release/mac-arm64/Anvil.app`: exit 1,
  missing signed resource envelope. `codesign -dv --verbose=4` exited 0 and again
  reported the unbound `Electron` linker signature rather than a signed Anvil bundle.
- `node scripts/probe-mac-notifications.cjs release/mac-arm64/Anvil.app/Contents/MacOS/Anvil`:
  exit 0, native status `not-determined`; delivery explicitly not attempted.
- The same probe with `--request`: exit 1, native request rejected with
  `UNErrorDomain error 1`. Both probes launched the actual artifact with temporary
  app data. The app also logged its existing closing-window `ERR_FAILED` during
  shutdown; this did not change the native authorization result.

The remaining acceptance gap is unchanged: a properly signed build on an interactive
macOS desktop must verify allow, deny without repeated prompts, re-enable via System
Settings, and visible foreground/minimized delivery. These observations are not
claimed as passing.
