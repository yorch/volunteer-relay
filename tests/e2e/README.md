# Browser verification

The Playwright suite runs separately from root Vitest. It covers platform, authentication, foundation and product interfaces with synthetic fixtures and controlled HTTP responses. It checks the UI behavior exercised by those cases; it does not by itself establish live provider behavior, production authentication or database tenant isolation.

Under Node 26.11.1:

```sh
bun install --frozen-lockfile
bun run test:e2e:install
bun run test:e2e
```

Playwright 1.65.0 requires Node >=20; the actual process is guarded at 26.11.1. The managed localhost dev server defaults to port 3190; set PLAYWRIGHT_PORT to a free per-worktree port. Existing servers are not reused unless you deliberately set PLAYWRIGHT_REUSE_SERVER=true (disabled in CI). If an owned Next dev preview is already running in the same worktree, point the test port at it and opt into reuse or stop it first. Never stop/reuse another worker's server implicitly. The browser server builds into its own ignored `.next-e2e` directory, so a concurrent `next build`, type generation or development server using `.next` cannot reload the app under test. Next still takes its single-server lock inside that directory and rewrites the ignored `next-env.d.ts` for whichever directory it last served, so run concurrent browser servers in separate worktrees instead of only changing the port.

Projects cover Chromium viewport widths 1440/1024/390/320. These are viewport/emulation checks, not Firefox/WebKit/native-device coverage. `bun run test:e2e --list` lists cases without launching Chromium. Filter individual suites with `bun run test:e2e tests/e2e/ui/foundation` when debugging. Failure traces/screenshots and the HTML report are ignored by Git and Docker; use synthetic data only.

The platform baseline checks browser startup, root page rendering, uncaught page errors, horizontal fit and actual Node server health. Other suites exercise keyboard, contrast and product flows, but the automated cases are not a complete accessibility or visual-design audit. Official configuration/browser guidance: https://playwright.dev/docs/test-configuration and https://playwright.dev/docs/browsers.

The Next development server also generates its managed apps/web/AGENTS.md and rewrites next-env.d.ts between dev/build/typegen modes. The managed instructions are committed once; next-env.d.ts is intentionally untracked/ignored per the installed Next TypeScript guide. Root typecheck generates route/environment types before tsc, so fresh checkouts do not need that generated file committed.

At commit `40742ce`, the full suite passed 208 cases across the four Chromium viewport projects using an isolated checkout. These are emulated viewports, not Firefox, WebKit or native-device tests.
