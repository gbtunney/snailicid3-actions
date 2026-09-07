/**
 * Self-test for {@link file://./workspace-release-plan.ts}.
 *
 * Two things are worth proving about an adapter that has not been cut over yet. The first is that it refuses a document
 * it does not understand *before* it reads a field, because a version check that runs after the mapping is not a version
 * check. The second is that its mapping reproduces the historical release-state cases — and that where it does not, the
 * difference is the declared one and not a mistake.
 */

import {
    compareReleaseState,
    type LegacyReleaseStateOutputs,
    type LegacyReleaseStateRecord,
    mapReleasePlanToLegacyOutputs,
    readReleasePlanDocument,
    RELEASE_STATE_FIELD_RULES,
    renderComparisonMarkdown,
} from './workspace-release-plan.js'
import {
    readLegacyReleaseStateFixture,
    readReleasePlanFixture,
    releaseStateFixtureNames,
    type ReleaseStateFixtureName,
} from './release-state-fixtures.js'

let failures = 0

/** Record one assertion, printing enough on failure to fix it without re-running anything. */
const check = (name: string, passed: boolean, detail?: string): void => {
    console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}`)
    if (!passed) {
        failures += 1
        if (detail) console.log(`        ${detail}`)
    }
}

/** Parse a fixture through the adapter's own boundary, failing loudly rather than returning a half-built plan. */
const planOf = (name: ReleaseStateFixtureName) => {
    const result = readReleasePlanDocument(readReleasePlanFixture(name))

    if (!result.ok) throw new Error(`${name} did not parse: ${result.reason}`)

    return result.plan
}

const legacyOf = (name: ReleaseStateFixtureName): LegacyReleaseStateRecord =>
    readLegacyReleaseStateFixture(name) as LegacyReleaseStateRecord

// ── schemaVersion enforcement ────────────────────────────────────────────────

for (const name of releaseStateFixtureNames) {
    check(
        `${name} is accepted as schemaVersion 1`,
        readReleasePlanDocument(readReleasePlanFixture(name)).ok,
    )
}

{
    const future = {
        ...(readReleasePlanFixture('pull-request-232') as Record<string, unknown>),
        schemaVersion: 2,
    }
    const result = readReleasePlanDocument(future)

    check(
        'a future schemaVersion is rejected as unsupported',
        !result.ok && result.reason.includes('Unsupported release-plan schemaVersion 2'),
        result.ok ? 'accepted a schemaVersion 2 document' : result.reason,
    )
}

{
    const { schemaVersion: _dropped, ...withoutVersion } =
        readReleasePlanFixture('pull-request-232') as Record<string, unknown>
    const result = readReleasePlanDocument(withoutVersion)

    check(
        'a document declaring no schemaVersion is rejected',
        !result.ok && result.reason.includes('Unsupported release-plan schemaVersion'),
        result.ok ? 'accepted a document with no schemaVersion' : result.reason,
    )
}

{
    const malformed = {
        ...(readReleasePlanFixture('pull-request-232') as Record<string, unknown>),
        summary: { packages: 12 },
    }
    const result = readReleasePlanDocument(malformed)

    check(
        'a schemaVersion 1 document with a broken body is rejected as malformed, not as a version problem',
        !result.ok && result.reason.startsWith('Malformed release-plan document'),
        result.ok ? 'accepted a malformed document' : result.reason,
    )
}

for (const notAPlan of [null, undefined, 42, 'plan', []]) {
    check(
        `${JSON.stringify(notAPlan) ?? 'undefined'} is rejected rather than read`,
        !readReleasePlanDocument(notAPlan).ok,
    )
}

// ── historical characterization ──────────────────────────────────────────────

/** What each case must show once mapped: the inventory it holds, and the authorization it refuses. */
const expectations: Record<
    ReleaseStateFixtureName,
    Pick<
        LegacyReleaseStateOutputs,
        | 'already_published_count'
        | 'pending_inventory_count'
        | 'should_skip'
        | 'should_version'
    >
> = {
    'pull-request-232': {
        already_published_count: 8,
        pending_inventory_count: 2,
        should_skip: true,
        should_version: false,
    },
    'pull-request-233': {
        already_published_count: 10,
        pending_inventory_count: 0,
        should_skip: false,
        should_version: true,
    },
    'pull-request-234': {
        already_published_count: 1,
        pending_inventory_count: 9,
        should_skip: true,
        should_version: false,
    },
}

for (const name of releaseStateFixtureNames) {
    const mapped = mapReleasePlanToLegacyOutputs(planOf(name))
    const legacy = legacyOf(name)
    const comparison = compareReleaseState(mapped, legacy)
    const expected = expectations[name]

    check(
        `${name}: every field expected to agree agrees`,
        comparison.divergent.length === 0,
        comparison.divergent
            .map((row) => `${row.field}: plan ${row.mapped} vs detector ${row.legacy}`)
            .join('\n        '),
    )

    for (const [field, value] of Object.entries(expected)) {
        const actual = mapped[field as keyof typeof expected]
        check(
            `${name}: ${field} maps to ${String(value)}`,
            actual === value,
            `got ${String(actual)}`,
        )
    }

    check(
        `${name}: pending inventory matches the detector's candidate list`,
        mapped.pending_inventory === legacy.publish_candidates,
        `plan "${mapped.pending_inventory}" vs detector "${String(legacy.publish_candidates)}"`,
    )

    // The safety property the whole slice exists to preserve: an observation reports inventory and authorizes nothing.
    check(
        `${name}: an observation authorizes no publication`,
        mapped.publish_candidate_count === 0 &&
            mapped.publish_candidates === '' &&
            !mapped.has_publish_candidates &&
            !mapped.should_publish,
        JSON.stringify({
            has_publish_candidates: mapped.has_publish_candidates,
            publish_candidate_count: mapped.publish_candidate_count,
            should_publish: mapped.should_publish,
        }),
    )
}

