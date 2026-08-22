# Caller workflow templates

GitHub can only share `workflow_call` workflows across repositories. The thin
trigger workflows in [`workflows/`](workflows/) (`dispatch-*`, `pr-checks`,
`push-*`) must physically exist in every consumer repository, so these files
are the source of truth and are copied verbatim:

```sh
bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
bin/sync-callers.sh --chromatic ../gbt-monorepov2   # repos with a chromatic script
bin/sync-callers.sh --check ../snailicid3           # fail on drift, write nothing
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
secret set through a contract nobody wrote down, and it is the one thing about
a cross-repository call that cannot be reviewed by reading either file. Named
forwarding is also what makes the boundary testable: the checker can compare
what a caller sends against what the called workflow declares.

Every secret is optional. An unset repository secret forwards as an empty
string, and the reusable workflow falls back (`GH_PAT` → `github.token`) or
skips the step that would have used it — so a repository that never publishes
does not need `NPM_TOKEN`, and one that leaves `chromatic_mode` at `skip`
needs no Chromatic project token.

### 2. Grant at least the permissions the called workflow declares

A caller cannot grant a called workflow fewer permissions than it requests.
Ask for less — even by leaving a scope out — and the run dies at startup.

Grant them per job. A job-level `permissions:` block replaces the
workflow-level one rather than merging with it, so the pattern is a
restrictive workflow-level floor plus a per-job minimum — that way a summary
or guard job never holds the write token the release call needed:

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
| `call-pipeline.yml` | `CHROMATIC_PROJECT_TOKEN_GBT_SCOPE`, `CHROMATIC_PROJECT_TOKEN_VIDEO_INTELLIGENCE`, `CHROMATIC_PROJECT_TOKEN_TEMPLATE_EXAMPLE_REACT` | the Chromatic step, only when `chromatic_mode` is not `skip`. One token per Storybook project; all are exported into a single `nx run-many -t chromatic` | `contents: read` |
| `call-apply-workspace-artifact.yml` | `GH_PAT`, `NPM_TOKEN` | `GH_PAT`: checkout/push, so a pushed commit can trigger follow-up workflows. `NPM_TOKEN`: exported as `NODE_AUTH_TOKEN` for `post_overlay_command` only | `contents: write`, `actions: read`, `id-token: write` |
| `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` | the `dry_run: false` path only — version PR, release tags, `changeset publish` | `contents: write`, `actions: write`, `id-token: write`, `pull-requests: write` |

`call-release-plan.yml` nests the other three. It forwards `GH_PAT`/`NPM_TOKEN`
to `call-apply-workspace-artifact.yml` by name too, so a caller's grant is
exactly what the innermost workflow can read.

## What each template forwards

| Template | Calls | Secrets forwarded |
| --- | --- | --- |
| `dispatch-release-plan.yml` | `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` |
| `push-release.yml` | `call-release-plan.yml` | `GH_PAT`, `NPM_TOKEN` |
| `dispatch-workspace-update.yml` | `call-pipeline.yml`, `call-apply-workspace-artifact.yml` | `GH_PAT` (no `post_overlay_command`, so nothing reaches npm) |
| `pr-checks.yml` | `call-detect-release-state.yml`, `call-pipeline.yml` | the Chromatic project tokens |
| `push-main.yml` | `call-pipeline.yml` | the Chromatic project tokens |
| `dispatch-pipeline.yml` | `call-pipeline.yml` | the Chromatic project tokens |
| `dispatch-smoke-matrix.yml` | `call-pipeline.yml` | — (`chromatic_mode` stays `skip`) |
| `dispatch-release-state.yml` | `call-detect-release-state.yml` | — |

## Chromatic: one token per project

`call-pipeline.yml` decides only *whether* Chromatic runs and what a failure
costs:

| `chromatic_mode` | Behaviour |
| --- | --- |
| `skip` (default) | The Nx target is never invoked and no credential is needed |
| `report` | Chromatic runs; a failure is recorded but does not fail the workflow |
| `abort_on_error` | Chromatic runs and a failure fails the workflow |

Everything else belongs to the project. Each Storybook project's `chromatic`
target names the token variable it reads and owns its own CLI flags:

```json
{
    "scripts": {
        "chromatic": "chromatic --project-token=$CHROMATIC_PROJECT_TOKEN_GBT_SCOPE --exit-once-uploaded"
    }
}
```

Because every declared token is exported before a single
`pnpm exec nx run-many -t chromatic`, projects with different tokens all
publish from one invocation — no per-project matrix job. Projects without a
`chromatic` target are skipped by Nx as before.

Token names are `CHROMATIC_PROJECT_TOKEN_<PACKAGE>`. The token inventory in
`call-pipeline.yml` is explicit, because a reusable
workflow can only declare secrets by literal name and discovering names by
reading package manifests would make the contract unreviewable. Adding a
Storybook project therefore means one new declaration there, one `env:` entry
in the Chromatic step, a line in each caller template, and a `v1` re-tag.

Tokens are matched to projects by name only. The step prints which token names
were and were not provided, never a value.

## Changing the contract

The reusable workflow and every caller that invokes it move together:

1. Change the secret declaration in `.github/workflows/call-*.yml`.
2. Update every template here that calls it.
3. `pnpm check:callers` — catches a template left behind.
4. `bin/sync-callers.sh <consumer> ...` so consumers stop drifting, then
   `bin/sync-callers.sh --check <consumer>` to confirm. `--check` also fails on
   a consumer file that still carries the generated header but no longer has a
   template — deleting or renaming a template otherwise leaves an obsolete
   caller holding the old secret contract forever.
5. After moving the `v1` tag, dispatch **Smoke Cross-Repo (v1)**. It calls the
   published workflows through a remote ref the way a consumer does, which is
   the only check that exercises the boundary a same-repository self-test
   cannot reach.
