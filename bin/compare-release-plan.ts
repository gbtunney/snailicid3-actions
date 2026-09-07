/**
 * Dual-run the canonical Workspace release plan beside this repository's existing detector.
 *
 * Non-mutating and non-enforcing by construction: it observes a checked-out repository, maps the resulting plan onto the
 * legacy output names, prints a field-by-field comparison against the detector output it was handed, and exits 0 whether
 * or not the two agree. Divergence is a review signal for the cutover slice, not a build failure — and nothing here
 * writes to the repository, the registry, or the detector's own outputs.
 *
 * @example
 * ```sh
 * tsx bin/compare-release-plan.ts --detector detector-outputs.json \
 *   [--repo-root <dir>] [--summary "$GITHUB_STEP_SUMMARY"] [--outputs "$GITHUB_OUTPUT"] [--plan-out plan.json]
 * ```
 *
 * `--detector` takes a JSON file of detector outputs, or the name of a recorded historical case
 * (`pull-request-232`, `pull-request-233`, `pull-request-234`) to replay one locally.
 * ```
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import {
    readLegacyReleaseStateFixture,
    type ReleaseStateFixtureName,
} from './release-state-fixtures.js'
import {
    compareReleaseState,
    type LegacyReleaseStateRecord,
    mapReleasePlanToLegacyOutputs,
    produceWorkspaceReleasePlan,
    readReleasePlanDocument,
    renderComparisonMarkdown,
} from './workspace-release-plan.js'

interface Options {
    /** Path to a JSON object of detector outputs, or null to compare against nothing. */
    detector: null | string
    /**
     * Where to append `key=value` result lines; typically `$GITHUB_OUTPUT`.
     *
     * Informational only. Nothing in this slice branches on them, and they exist so a reviewer can see the dual run's
     * result without opening the job summary — not so a caller can start making decisions from an unproven mapping.
     */
    outputs: null | string
    /** Where to write the plan document, for a later job or for inspection. */
    planOut: null | string
    repoRoot: string | undefined
    /** Where to append the Markdown report; typically `$GITHUB_STEP_SUMMARY`. */
    summary: null | string
}

/**
 * GitHub writes job outputs as strings, so `"3"` and `"true"` arrive where a number and a boolean are meant.
 *
 * Coercing here rather than in the comparison keeps the comparison's own equality honest: it compares rendered values,
 * and it should not also be in the business of guessing what a workflow meant.
 */
const coerceDetectorValue = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    if (value === 'true') return true
    if (value === 'false') return false
    if (/^-?\d+$/.test(value)) return Number(value)

    return value
}

const parseOptions = (argv: ReadonlyArray<string>): Options => {
    const options: Options = {
        detector: null,
        outputs: null,
        planOut: null,
        repoRoot: undefined,
        summary: null,
    }

    for (const [index, argument] of argv.entries()) {
        const value = argv[index + 1]

        if (argument === '--detector') options.detector = value ?? null
        if (argument === '--outputs') options.outputs = value ?? null
        if (argument === '--plan-out') options.planOut = value ?? null
        if (argument === '--repo-root') options.repoRoot = value
        if (argument === '--summary') options.summary = value ?? null
    }

    return options
}

/** Read detector outputs from a JSON file, or fall back to a recorded historical case by name. */
const readDetectorOutputs = (source: null | string): LegacyReleaseStateRecord => {
    if (source === null) return {}

    const raw: unknown = source.startsWith('pull-request-')
        ? readLegacyReleaseStateFixture(source as ReleaseStateFixtureName)
        : JSON.parse(readFileSync(source, 'utf8'))

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`Detector outputs in ${source} are not a JSON object.`)
    }

    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
            key,
            coerceDetectorValue(value),
        ]),
    )
}

const options = parseOptions(process.argv.slice(2))

const plan = await produceWorkspaceReleasePlan(options.repoRoot)

/**
 * The plan is re-read through the same boundary an external consumer would use.
 *
 * `createReleasePlan` already returns a validated document, so this looks redundant — it is not. It exercises the
 * schemaVersion gate on the real production path, so the gate cannot rot into something only the fixtures reach.
 */
const validated = readReleasePlanDocument(JSON.parse(JSON.stringify(plan)))

if (!validated.ok) {
    console.error(`::error::${validated.reason}`)
    process.exit(1)
}

const mapped = mapReleasePlanToLegacyOutputs(validated.plan)
const comparison = compareReleaseState(mapped, readDetectorOutputs(options.detector))
const markdown = renderComparisonMarkdown(validated.plan, comparison)

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
            `divergent_field_count=${comparison.divergent.length}`,
            `divergent_fields=${comparison.divergent.map((row) => row.field).join(' ')}`,
            '',
        ].join('\n'),
    )
}

if (comparison.divergent.length > 0) {
    // A notice, deliberately not a warning or an error: this run reports, and the detector remains the active path.
    console.log(
        `::notice::${comparison.divergent.length} release-state field(s) expected to agree did not: ${comparison.divergent
            .map((row) => row.field)
            .join(', ')}. This comparison is non-enforcing.`,
    )
}