{
    // #233 is the case where the two derivations should agree completely: pending intent, nothing missing from the
    // registry, so nothing for the authorization difference to bite on.
    const comparison = compareReleaseState(
        mapReleasePlanToLegacyOutputs(planOf('pull-request-233')),
        legacyOf('pull-request-233'),
    )
    const disagreeing = comparison.rows.filter(
        (row) => !row.equal && row.policy !== 'unmapped',
    )

    check(
        'pull-request-233 is full parity outside the unmapped fields',
        disagreeing.length === 0,
        disagreeing.map((row) => `${row.field}: ${row.mapped} vs ${row.legacy}`).join(', '),
    )
}

for (const name of ['pull-request-232', 'pull-request-234'] as const) {
    const comparison = compareReleaseState(
        mapReleasePlanToLegacyOutputs(planOf(name)),
        legacyOf(name),
    )
    const disagreeing = comparison.rows
        .filter((row) => !row.equal && row.policy !== 'unmapped')
        .map((row) => row.field)
        .sort()

    check(
        `${name} differs only on the authorization axis`,
        JSON.stringify(disagreeing) ===
            JSON.stringify([
                'has_publish_candidates',
                'publish_candidate_count',
                'publish_candidates',
                'should_publish',
                'should_skip',
            ]),
        `differed on: ${disagreeing.join(', ')}`,
    )
}

// ── ledger and reporting ─────────────────────────────────────────────────────

{
    const mapped = mapReleasePlanToLegacyOutputs(planOf('pull-request-232'))

    check(
        'every mapped output is covered by the difference ledger',
        Object.keys(mapped).every((field) => field in RELEASE_STATE_FIELD_RULES) &&
            Object.keys(RELEASE_STATE_FIELD_RULES).every((field) => field in mapped),
    )

    check(
        'every unmapped field is reported as unmapped rather than as a value',
        (Object.keys(RELEASE_STATE_FIELD_RULES) as Array<keyof LegacyReleaseStateOutputs>)
            .filter((field) => RELEASE_STATE_FIELD_RULES[field].policy === 'unmapped')
            .every((field) => mapped[field] === null),
    )
}

{
    const plan = planOf('pull-request-234')
    const markdown = renderComparisonMarkdown(
        plan,
        compareReleaseState(mapReleasePlanToLegacyOutputs(plan), legacyOf('pull-request-234')),
    )

    // The plan section must be the Workspace renderer's own output, not a table this repository rebuilt: its headings
    // and its safety notes are what prove release truth was rendered from the canonical document.
    for (const marker of [
        '# Release plan',
        '## Registry inventory',
        '## Release intent and policy',
        'A missing exact version is inventory, not authorization',
    ]) {
        check(
            `the summary carries the Workspace renderer's "${marker}"`,
            markdown.includes(marker),
        )
    }

    check(
        'the summary states the declared differences',
        markdown.includes('## Declared differences') &&
            markdown.includes('publish_candidate_count'),
    )
    check(
        'the summary never claims a publish candidate from pending inventory',
        !markdown.includes('| `should_publish` | `true`'),
    )
}

if (failures > 0) {
    console.error(`\n${failures} workspace release-plan adapter self-test(s) failed.`)
    process.exit(1)
}

console.log('\nAll workspace release-plan adapter self-tests passed.')
