# Code Quality Tooling Implementation Plan

> **For Hermes:** Implement this plan task-by-task. Keep the changes small, verify after each task, and do not add markdownlint in this pass.

**Goal:** Add pragmatic low-overhead code quality gates for Keryx: stricter TypeScript checks, ESLint, and ShellCheck.

**Architecture:** Keep Keryx's quality model local and npm-driven. Preserve the current fast `npm run lint` / `npm test` workflow, but make `lint` a composed quality gate over TypeScript, ESLint, and shell-script checks. Avoid SonarQube, markdownlint, Prettier, broad formatting churn, and heavyweight CI policy in this pass.

**Tech Stack:** Node 22+, TypeScript 6, Svelte 5, Vite, Vitest, `typescript-eslint`, `eslint-plugin-svelte`, ShellCheck.

---

## Current context

The repo currently has strong correctness checks but limited static/style tooling:

- `npm run lint` is currently only `tsc --noEmit --project tsconfig.json`.
- `npm run typecheck` runs `svelte-check` plus `tsc`.
- `npm test` runs Vitest unit and integration tests.
- `npm run e2e` runs Playwright tests.
- No ESLint, TSLint, Sonar, ShellCheck, markdownlint, or formatter config is present.
- TSLint should not be added; it is deprecated.
- SonarQube/SonarCloud should not be added now; it is overhead without enough extra value for this repo's current scope.
- markdownlint is explicitly out of scope for this plan.

Prior probe results to preserve in the implementation notes:

- Enabling `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and `noFallthroughCasesInSwitch` currently surfaces only a few unused imports/types and should be cheap.
- Enabling `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` produces many errors and should be deferred.
- ShellCheck currently reports two warnings in `keryx-setup.sh`:
  - `SC1007` on `CDPATH= cd -- ...`
  - `SC2088` on the quoted tilde pattern in `expand_tilde`

## Non-goals

- Do not add markdownlint in this pass.
- Do not add Prettier or reformat the repo.
- Do not add SonarQube/SonarCloud.
- Do not add TSLint.
- Do not add coverage thresholds.
- Do not change runtime behaviour except fixing shell-script lint warnings where the intended behaviour is already tested.
- Do not create real Hermes cron jobs, mutate real Hermes state, or change Keryx safety boundaries.

---

## Task 1: Split the existing TypeScript lint script

**Objective:** Preserve the current TypeScript check under an explicit `lint:ts` script so `lint` can become a composed gate later.

**Files:**

- Modify: `package.json`
- Test: `tests/unit/package-scripts.test.ts`

**Steps:**

1. Update `package.json` scripts:

   ```json
   {
     "lint": "npm run lint:ts",
     "lint:ts": "tsc --noEmit --project tsconfig.json"
   }
   ```

   Keep all existing scripts unchanged.

2. Add or update a package-script test so future changes cannot accidentally turn `lint` back into an underspecified command.

   Suggested assertion in `tests/unit/package-scripts.test.ts`:

   ```ts
   it('keeps lint as a composed quality gate starting with TypeScript checks', () => {
     const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

     expect(packageJson.scripts?.['lint:ts']).toBe('tsc --noEmit --project tsconfig.json');
     expect(packageJson.scripts?.lint).toContain('lint:ts');
   });
   ```

3. Verify:

   ```sh
   npm run lint:ts
   npm test -- --run tests/unit/package-scripts.test.ts
   ```

   Expected: both pass.

---

## Task 2: Enable cheap stricter TypeScript compiler checks

**Objective:** Add high-signal TypeScript checks that are cheap to satisfy now.

**Files:**

- Modify: `tsconfig.json`
- Modify only as needed: source files with unused imports/types
- Test: existing TypeScript check and focused tests for touched files if any

**Steps:**

1. Add these compiler options:

   ```json
   {
     "noUnusedLocals": true,
     "noUnusedParameters": true,
     "noImplicitReturns": true,
     "noFallthroughCasesInSwitch": true
   }
   ```

2. Run:

   ```sh
   npm run lint:ts
   ```

   Expected first result: fail on unused imports/types currently known from the probe.

3. Remove genuinely unused imports/types only. Do not silence the checks with underscores unless the parameter is intentionally part of an interface or callback signature.

   Known likely cleanup locations from the probe:

   - `src/opsctl/commands.ts`
   - `src/opsctl/commands/cards.ts`
   - `src/opsctl/defaultResolver.ts`

4. Re-run:

   ```sh
   npm run lint:ts
   npm test
   ```

   Expected: both pass.

**Do not enable yet:**

```json
{
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true
}
```

Those checks are valuable but currently noisy enough to deserve a separate cleanup plan.

---

## Task 3: Add ESLint dependencies and config

**Objective:** Add bug-focused, type-aware ESLint for TypeScript and Svelte without introducing style churn.

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `eslint.config.js`
- Test: `tests/unit/package-scripts.test.ts`

**Steps:**

1. Install dev dependencies:

   ```sh
   npm install --save-dev eslint typescript-eslint eslint-plugin-svelte
   ```

2. Create `eslint.config.js` using flat config. Start conservative and bug-focused.

   Suggested initial config:

   ```js
   import js from '@eslint/js';
   import svelte from 'eslint-plugin-svelte';
   import tseslint from 'typescript-eslint';

   export default tseslint.config(
     {
       ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
     },
     js.configs.recommended,
     ...tseslint.configs.recommendedTypeChecked,
     ...svelte.configs['flat/recommended'],
     {
       languageOptions: {
         parserOptions: {
           projectService: true,
           tsconfigRootDir: import.meta.dirname,
         },
       },
       rules: {
         '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
         '@typescript-eslint/no-floating-promises': 'error',
         '@typescript-eslint/no-misused-promises': 'error',
         '@typescript-eslint/await-thenable': 'error',
       },
     },
     {
       files: ['*.config.ts', 'tests/**/*.ts'],
       rules: {
         '@typescript-eslint/no-unsafe-assignment': 'off',
         '@typescript-eslint/no-unsafe-member-access': 'off',
       },
     },
   );
   ```

   Adjust only if the installed package versions require small syntax changes. Prefer the official flat-config shape for the installed `typescript-eslint` and `eslint-plugin-svelte` versions.

3. Add scripts:

   ```json
   {
     "lint:eslint": "eslint . --max-warnings=0",
     "lint": "npm run lint:ts && npm run lint:eslint"
   }
   ```

   ShellCheck will be added to `lint` in a later task.

4. Update `tests/unit/package-scripts.test.ts` to assert:

   ```ts
   expect(packageJson.scripts?.['lint:eslint']).toBe('eslint . --max-warnings=0');
   expect(packageJson.scripts?.lint).toContain('lint:eslint');
   ```

5. Run:

   ```sh
   npm run lint:eslint
   ```

   Expected first result: may fail on real lint findings.

6. Fix only high-signal findings:

   - Prefer `import type` for type-only imports.
   - Add `await`, `void`, or explicit error handling for floating promises.
   - Fix unsafe async callback usage rather than disabling the async rules globally.
   - If a rule is noisy in tests only, scope the override to `tests/**/*.ts`.

7. Verify:

   ```sh
   npm run lint:eslint
   npm run lint
   npm test
   ```

   Expected: all pass.

---

## Task 4: Add ShellCheck for `keryx-setup.sh`

**Objective:** Add a shell-script lint gate and fix the current warnings.

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `keryx-setup.sh`
- Test: `tests/integration/setup-script.test.ts`
- Test: `tests/unit/package-scripts.test.ts`

**Steps:**

1. Add a dev dependency that provides a cross-platform npm-invoked ShellCheck binary.

   Preferred:

   ```sh
   npm install --save-dev shellcheck
   ```

   If that package proves unsuitable in this environment, use the minimal working npm package that exposes `shellcheck` via `npm exec` and document the reason in the commit message.

2. Add scripts:

   ```json
   {
     "lint:sh": "shellcheck keryx-setup.sh",
     "lint": "npm run lint:ts && npm run lint:eslint && npm run lint:sh"
   }
   ```

3. Fix `SC1007` in `keryx-setup.sh`.

   Current line:

   ```sh
   SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
   ```

   ShellCheck-friendly replacement:

   ```sh
   SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
   ```

4. Fix `SC2088` in `expand_tilde`.

   Current pattern:

   ```sh
   '~') printf '%s\n' "$HOME" ;;
   '~/'*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
   ```

   ShellCheck-friendly replacement:

   ```sh
   '~') printf '%s\n' "$HOME" ;;
   '~/'*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
   ```

   If ShellCheck still objects, use a variable-based implementation that avoids a literal quoted tilde in the parameter expansion while preserving existing tests:

   ```sh
   '~') printf '%s\n' "$HOME" ;;
   '~/'*) path_without_tilde=${1#\~/}; printf '%s/%s\n' "$HOME" "$path_without_tilde" ;;
   ```

5. Update package-script tests to assert `lint:sh` exists and is included in `lint`.

6. Verify:

   ```sh
   npm run lint:sh
   npm test -- --run tests/integration/setup-script.test.ts
   npm test -- --run tests/unit/package-scripts.test.ts
   npm run lint
   npm test
   ```

   Expected: all pass.

---

## Task 5: Add one local aggregate check script

**Objective:** Give humans and agents one stable command for pre-commit quality checks.

**Files:**

- Modify: `package.json`
- Test: `tests/unit/package-scripts.test.ts`

**Steps:**

1. Add:

   ```json
   {
     "check": "npm run lint && npm test"
   }
   ```

2. Add a package-script test:

   ```ts
   it('provides a stable local pre-commit check command', () => {
     const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

     expect(packageJson.scripts?.check).toBe('npm run lint && npm test');
   });
   ```

3. Verify:

   ```sh
   npm run check
   ```

   Expected: lint and tests pass.

---

## Task 6: Update developer documentation

**Objective:** Document the new quality commands in the same places that currently describe required checks.

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md` only if it already has a contributor/development checks section or if adding one stays concise
- Test: existing docs tests

**Steps:**

1. In `AGENTS.md`, update the command list to include:

   ```sh
   npm run lint            # TypeScript, ESLint, and shell lint checks
   npm run lint:ts         # TypeScript compiler checks only
   npm run lint:eslint     # ESLint static analysis
   npm run lint:sh         # ShellCheck for keryx-setup.sh
   npm run check           # npm run lint && npm test
   ```

2. Keep the pre-commit guidance concise:

   ```sh
   npm run check
   git diff --check
   ```

   Preserve the existing guidance to also run `npm run typecheck`, `npm run build`, or `npm run e2e` when touching relevant areas.

3. If `README.md` has a development section, add only the user-facing `npm run check` command. Avoid duplicating all internal lint details unless useful.

4. Verify docs tests:

   ```sh
   npm test -- --run tests/unit/readme.test.ts tests/unit/templates-and-docs.test.ts
   npm test
   ```

   Expected: all pass.

---

## Final verification

Run from the repository root:

```sh
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Also run:

```sh
npm run e2e
```

if any Svelte/UI or visible inbox behaviour changed while satisfying ESLint.

Expected final state:

- `npm run lint` runs TypeScript, ESLint, and ShellCheck.
- `npm run check` runs lint plus tests.
- `npm test` remains a single-run Vitest command, not watch mode.
- `keryx-setup.sh` passes ShellCheck.
- No markdownlint, Sonar, TSLint, Prettier, or broad formatting churn is introduced.

## Risks and mitigations

- **ESLint can become noisy.** Mitigate by starting with bug-focused rules and scoped test overrides only where justified.
- **Type-aware ESLint can be slower.** Acceptable for this repo if `npm run lint` remains reasonably fast; if it becomes too slow, keep `lint:ts` available for fast focused checks.
- **ShellCheck npm packaging may vary by platform.** Verify the installed package exposes a working `shellcheck` binary through npm scripts before committing.
- **Svelte ESLint config may require parser glue depending on installed versions.** Use the official current flat-config examples for `eslint-plugin-svelte` if the suggested config needs adjustment.
- **Stricter TypeScript checks can tempt broad refactors.** Do not refactor broadly; remove unused code and fix only direct compiler findings in this pass.

## Commit sequence

Use small conventional commits:

1. `chore: split TypeScript lint script`
2. `chore: enable stricter TypeScript checks`
3. `chore: add ESLint quality gate`
4. `chore: add ShellCheck quality gate`
5. `docs: document quality check commands`

Squash later only if the final history should be simpler.
