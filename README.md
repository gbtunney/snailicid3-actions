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
