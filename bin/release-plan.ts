/**
 * Produce the canonical release plan for a checked-out repository and report the phase it selects.
 *
 * Non-mutating: it observes a workspace, validates the plan through the same `schemaVersion` boundary an external
 * consumer would use, and writes the selected phase plus a Markdown report. It publishes nothing, versions nothing and
 * tags nothing — deciding whether the selected phase is acted on is `call-release-plan.yml`'s job, gated as it always
 * was on an explicit non-dry-run invocation clearing the real-release guard.
 *
 * This replaces the dual-run comparison CLI from the migration. The detector is no longer a second opinion to compare
 * against, so there is nothing left to compare.
 *
 * @example
 * ```sh
 * tsx bin/release-plan.ts [--repo-root <dir>] \
 *   [--summary "$GITHUB_STEP_SUMMARY"] [--outputs "$GITHUB_OUTPUT"] [--plan-out plan.json]
 * ```
 */

import { appendFileSync, writeFileSync } from 'node:fs'

import {
    mapReleasePlanToOutputs,
    produceWorkspaceReleasePlan,
    readReleasePlanDocument,
    renderReleasePlanReportMarkdown,
    selectReleasePhase,
} from './workspace-release-plan.js'

interface Options {
    /** Where to append `key=value` result lines; typically `$GITHUB_OUTPUT`. */
    outputs: null | string
    /** Where to write the plan document, for a later job or for inspection. */
    planOut: null | string
    repoRoot: string | undefined
    /** Where to append the Markdown report; typically `$GITHUB_STEP_SUMMARY`. */
    summary: null | string
}

const parseOptions = (argv: ReadonlyArray<string>): Options => {
    const options: Options = {
        outputs: null,
        planOut: null,
        repoRoot: undefined,
        summary: null,
    }

    for (const [index, argument] of argv.entries()) {
        const value = argv[index + 1]

        if (argument === '--outputs') options.outputs = value ?? null
        if (argument === '--plan-out') options.planOut = value ?? null
        if (argument === '--repo-root') options.repoRoot = value
        if (argument === '--summary') options.summary = value ?? null
    }

    return options
}

const options = parseOptions(process.argv.slice(2))

const plan = await produceWorkspaceReleasePlan(options.repoRoot)

/**
 * The plan is re-read through the same boundary an external consumer would use.
 *
 * `createReleasePlan` already returns a validated document, so this looks redundant — it is not. It exercises the
 * schemaVersion gate on the real production path, so the gate cannot rot into something only the fixtures reach. It is
 * also the hard boundary now: a plan that fails here stops the release rather than degrading to a guess.
 */
const validated = readReleasePlanDocument(JSON.parse(JSON.stringify(plan)))

if (!validated.ok) {
    console.error(`::error::${validated.reason}`)
    process.exit(1)
}

const mapped = mapReleasePlanToOutputs(validated.plan)
const selection = selectReleasePhase(mapped)
const markdown = renderReleasePlanReportMarkdown(validated.plan, selection)

console.log(markdown)

if (options.planOut !== null) {
    writeFileSync(options.planOut, `${JSON.stringify(validated.plan, null, 4)}\n`)
}

if (options.summary !== null) appendFileSync(options.summary, `${markdown}\n`)

if (options.outputs !== null) {
    appendFileSync(
        options.outputs,
        [
            `schema_version=${validated.plan.schemaVersion}`,
            `release_phase=${selection.phase}`,
            `release_phase_reason=${selection.reason}`,
            `publish_authorized=${selection.publishAuthorized}`,
            `should_version=${mapped.should_version}`,
            `should_publish=${mapped.should_publish}`,
            `release_inventory=${mapped.pending_inventory}`,
            `release_inventory_count=${mapped.pending_inventory_count}`,
            '',
        ].join('\n'),
    )
}
