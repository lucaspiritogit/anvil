# Sidebar composer centering

The macOS overview now reserves equal 44px top and bottom clearance independently
of sidebar state. Its title strip occupies the top clearance without changing the
centering rectangle. Task and no-project views retain their existing in-flow strip.

## Validation (2026-09-10)

- `npm ci`: exit 0, installed dependencies locally and rebuilt native modules.
- Before the fix, `npm run test:e2e -- tests/e2e/composer-layout.spec.ts --grep 'darwin, no-preference, 900px' --reporter=line`: exit 1 as expected. At 1300×900, composer top/bottom changed from 372.125/563.875 to 394.125/585.875 on collapse and returned on expansion. Frame samples recorded the 22px movement in both directions.
- `npm run typecheck`: exit 0.
- Final isolated `npm run test:e2e -- tests/e2e/composer-layout.spec.ts tests/e2e/sidebar.spec.ts --reporter=line`: exit 0, 22 passed in 18.3s.
- The eight geometry cases cover macOS/Linux, normal/reduced motion, and 900/360px heights. Each samples 450ms around both 180ms transitions with 1px vertical tolerance. Observed vertical movement was 0px; horizontal center changed between 802 and 650px. Tests also verify draft/focus retention, responsive controls, short-window overflow reachability, draggable CSS, and task/no-project title strips.
- Screenshots and JSON frame samples are generated under `test-results/`. Roomy macOS screenshots: `test-results/composer-layout-sidebar-ke-2f36f--darwin-no-preference-900px-chromium/{collapse,expand}.png`. The collapsed screenshot was visually inspected.
- Two earlier full browser runs failed due to concurrent dev-server dependency optimization and then reuse of a server that shut down with the previous run. Both were allowed to finish before the successful isolated run above.
- Initial `env -u ELECTRON_RUN_AS_NODE ANVIL_DATA_DIR=/tmp/anvil-sidebar-layout-check npm run dev` exited 1 because Electron's binary was missing. `env -u ELECTRON_SKIP_BINARY_DOWNLOAD node node_modules/electron/install.js` exited 0; repeating the dev command built and launched Electron successfully.

## Remaining native verification

Manual Electron interaction is blocked: querying the Electron window via System
Events returned `osascript is not allowed assistive access (-1728)`. No interactive
computer tool is available in this session. Native dragging, actual traffic-light
clearance, and repeated native sidebar toggles with a draft still require manual
verification. Browser coverage does not establish native window-drag behavior.
The issue must remain blocked rather than be submitted with that checklist item
confirmed.
