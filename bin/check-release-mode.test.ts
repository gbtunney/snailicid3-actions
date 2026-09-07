/**
 * Self-test for the release execution-mode contract in
 * {@link file://./../.github/workflows/call-release-plan.yml}.
 *
 * The rules that decide whether a run observes or releases live in one shell step, and they are the rules a maintainer
 * is most likely to be wrong about: a deprecated inverted boolean, a repository policy, a triggering event and two
 * derived prerequisites all meet there. Asserting them by reading the workflow's own step body — rather than a copy of
 * it — is what keeps this test honest: it cannot pass against logic the workflow does not actually run.
 *
 * @example
 * ```sh
 * pnpm test:release-mode
 * ```
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'call-release-plan.yml')

/**
 * Lift the resolver's shell body out of the workflow.
 *
 * The step is found by name and the body is dedented by its `run: |` block indent, so the extracted script is what the
 * runner executes rather than an approximation of it.
 */
const extractResolver = (): string => {
    const text = readFileSync(WORKFLOW, 'utf8')
    const stepIndex = text.indexOf('- name: Resolve execution mode')

    if (stepIndex === -1) {
        throw new Error('call-release-plan.yml no longer has a "Resolve execution mode" step.')
    }

    const bodyStart = text.indexOf('run: |\n', stepIndex) + 'run: |\n'.length
    const rest = text.slice(bodyStart)
    const lines: string[] = []

    for (const line of rest.split('\n')) {
        // The body ends at the next step, which sits at a shallower indent.
        if (line.trim() !== '' && !line.startsWith(' '.repeat(18))) break
        lines.push(line.slice(18))
    }

    return lines.join('\n')
}

const resolver = extractResolver()

interface Case {
    /** Substring the failure must mention, or null when the case must succeed. */
    expectError: null | string
    /** Resolved execution, asserted only when the case succeeds. */
    expectExecution?: 'observe' | 'release'
    /** Substring the run's output must contain, checked on success. */
    expectOutput?: string
    env: Record<string, string>
    name: string
}

/** Defaults matching the workflow's own input defaults, so each case states only what it changes. */
const baseEnv = {
    DRY_RUN: 'true',
    EVENT_NAME: 'workflow_dispatch',
    MODE: '',
    RELEASE_MODE: 'manual',
    RUN_PIPELINE: 'true',
    UPLOAD_ARTIFACT: 'true',
}

const cases: Case[] = [
    // ── Defaults and the two positive modes ─────────────────────────────────
    {
        env: {},
        expectError: null,
        expectExecution: 'observe',
        name: 'defaults observe',
    },
    {
        env: { MODE: 'observe' },
        expectError: null,
        expectExecution: 'observe',
        name: 'mode observe observes',
    },
    {
        env: { MODE: 'release' },
        expectError: null,
        expectExecution: 'release',
        name: 'mode release releases',
    },

    // ── release_mode as the repository policy ───────────────────────────────
    {
        env: { EVENT_NAME: 'push', RELEASE_MODE: 'manual' },
        expectError: null,
        expectExecution: 'observe',
        name: 'release_mode manual: a push observes',
    },
    {
        env: { EVENT_NAME: 'push', RELEASE_MODE: 'main' },
        expectError: null,
        expectExecution: 'release',
        name: 'release_mode main: a push releases',
    },
    {
        env: { EVENT_NAME: 'push', MODE: 'release', RELEASE_MODE: 'manual' },
        expectError: 'cannot release under release_mode',
        name: 'release_mode manual: a push cannot be forced to release',
    },
    {
        env: { EVENT_NAME: 'push', MODE: 'release', RELEASE_MODE: 'main' },
        expectError: null,
        expectExecution: 'release',
        name: 'release_mode main: an explicit push release is allowed',
    },
    {
        // Dispatch is the escape hatch and must work under either policy.
        env: { EVENT_NAME: 'workflow_dispatch', MODE: 'release', RELEASE_MODE: 'manual' },
        expectError: null,
        expectExecution: 'release',
        name: 'release_mode manual: manual dispatch can still release',
    },

    // ── Deprecated dry_run ──────────────────────────────────────────────────
    {
        env: { DRY_RUN: 'false' },
        expectError: null,
        expectExecution: 'release',
        expectOutput: 'dry_run is deprecated',
        name: 'dry_run false maps to release and warns',
    },
    {
        env: { DRY_RUN: 'false', MODE: 'observe' },
        expectError: 'Conflicting inputs',
        name: 'dry_run false with mode observe is a conflict',
    },
    {
        // `true` is the input default, so it cannot be distinguished from unset
        // and must not override an explicit mode.
        env: { DRY_RUN: 'true', MODE: 'release' },
        expectError: null,
        expectExecution: 'release',
        name: 'dry_run true does not override mode release',
    },

    // ── Derived prerequisites ───────────────────────────────────────────────
    {
        env: { MODE: 'release', RUN_PIPELINE: 'false' },
        expectError: 'requires the validation pipeline',
        name: 'a release refuses to skip its validation pipeline',
    },
    {
        env: { MODE: 'release', UPLOAD_ARTIFACT: 'false' },
        expectError: 'publishes from the workspace artifact',
        name: 'a release refuses to drop the artifact it publishes from',
    },
    {
        env: { MODE: 'observe', RUN_PIPELINE: 'false' },
        expectError: null,
        expectExecution: 'observe',
        name: 'an observation may skip the pipeline',
    },

    // ── Input validation ────────────────────────────────────────────────────
    {
        env: { MODE: 'dry-run' },
        expectError: 'Invalid mode',
        name: 'an unknown mode is rejected',
    },
    {
        env: { RELEASE_MODE: 'auto' },
        expectError: 'Invalid release_mode',
        name: 'an unknown release_mode is rejected',
    },
]

