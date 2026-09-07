# snailicid3-actions

Reusable GitHub Actions and workflows for the `snailicid3` ecosystem.

## Usage

### Reusable Workflows

Reference these from any repository:

```yaml
permissions:
  contents: read

jobs:
  pipeline:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-pipeline.yml@v1
    with:
      build_mode: abort_on_error
      test_mode: abort_on_error
      docs_mode: skip

  nx_targets:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-nx-targets.yml@v1
    with:
      scope: affected
      targets: lint test build
      mode: report

  detect:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-detect-release-state.yml@v1

  compare:
    uses: gbtunney/snailicid3-actions/.github/workflows/call-compare-release-plan.yml@v1
    with:
      adapter_ref: v1

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

Grant those permissions per job, not once at the top. A job-level block
replaces the workflow-level one rather than merging with it, so a restrictive
workflow-level floor plus a per-job minimum keeps read-only jobs read-only. The
per-workflow minimums are in [`templates/README.md`](templates/README.md), and
`bin/check-caller-contract.ts` enforces them on every PR.

### Release-plan adapter (comparison only)

Release truth is moving out of this repository. `@snailicid3/workspace` owns
release intent, exact-version registry observation, per-package status and the
Markdown that reports them, and publishes that as a versioned JSON document.
`call-compare-release-plan.yml` is the first step of consuming it: it observes a
ref through the canonical producer, maps the plan onto the output names
`call-detect-release-state.yml` already produces, and prints the two side by
side.

It decides nothing:

- `call-detect-release-state.yml` is still the active path and the rollback
  target. This slice does not change it and does not change phase selection in
  `call-release-plan.yml`.
- The comparison declares no secrets, only reads the registry, and never fails
  a run on a difference.
- The adapter pins `@snailicid3/workspace@0.2.0` and validates
  `schemaVersion: 1` before it reads a single plan field. An unsupported
  version is rejected explicitly rather than guessed at — package SemVer is not
  a proxy for the schema the document declares.

The one difference worth knowing about before cutover is deliberate. The
detector reads a missing exact version as a publish candidate; the canonical
plan reads it as held inventory and offers no publish operation. On the
historical `snailicid3` cases this shows up as `#233` agreeing on every field,
and `#232`/`#234` differing only on `publish_candidate_count`,
`publish_candidates`, `has_publish_candidates`, `should_publish` and
`should_skip`. `bin/workspace-release-plan.ts` carries the full ledger of which
outputs are expected to agree, which differ on purpose, and which
`schemaVersion: 1` does not carry at all.

### Pipeline policy

`call-pipeline.yml` is the predictable PR/release validation path. It runs the
repository's ordinary routines rather than exposing arbitrary Nx orchestration.

Its public routine controls are:

- `build_mode`, `test_mode`, `docs_mode`: `skip | report | abort_on_error`;
- `check_mode`: `fix | check | skip`;
- `api_report_mode`: `update | check | skip`;
- `lockfile_mode`: `frozen | reconcile`.

The pipeline no longer exposes `use_nx_affected`, free-form `nx_targets`, Nx
cache reset, `nx fix-ci`, `pnpm_cache`, or a per-run Nx Cloud switch. Nx Cloud
is repository policy through `vars.DISABLE_NX_CLOUD`.

For arbitrary Nx target execution, use `call-nx-targets.yml` or the synced
**Dispatch Nx Targets** workflow. Its contract is deliberately small:

```yaml
scope: all | affected
targets: "lint test build"
mode: report | abort_on_error
```

Nx `affected` is an execution optimization only; it does not imply release
intent or publish selection.

### Composite Actions

```yaml
steps:
  - uses: gbtunney/snailicid3-actions/.github/actions/report-repository@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-environment@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-prettier@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/report-workspace@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/require-up-to-date@v1
  - uses: gbtunney/snailicid3-actions/.github/actions/run-chromatic@v1
```

### Requirements

Callers must install dependencies before using actions that invoke `snail-sh`:

```yaml
- uses: pnpm/action-setup@v6
- uses: actions/setup-node@v7
  with:
    node-version: '24'
- run: pnpm install --frozen-lockfile
```

The `snail-sh` CLI ships as part of `@snailicid3/config`. Any project with
`@snailicid3/config` in its dependencies has it via `pnpm exec snail-sh`.

### Caller workflow templates

GitHub can only share `workflow_call` workflows across repositories — the thin
trigger workflows (`dispatch-*`, `pr-checks`, `push-main`, `push-release`) must
physically exist in every repo. Canonical copies live in
[`templates/workflows/`](templates/workflows/).

To stamp local clones:

```sh
bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
bin/sync-callers.sh --check ../snailicid3
```

Templates carry no repo-specific values. Secrets (`NPM_TOKEN`, `GH_PAT`) are
forwarded by name only where the called workflow declares them. The
`DISABLE_NX_CLOUD` repository variable remains the vars-based Nx Cloud policy.

### Chromatic

Chromatic is a **composite action**, not part of `call-pipeline.yml`, and that
is deliberate.

`workflow_call.secrets` has no dynamic form: a reusable workflow can only
receive secrets under names it declares literally. Running Chromatic inside
the shared pipeline would require this repository to know every consumer's
project-token names. Instead, the consumer sets its own job-level `env:` and
uses the shared `run-chromatic` action.

`run-chromatic` owns the step policy (`skip`, `report`, `abort_on_error`) and a
single `pnpm exec nx run-many -t chromatic`; the consumer owns which projects
exist, which token each reads, and each project's Chromatic CLI flags.

See [`templates/README.md`](templates/README.md) for the consumer-owned workflow
example.

### Lockfiles

`pnpm-lock.yaml` is only rewritten when a caller asks for it. Every workflow
that installs uses `lockfile_mode`:

| `lockfile_mode` | Behaviour |
| --- | --- |
| `frozen` (default) | `pnpm install --frozen-lockfile`. A stale lockfile fails; nothing is rewritten. |
| `reconcile` | `pnpm install --no-frozen-lockfile`. The existing lockfile is updated as needed to satisfy manifests; it is not deleted and resolved from scratch. |

To repair a stale lockfile deliberately, run **Dispatch Workspace Update** with
`repair_lockfile` enabled. Destructive reset / fresh re-resolution is separate
and is not offered here.

## Commit message convention

Every commit these workflows create, and every PR title they generate, is
derived the same way `pnpm commit:<type> "message"` is derived locally: scope
comes from changed files through `scope-commit`.

```sh
pnpm exec scope-commit --staged --message <type> "<subject>"
```

- `call-apply-workspace-artifact.yml` recomputes scope when
  `scoped_commit_message: true` is passed.
- `call-release-plan.yml` derives the version commit message via `scope-commit`
  and reuses it as the version PR title.
- If scope derivation fails, the run emits a warning and falls back explicitly.

## Repository layout rules

- Reusable (`workflow_call`) workflows live directly in `.github/workflows/`.
- Composite actions live under `.github/actions/`, with scripts under
  `.github/scripts/`.
- Two Node versions are unrelated: `node_version` selects the Node used to
  build/test the repository, while the major of `actions/checkout@v7` or
  `actions/setup-node@v7` selects the runtime bundled by that GitHub Action.
- `dependencies` in `package.json` is the adapter's runtime closure — what a
  consumer's CI installs to run `bin/compare-release-plan.ts` with
  `pnpm install --prod`. `devDependencies` is this repository's own self-test
  toolchain. `@snailicid3/workspace` owns its dependency closure, so Logger,
  Node Utils, Utils, Color and Types are never installed here by name.
- Historical characterization documents live under `test-fixtures/`. The
  canonical plans are byte-for-byte copies of the frozen documents in
  `gbtunney/snailicid3`, because the published package ships only `dist` and
  `types`.

## Self-tests

`test-actions.yml` runs on every PR and push to `main`. It exercises the
composite actions, reusable release workflows, scope-commit derivation,
lockfile policy, caller contracts, template sync/drift/orphan detection, and
YAML parsing.

The release-plan adapter is covered twice. `pnpm test:adapter` runs offline
against the recorded `#232`/`#233`/`#234` documents and proves both that an
unsupported `schemaVersion` is refused before any field is read and that the
mapping reproduces those cases. `compare_release_plan` then runs the real dual
run against this repository's own fixture workspace, where the detector and the
canonical plan are expected to agree completely — a divergence there fails this
repository's self-test while staying non-enforcing for consumers.

### Cross-repository smoke

Same-repository refs cannot exercise the boundary that breaks consumers: a
remote `<owner>/<repo>/...@<ref>` call can fail before any job starts. Two
workflows test that boundary:

- **Smoke Cross-Repo (main)** — on workflow/template changes to `main` and on
  demand. It covers release-plan, pipeline, and the Nx-target utility.
- **Smoke Cross-Repo (v1)** — weekly and on demand against the tag consumers
  pin. Its caller uses only inputs shared across the tag-transition boundary;
  dispatch it again after promoting `v1`.

The `v1` tag is promoted only after the new `main` contract is known-good;
consumer caller sync happens after that promotion so synced templates never
reference inputs the published tag does not yet declare.
