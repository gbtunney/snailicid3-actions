# Caller workflow templates

GitHub can only share `workflow_call` workflows across repositories. The thin
trigger workflows in [`workflows/`](workflows/) (`dispatch-*`, `pr-checks`,
`push-*`) must physically exist in every consumer repository, so these files
are the source of truth and are copied verbatim:

```sh
bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
bin/sync-callers.sh --check ../snailicid3
```

## The caller contract

A caller that gets any of the three rules below wrong does not fail a job.
GitHub refuses to start the run: conclusion `startup_failure`, **zero jobs**, no
logs to read. The rules are checked statically by
`bin/check-caller-contract.ts` (`pnpm check:callers`), run on every PR by
`test-actions.yml` against the templates *and* against freshly synced consumer
copies.

### 1. Forward secrets by name — never `secrets: inherit`

Every reusable workflow declares the secrets it reads. Callers pass exactly
those, by name:

```yaml
jobs:
    release_plan:
        uses: gbtunney/snailicid3-actions/.github/workflows/call-release-plan.yml@v1
        secrets:
            GH_PAT: ${{ secrets.GH_PAT }}
            NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`secrets: inherit` hands a workflow in another repository the caller's entire
secret set through a contract nobody wrote down. Named forwarding also makes
the boundary testable: the checker can compare what a caller sends against
what the called workflow declares.

Every secret is optional. An unset repository secret forwards as an empty
string, and the reusable workflow falls back (`GH_PAT` → `github.token`) or
skips the step that would have used it.

### 2. Grant at least the permissions the called workflow declares

A caller cannot grant a called workflow fewer permissions than it requests.
Ask for less — even by leaving a scope out — and the run dies at startup.

Grant them per job. A job-level `permissions:` block replaces the
workflow-level one rather than merging with it, so the pattern is a
restrictive workflow-level floor plus a per-job minimum.

```yaml
permissions:
    contents: read

jobs:
    release_plan:
        permissions:
            contents: write
            actions: write
            id-token: write
            pull-requests: write
        uses: gbtunney/snailicid3-actions/.github/workflows/call-release-plan.yml@v1