let failures = 0

const runCase = (testCase: Case): void => {
    // GITHUB_OUTPUT is a real file on a runner, and the resolver appends to it.
    // Giving it one here keeps the extracted body unmodified, so what runs is
    // what the workflow runs.
    const workDir = mkdtempSync(join(tmpdir(), 'release-mode-'))
    const outputPath = join(workDir, 'github-output')
    let stdout = ''
    let failed = false

    try {
        writeFileSync(outputPath, '')
        stdout = execFileSync('bash', ['-c', resolver], {
            encoding: 'utf8',
            env: {
                ...process.env,
                ...baseEnv,
                ...testCase.env,
                GITHUB_OUTPUT: outputPath,
                GITHUB_STEP_SUMMARY: join(workDir, 'summary'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch (error) {
        failed = true
        stdout = `${String((error as { stdout?: string }).stdout ?? '')}${String((error as { stderr?: string }).stderr ?? '')}`
    }

    // Job outputs and log output are different channels; the assertions below
    // read whichever one the claim is actually about.
    stdout += readFileSync(outputPath, 'utf8')
    rmSync(workDir, { force: true, recursive: true })

    const problems: string[] = []

    if (testCase.expectError === null) {
        if (failed) problems.push(`expected success, exited non-zero`)
        if (
            testCase.expectExecution &&
            !stdout.includes(`execution=${testCase.expectExecution}`)
        ) {
            problems.push(`expected execution=${testCase.expectExecution}`)
        }
        if (testCase.expectOutput && !stdout.includes(testCase.expectOutput)) {
            problems.push(`expected output containing "${testCase.expectOutput}"`)
        }
    } else {
        if (!failed) problems.push('expected a non-zero exit')
        if (!stdout.includes(testCase.expectError)) {
            problems.push(`expected error containing "${testCase.expectError}"`)
        }
        // A refused run must not also emit a resolved execution, or a caller
        // reading outputs could act on a decision the workflow rejected.
        if (stdout.includes('execution=')) {
            problems.push('a refused run must not emit an execution')
        }
    }

    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${testCase.name}`)

    if (problems.length > 0) {
        failures += 1
        for (const problem of problems) console.log(`        ${problem}`)
        console.log(`        got: ${stdout.trim().split('\n').join('\n             ')}`)
    }
}

for (const testCase of cases) runCase(testCase)

if (failures > 0) {
    console.error(`\n${failures} release-mode self-test(s) failed.`)
    process.exit(1)
}

console.log(`\nAll ${cases.length} release-mode self-tests passed.`)
