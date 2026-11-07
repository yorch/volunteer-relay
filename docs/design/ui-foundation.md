# UI foundation

P2-00 supplies presentation components, not authorization or business behavior. The reference remains read-only. Components use React and scoped CSS modules without new dependencies, browser storage, model calls, ledger math or assumed durations.

## Composition and exports

Wrap a standalone composition in `FoundationRoot` from `apps/web/components/foundation`. Both shells already include it. `StaffShell` takes server-selected `navigation`, `currentPath`, `organization`, an optional account slot, a unique `mainId`, and children. It renders semantic links with `aria-current=page`, a skip link and a main landmark. Navigation is supplied by the authorized server caller; hiding links never grants or denies access. Role-aware workspace wiring awaits B/A, so no workspace layout or production route is added.

`VolunteerShell` takes organization, optional account slot, a unique mainId and children. It has no navigation slot or staff links and uses the actual viewport, without simulated phone chrome. A report-reader composition must receive only authorized report links/data from its server caller; it must not reuse staff evidence queries.

Foundation exports: `Button` (primary/secondary/danger, default type=button), `Card` (section with h2), `PageHeading` (h1, description, optional action), `Badge` (neutral/success/warning/danger), `Field`, `TextInput`, `TextArea`, `Select`, `FileUpload`, `EmptyState`, `Feedback`, `FoundationRoot`. Props are visual/native HTML props, not redefined domain DTOs. Use one PageHeading per page and Card under it; EmptyState uses h3 within a section.

Field callers provide unique ids and set matching `aria-describedby` references for hint/error ids (`<id>-hint`, `<id>-error`) and `aria-invalid` on invalid controls. Labels are explicit; placeholders supplement them. FileUpload supplies its own label/hint references and retains the native keyboard-operable file input. Its accept hint is not server validation; upload restrictions, transport, metadata stripping and authorization await intake contracts/services.

Feedback uses status for ordinary/loading feedback and alert for errors. Loading containers should additionally receive aria-busy when tied to asynchronous behavior. Badges always include descriptive text; color alone carries no state. Disabled actions remain native disabled controls. Screen code owns pending transitions, retries and focus retention after real actions.

## Tokens and responsive intent

CSS variables are scoped to FoundationRoot. Background `#f6f5f0`, paper `#ffffff`, ink `#253b38`, muted `#53675f`, line `#c5d0c6`, action teal `#196c5b`, sage `#edf0e8`, focus `#895311`. Semantic surfaces pair success `#e7f2e8/#285d3e`, warning `#fbf0db/#785013`, danger `#faece7/#8b3427`, neutral `#edf0e8/#40564c`. Muted text is deliberately darker than the reference. Inputs use `#7b9084` borders. Focus is a 3px outline with 4px offset; interactive targets are at least 44px high. Forced-colors adds state borders.

Body stack: DM Sans, system-ui, sans-serif. Heading stack: Manrope, system-ui, sans-serif. No fonts are downloaded; screenshots use the system fallback. External font/icon/Tailwind packages are unnecessary for this slice. Cards use 0.8rem corners; controls 0.5rem. Spacing follows 0.5/0.75/1/1.5/2rem. Headings scale from 1.6 to 2rem. Staff shell uses a 15rem sidebar and fluid content, capped at 90rem. At 760px the sidebar becomes a wrapping top navigation; no offscreen menu or hidden organization/account information. Volunteer content is capped at 40rem. Specimen columns stack at 760px; all grid children allow shrinking and long text wrapping.

## Preview and verification

`FoundationPreview` from components/layout composes synthetic staff/volunteer specimens. A authorized exactly `/dev/foundation` with optional `?audience=volunteer`; its server gate requires NODE_ENV=development and otherwise calls notFound, with force-dynamic. No preview authentication or real data is involved. Buttons illustrate styling and do not perform domain operations; submission is explicitly disabled. The native photo selector keeps a selected file in the browser only.

Commands use Node 26.11.1 with Bun 1.4.1 dispatch. Browser checks: `PLAYWRIGHT_PORT=3193 fnm exec --using=26.11.1 bun run test:e2e tests/e2e/ui/foundation`. Specs cover both shells at 1440/1024/390/320, horizontal fit, page errors, current navigation, volunteer navigation exclusion, skip link, keyboard order/visible focus, typed input, native synthetic file selection, disabled submission, error descriptions and explicit unknown/provisional/loading/error/empty states. Screenshots are saved as ignored test artifacts. A computed-style check measures rendered specimen text at >=4.5:1 (disabled text excluded); this is limited palette evidence, not a complete accessibility audit.

Source selection/filter state, shared contributions, duration amendments, optimistic reviews, role/tenant denial, durable receipts, uploads and ledger totals belong to later screen/service assignments. No acceptance for those flows follows from this visual foundation. Screen-reader, Firefox/WebKit and native-device checks remain unverified.

Verification on 2026-11-07: frozen install and Chromium installation succeeded. Final `fnm exec --using=26.11.1 bun run verify` passed (Biome, strict root/web types, 4 Vitest files/11 tests, web/worker builds). Full `PLAYWRIGHT_PORT=3193 ... bun run test:e2e` passed 16/16; following the skip-link clipping refinement, scoped foundation checks passed 12/12 again. Both audiences were inspected in screenshots across all four widths; no clipped content or horizontal overflow, with clear field labels/focus and wrapping controls. Next development overlay remains in screenshots; no production overlay is shipped. Temporary production Next start under Node `--env-file=.env.local` returned 404 without specimen content for both preview variants, then stopped cleanly. The initial production probe omitted explicit env loading and could not pass health; no production-preview result was claimed from it. All temporary servers stopped; no database/provider services were started.
