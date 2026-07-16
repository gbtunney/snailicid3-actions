# snailicid3-actions

Reusable GitHub Actions and workflows for the `snailicid3` ecosystem.

## Usage

### Reusable Workflows

Reference these from any repository:

```yaml
jobs:
  pipeline:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-pipeline.yml@main
    with:
      run_build: true
      run_test: true

  detect:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-detect-release-state.yml@main

  release:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-release-plan.yml@main
    secrets: inherit

  apply:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-apply-workspace-artifact.yml@main
    with:
      artifact_name: my-artifact
```

### Composite Actions

```yaml
steps:
  - uses: gbtunney/snailicid3-actions/.github/actions/report-repository@main
  - uses: gbtunney/snailicid3-actions/.github/actions/report-environment@main
  - uses: gbtunney/snailicid3-actions/.github/actions/report-prettier@main
  - uses: gbtunney/snailicid3-actions/.github/actions/report-workspace@main
  - uses: gbtunney/snailicid3-actions/.github/actions/require-up-to-date@main
```

### Requirements

Callers must install dependencies before using actions that invoke `snail-sh`:

```yaml
- uses: pnpm/action-setup@v6
- uses: actions/setup-node@v4
  with:
    node-version: lts/*
- run: pnpm install --frozen-lockfile
```

The `snail-sh` CLI ships as part of `@snailicid3/config` (the `bin/` directory is published to npm). Any project with `@snailicid3/config` in its dependencies will have it available via `pnpm exec snail-sh`.

### Chromatic

`call-pipeline.yml` can run Chromatic visual tests. It executes
`pnpm exec nx run-many -t chromatic`, which runs each project's `chromatic`
package.json script (Nx infers scripts as targets); projects without one are
skipped, so it is safe to enable repo-wide.

Requirements in the calling repository:

1. A `chromatic` script in each Storybook project's package.json that reads
   `$CHROMATIC_PROJECT_TOKEN` (see `@gbt/template-example-react`).
2. The `CHROMATIC_PROJECT_TOKEN` repository secret (from the Chromatic project
   settings page).
3. Pass the flag and the secret when calling the pipeline:

```yaml
jobs:
  pipeline:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-pipeline.yml@main
    secrets: inherit
    with:
      run_build: true
      run_test: true
      run_chromatic: true
```

Repositories that don't need Chromatic (e.g. snailicid3) simply leave
`run_chromatic` unset — it defaults to false.

## Commit message convention

Every commit these workflows create (and every PR title they generate) is derived
the same way `pnpm commit:<type> "message"` derives it locally: the scope is
computed from the changed files by `scope-commit`, never hardcoded.

```sh
pnpm exec scope-commit --staged --message <type> "<subject>"
```

- `call-apply-workspace-artifact.yml` recomputes the scope when
  `scoped_commit_message: true` is passed (dependencies are installed before the
  commit step so `scope-commit` can resolve).
- `call-release-plan.yml` derives the version commit message via `scope-commit`
  and reuses that message as the version PR title. The changeset slug appears
  only in the release branch name (`release/<slug>`).
- If scope derivation fails, the run emits a `::warning::` annotation and falls
  back — never silently.

## Repository layout rules

- Reusable (`workflow_call`) workflows must live directly in `.github/workflows/`
  — a hard GitHub limitation, no subdirectories.
- Composite actions could live anywhere in the repo, but they are kept under
  `.github/actions/` next to their scripts in `.github/scripts/`.
- Inside the reusable `call-*` workflows, composite actions are referenced
  **fully qualified** (`gbtunney/snailicid3-actions/.github/actions/<name>@main`).
  A local `./.github/actions/...` reference inside a reusable workflow resolves
  against the *caller's* checkout and breaks every cross-repo consumer.

## Self-tests

`test-actions.yml` runs on every PR and push to `main`. It installs the fixture
workspace (the root `package.json`, which depends on the published
`@snailicid3/config`) and exercises:

- all five composite actions (with local `./` refs, so the branch under test is
  what runs),
- `call-detect-release-state.yml` (asserting the fixture resolves to
  `should_skip=true`),
- `call-apply-workspace-artifact.yml` (overlaying a generated artifact and
  asserting dirty-state detection),
- `scope-commit` message derivation.

Note: because the `call-*` workflows reference composite actions at `@main`,
changes to an action are only picked up by the reusable workflows after merge —
the self-test's local refs cover them pre-merge.