```

### 3. Reference reusable workflows by their full path

`./.github/workflows/...` resolves against the *consumer's* checkout, where the
file does not exist. Callers outside this repository always use
`gbtunney/snailicid3-actions/.github/workflows/<file>.yml@v1`.

## What each reusable workflow declares

| Reusable workflow | Secrets | Consumed by | Permissions a caller must grant |
| --- | --- | --- | --- |
| `call-detect-release-state.yml` | — | read-only detection | `contents: read` |
| `call-compare-release-plan.yml` | — | non-enforcing dual run of the detector against the canonical `@snailicid3/workspace` release plan | `contents: read` |
| `call-pipeline.yml` | — | predictable repository build/test/check/docs routines | `contents: read` |
| `call-nx-targets.yml` | — | explicit ad-hoc `nx run-many` / `nx affected` target execution | `contents: read` |
| `call-apply-workspace-artifact.yml` | `GH_PAT`, `NPM_TOKEN` | `GH_PAT`: checkout/push. `NPM_TOKEN`: exported as `NODE_AUTH_TOKEN` for `post_overlay_command` only | `contents: write`, `actions: read`, `id-token: write` |
| `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` | the `dry_run: false` path only — version PR, release tags, `changeset publish` | `contents: write`, `actions: write`, `id-token: write`, `pull-requests: write` |

`call-release-plan.yml` nests the other release workflows. It forwards
`GH_PAT`/`NPM_TOKEN` to `call-apply-workspace-artifact.yml` by name too, so a
caller's grant is exactly what the innermost workflow can read.

## What each template forwards

| Template | Calls | Secrets forwarded |
| --- | --- | --- |
| `dispatch-release-plan.yml` | `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` |
| `push-release.yml` | `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` |
| `dispatch-workspace-update.yml` | `call-pipeline.yml`, `call-apply-workspace-artifact.yml` | `GH_PAT` |
| `pr-checks.yml` | `call-detect-release-state.yml`, `call-pipeline.yml` | — |
| `push-main.yml` | `call-pipeline.yml` | — |
| `dispatch-pipeline.yml` | `call-pipeline.yml` | — |
| `dispatch-nx-targets.yml` | `call-nx-targets.yml` | — |
| `dispatch-smoke-matrix.yml` | `call-pipeline.yml` | — |
| `dispatch-release-state.yml` | `call-detect-release-state.yml` | — |

## Pipeline policy vs. Nx utility

`call-pipeline.yml` is the predictable PR/release path. Its public routine
controls are semantic modes:

- `build_mode`, `test_mode`, `docs_mode`: `skip | report | abort_on_error`;
- `check_mode`: `fix | check | skip`;
- `api_report_mode`: `update | check | skip`;
- `lockfile_mode`: `frozen | reconcile`.

It does **not** expose arbitrary Nx targets, affected-mode switches, cache-reset
buttons, `nx fix-ci`, or a pnpm-cache toggle. Nx Cloud is repository policy via
`vars.DISABLE_NX_CLOUD`, not a per-run pipeline input.

For an explicit ad-hoc Nx request, use `call-nx-targets.yml` or the synced
**Dispatch Nx Targets** template. Its contract is intentionally small:

```yaml
scope: all | affected
targets: "lint test build"
mode: report | abort_on_error
```

Nx `affected` is an execution optimization only. It does not imply Changesets
intent, release selection, or publication eligibility.

## Chromatic lives outside the reusable pipeline

`call-pipeline.yml` declares no secrets, and does not run Chromatic.

`workflow_call.secrets` has no dynamic form, so a reusable workflow can only
receive secrets under names it declares literally. Running Chromatic there
would mean this shared repository listing every consumer's project token by
name. A composite action has no such contract: the caller sets `env:` in its
own workflow with whatever names it likes.

[`run-chromatic`](../.github/actions/run-chromatic/action.yml) owns the
orchestration while the consumer owns the credentials:

| Owned here | Owned by the consumer |
| --- | --- |
| `mode` — `skip`, `report`, `abort_on_error` | which projects exist |
| running `nx run-many -t chromatic` once for every project | which token each project reads |
| turning a failed target into a warning or a failure | each project's Chromatic CLI flags |

Add a workflow like this to the consumer repository. It is **not** a synced
template — the token names are repository-specific, so `bin/sync-callers.sh`
must not own this file:

```yaml
name: Chromatic

on:
    pull_request:
        branches: [main]

permissions:
    contents: read

env:
    HUSKY: 0
    CHROMATIC_PROJECT_TOKEN_GBT_SCOPE: ${{ secrets.CHROMATIC_PROJECT_TOKEN_GBT_SCOPE }}
    CHROMATIC_PROJECT_TOKEN_VIDEO_INTELLIGENCE: ${{ secrets.CHROMATIC_PROJECT_TOKEN_VIDEO_INTELLIGENCE }}

jobs:
    chromatic:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v7
              with:
                  fetch-depth: 0
            - uses: pnpm/action-setup@v6
              with:
                  run_install: false
            - uses: actions/setup-node@v7
              with:
                  node-version: '24'
                  cache: pnpm
            - run: pnpm install --frozen-lockfile

            - uses: gbtunney/snailicid3-actions/.github/actions/run-chromatic@v1
              with:
                  mode: abort_on_error
```

Each project's `chromatic` target names the variable it reads and carries its
own flags, so one invocation covers projects with different tokens, and
projects without the target are skipped by Nx.

## Changing the contract

The reusable workflow and every caller that invokes it move together:

1. Change the reusable workflow in `.github/workflows/call-*.yml`.
2. Update every template here that calls it.
3. `pnpm check:callers` — catches secret/permission/path contract drift.
4. `bin/sync-callers.sh <consumer> ...`, then
   `bin/sync-callers.sh --check <consumer>` to confirm generated callers.
5. Move the `v1` tag only after the new main contract is known-good, then
   dispatch **Smoke Cross-Repo (v1)**.
