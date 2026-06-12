# AGENTS.md

Keryx is a Node 22+ TypeScript/Svelte/Fastify control surface over Hermes Kanban. It is intentionally thin: Kanban remains the source of truth; Keryx adds schemas, a Hermes plugin named `keryx`, a safe `opsctl` fallback, a local API, a web inbox, plugin-registered skills, and collector templates.

## Commands

Run from the repository root.

```sh
npm install              # install dependencies
npm run lint            # TypeScript check via tsc --noEmit
npm run typecheck       # svelte-check plus TypeScript check
npm test                # Vitest unit and integration tests (single run)
npm run test:watch      # Vitest in watch mode (interactive use only)
npm run build           # Vite client build plus server build
npm run e2e             # Playwright tests; starts Vite on 127.0.0.1:5173
npm start               # production-style local server on configured host/port
./keryx-setup.sh --dry-run
hermes keryx doctor     # plugin health check after setup
./bin/opsctl doctor     # direct repo fallback health check
```

Before committing code changes, run at least:

```sh
npm run lint
npm test
```

Also run `npm run typecheck` when touching Svelte/UI or shared types, `npm run build` when changing bundling/server entrypoints, and `npm run e2e` when changing user-visible inbox behaviour.

## Project map

- `src/web/` — Svelte inbox UI and browser-side helpers.
- `src/server/` — Fastify app, API routes, and server entrypoint.
- `src/opsctl/` — CLI parsing, command handlers, and output formatting.
- `src/hermes/` — allowlisted Hermes CLI adapter and test fakes.
- `hermes-plugin/` — thin Hermes plugin adapter registering `hermes keryx ...` and repository-backed skills.
- `src/schemas/` and `schemas/` — TypeScript validators and JSON Schema contracts.
- `tests/unit/` — focused unit tests for schemas, command logic, UI helpers, docs expectations.
- `tests/integration/` — CLI, API, static serving, and setup-script tests with fake Hermes harnesses.
- `tests/e2e/` — Playwright browser tests.
- `skills/keryx/` — repository-backed Keryx skills registered by the plugin; keep skill files concise and self-contained.
- `collectors/` — collector templates only; they must not create real cron jobs by themselves.
- `docs/` — architecture, security, operations, collector authoring, and archived PRD/PLAN references.
- `deploy/` — example Caddy/systemd files only; copy and review before real use.

## Architecture rules

- The Keryx Hermes plugin is the Hermes-facing adapter; Keryx remains a thin control surface over Hermes Kanban. Do not add a second task database or bypass Hermes Kanban as the central register.
- Route UI mutations through the same command logic as `opsctl` where practical; keep Kanban mutation rules centralised.
- Keep Hermes command execution allowlisted in `src/hermes/adapter.ts`. Do not add generic shell/Hermes passthroughs.
- Keryx action cards must validate as `keryx.action_item.v1`; execution decisions must validate as `keryx.execution_decision.v1`.
- Malformed Kanban card bodies must remain visible to callers/operators rather than being silently dropped.
- Preserve default local-only posture: the server binds `127.0.0.1:4173` via the `HOST`/`PORT` environment variables (defaulting to localhost), and it has no built-in authentication.

## Security and side-effect boundaries

- Treat all source content as untrusted: message bodies, page text, titles, summaries, attachments, sender names, and links.
- Do not persist raw private event bodies, credentials, cookies, full private messages, or large attachments in task bodies, comments, logs, or fixtures.
- Collectors discover and create blocked cards only. They must not perform source actions.
- Workers act only from the latest trusted `keryx.execution_decision.v1` comment and should re-query source systems before external side effects.
- Block rather than automate through credentials, 2FA, CAPTCHA, consent dialogs, payment details, destructive actions, or ambiguous account choices.
- Do not expose Keryx beyond localhost unless an authenticated reverse proxy or private network is explicitly configured outside this app.
- Do not create real Hermes cron jobs, mutate the user's real `keryx` board, or install into a real Hermes home in tests; use fakes or temporary `HERMES_HOME` fixtures.

## Collector rules

- Prefer bash-first collectors when deterministic polling can cheaply detect candidates; use direct-agent collectors only when discovery needs browser automation, logged-in context, or judgement.
- Create cards with `initial-status blocked`, attach `keryx:keryx-worker`, and use stable idempotency keys of the form `keryx:<source>:<immutable-source-id>`.
- Advance committed cursor state only after card creation, explicit safe skip, or exact dismissal succeeds.
- Exact dismiss state suppresses only the exact immutable source item, never fuzzy title matches or broad filters.
- Dry-run collectors against fixtures before documenting or scheduling them.

## Code style

- Use TypeScript ESM, strict types, `async`/`await`, and small pure helpers where possible.
- Prefer explicit result objects and validation errors over opaque exceptions for user-facing validation paths.
- Keep CLI output stable and concise; tests assert exact phrases in README and command output.
- Follow the existing style: two-space indentation, single quotes in TypeScript, semicolons, named exports for reusable functions.
- Add or update tests beside the behaviour you change. Do not remove failing tests unless the user explicitly asks and the obsolete behaviour is documented.

## Documentation

- Keep `README.md` human-facing and concise; put deeper operational detail in `docs/` and link to it.
- Update `AGENTS.md` in the same change when build commands, test commands, project structure, or safety boundaries change.
- Use plugin-qualified Keryx skill names in examples, such as `keryx:keryx-worker`, `keryx:keryx-collector`, and `keryx:keryx-collector-creator`.
- PRD and PLAN documents for larger historical changes live under `docs/archive/`; do not move them back to the repository root.

## Git workflow

- Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Before committing, check `git diff --check` and the relevant npm checks above.
- Do not commit secrets, generated dependency folders, local configs, Playwright reports, or temporary files.
