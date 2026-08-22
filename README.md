# snailicid3-actions

Reusable GitHub Actions and workflows for the `snailicid3` ecosystem.

## Usage

### Reusable Workflows

Reference these from any repository:

```yaml
# Workflow-level floor; every job elevates to its own minimum.
permissions:
  contents: read

jobs:
  pipeline:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-pipeline.yml@v1
    with:
      run_build: true
      run_test: true

  detect:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-detect-release-state.yml@v1

  release:
    permissions:
      contents: write
      actions: write
      id-token: write
      pull-requests: write
    uses: gbtunney/snailicid3-actions/.github/workflows/call-release-plan.yml@v1
    secrets:
      GH_PAT: ${{ secrets.GH_PAT }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

  apply:
    permissions:
      contents: write
      actions: read
      id-token: write
    uses: gbtunney/snailicid3-actions/.github/workflows/call-apply-workspace-artifact.yml@v1
    secrets:
      GH_PAT: ${{ secrets.GH_PAT }}
    with:
      artifact_name: my-artifact
```

Callers forward secrets **by name**, never `secrets: inherit`, and must grant
at least the permissions the called workflow declares. Get either wrong and
GitHub refuses to start the run — `startup_failure`, zero jobs, nothing to
read.

Grant those permissions per job, not once at the top: a job-level block
replaces the workflow-level one rather than merging with it, so a restrictive
workflow-level floor plus a per-job minimum keeps `pipeline`, `detect`, and
any summary job on a read-only token while `release` gets what it needs. The
per-workflow minimums, and the secret each workflow actually consumes, are in
[`templates/README.md`](templates/README.md); `bin/check-caller-contract.ts`
enforces both rules on every PR.

### Composite Actions

```yaml
steps:
  - uses: gbtunney/snailicid3-actions/.github/actions/report-repository@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-environment@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-prettier@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-workspace@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/require-up-to-date@v1
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

### Caller workflow templates

GitHub can only share `workflow_call` workflows across repositories — the thin
trigger workflows (`dispatch-*`, `pr-checks`, `push-main`, `push-release`) must
physically exist in every repo. The canonical copies live in
[`templates/workflows/`](templates/workflows/): to onboard or update a repo,
copy them into `<your-repo>/.github/workflows/` verbatim. The contract those
callers have to honour is documented in
[`templates/README.md`](templates/README.md).

```sh
cp path/to/snailicid3-actions/templates/workflows/*.yml .github/workflows/
```

To stamp all local clones at once, use the sync script:

```sh
bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
bin/sync-callers.sh --chromatic ../gbt-monorepov2
bin/sync-callers.sh --check ../snailicid3   # writes nothing; fails on drift
```

**Planned (not yet built): auto-PR sync.** Once the template set stabilizes, a
`dispatch-sync-callers.yml` workflow in this repository will propagate template
changes automatically: triggered on pushes to `main` touching `templates/**`
(plus manual dispatch), a matrix job per consumer repo checks the repo out,
runs the same sync, commits with a scope-commit-derived message, and opens a PR
in that repo. It needs the `GH_PAT` secret with `workflow` scope — the default
`GITHUB_TOKEN` cannot push workflow files to other repositories. Deferred
deliberately until the migration dust settles.

Behavior is controlled by explicit workflow inputs, following the repo
pattern: every `call-*` input has a matching `dispatch-*` input for manual
runs, and the triggered callers (`pr-checks`, `push-*`) pass the same inputs
with values written in the file. The only repo-specific line is
`run_chromatic:` in `pr-checks`/`push-main` — `bin/sync-callers.sh --chromatic`
sets it to `true` during sync for repos that use Chromatic. Secrets
(`CHROMATIC_PROJECT_TOKEN`, `NPM_TOKEN`, `GH_PAT`) are forwarded by name from
each caller job to the workflow that declares them, so a template only names
the secrets that template's calls actually consume; the `DISABLE_NX_CLOUD`
repository variable remains the one vars-based switch (pre-existing Nx Cloud
policy).

### Chromatic

`call-pipeline.yml` can run Chromatic visual tests. It executes
`pnpm exec nx run-many -t chromatic`, which runs each project's `chromatic`
package.json script (Nx infers scripts as targets); projects without one are
skipped, so it is safe to enable repo-wide.

Requirements in the calling repository:

1. A `chromatic` script in each Storybook project's package.json that reads
   `$CHROMATIC_PROJECT_TOKEN` (see `@gbt/template-example-react`).
2. The `CHROMATIC_PROJECT_TOKEN` repository secret (from the Chromatic project
   settings page) — the only secret Chromatic needs.
3. Pass the flag and the secret when calling the pipeline:

```yaml
jobs:
  pipeline:
    permissions:
      contents: read
    uses: gbtunney/snailicid3-actions/.github/workflows/call-pipeline.yml@v1
    secrets:
      CHROMATIC_PROJECT_TOKEN: ${{ secrets.CHROMATIC_PROJECT_TOKEN }}
    with:
      run_build: true
      run_test: true
      run_chromatic: true
```

Repositories that don't need Chromatic (e.g. snailicid3) keep
`run_chromatic: false` in their callers (the template default). Manual runs:
`dispatch-pipeline` exposes `run_chromatic` as a checkbox, so Chromatic can be
triggered and tested by hand in any repo with the secret set, independent of
what the triggered callers do.

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
  **fully qualified** (`gbtunney/snailicid3-actions/.github/actions/<name>@v1`).
  A local `./.github/actions/...` reference inside a reusable workflow resolves
  against the *caller's* checkout and breaks every cross-repo consumer.
- Two Node versions are in play and they are unrelated. The `node_version`
  input picks the Node the *workspace* builds and tests with. The major pinned
  on an official action (`actions/checkout@v7`) picks the Node runtime GitHub
  executes that *action's own* JavaScript on. A deprecation warning about the
  action runtime is never fixed by changing `node_version`, and pinning a
  newer action major does not change what the build runs on.

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
- `call-release-plan.yml` in dry-run mode,
- `scope-commit` message derivation,
- the caller contract (`pnpm check:callers`, `bin/check-caller-contract.ts`)
  against the reusable workflows, the templates, and a consumer synced fresh
  from those templates — plus `pnpm test:callers`, which proves the checker
  still rejects each mistake it claims to catch, and `bin/sync-callers.sh
  --check`, including its orphaned-template case.

### Cross-repository smoke

Same-repository refs cannot reach the boundary that breaks consumers: a remote
`<owner>/<repo>/...@<ref>` call, where a wrong secret or permission contract
makes GitHub refuse to start the run (`startup_failure`, zero jobs) instead of
failing a job. Two workflows call the reusable workflows through that remote
path, read-only:

- **Smoke Cross-Repo (main)** — on pushes to `main` that touch workflows or
  templates, and on demand.
- **Smoke Cross-Repo (v1)** — weekly and on demand, against the tag consumers
  pin. Dispatch it after moving `v1`.

They are separate files from `test-actions.yml`, and from each other, because a
startup failure takes down an entire run: a broken published tag must not be
able to erase the other suites' signal.

> Note: the `call-*` workflows reference composite actions with `$/`, so each
composite action resolves from the same repository commit as the reusable
workflow that invoked it. This keeps tagged workflow releases self-contained.