/**
 * Self-test for {@link file://./workspace-release-plan.ts}.
 *
 * Two things are worth proving about the adapter now that it is the only source of release phase selection. The first
 * is that it refuses a document it does not understand *before* it reads a field, because a version check that runs
 * after the mapping is not a version check. The second is that it reproduces the historical release-state cases — the
 * same phase the retired detector reached at those commits, without ever turning a missing registry version into
 * permission to publish it.
 *
 * The comparison against recorded detector output is gone with the detector's decision-making role. What it proved —
 * that the canonical mapping reaches the detector's own answers — is now asserted directly against the phases those
 * commits are known to have produced.
 */

import {
    mapReleasePlanToOutputs,
    type ReleasePhase,
    readReleasePlanDocument,
    renderReleasePlanReportMarkdown,
    selectReleasePhase,
} from './workspace-release-plan.js'
import {
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

/**
 * What each recorded commit must produce.
 *
 * `phase` is the phase the detector actually reached at that commit, so these assertions are what keeps the retirement
 * honest: the canonical path must still land on the same answer now that nothing runs beside it. `inventory` is the
 * count of exact versions the registry did not have there.
 */
const expectations: Record<
    ReleaseStateFixtureName,
    { inventory: number; phase: ReleasePhase }
> = {
    'pull-request-232': { inventory: 2, phase: 'pending_release' },
    'pull-request-233': { inventory: 0, phase: 'pending_changeset' },
    'pull-request-234': { inventory: 9, phase: 'pending_release' },
}

for (const name of releaseStateFixtureNames) {
    const plan = planOf(name)
    const mapped = mapReleasePlanToOutputs(plan)
    const selection = selectReleasePhase(mapped)
    const expected = expectations[name]

    check(
        `${name}: selects ${expected.phase}`,
        selection.phase === expected.phase,
        `got ${selection.phase} (${selection.reason})`,
    )

    check(
        `${name}: reports ${expected.inventory} package version(s) absent from the registry`,
        mapped.pending_inventory_count === expected.inventory,
        `got ${mapped.pending_inventory_count}`,
    )

    // The property the whole migration turns on: reaching any phase grants nothing.
    check(
        `${name}: the plan authorizes no publication whatever phase is selected`,
        !selection.publishAuthorized && !mapped.should_publish,
        JSON.stringify({
            publishAuthorized: selection.publishAuthorized,
            should_publish: mapped.should_publish,
        }),
    )

    // pending_inventory_count drives phase selection, so prove it stays the same set the plan's own statuses describe
    // rather than drifting into a second notion of "pending".
    check(
        `${name}: pending inventory equals the plan's own pending statuses`,
        mapped.pending_inventory_count ===
            plan.summary.eligible + plan.summary.held + plan.summary.blocked,
        `${mapped.pending_inventory_count} vs ${plan.summary.eligible + plan.summary.held + plan.summary.blocked}`,
    )
}

for (const name of ['pull-request-232', 'pull-request-234'] as const) {
    const mapped = mapReleasePlanToOutputs(planOf(name))
    const selection = selectReleasePhase(mapped)

    // #232 and #234 are the cases where exact versions are missing from the registry. Selecting pending_release from
    // that inventory must not turn into permission to publish it.
    check(
        `${name}: missing registry versions are inventory, not authorization`,
        selection.phase === 'pending_release' &&
            mapped.pending_inventory_count > 0 &&
            !selection.publishAuthorized,
        JSON.stringify({
            pending_inventory_count: mapped.pending_inventory_count,
            phase: selection.phase,
            publishAuthorized: selection.publishAuthorized,
        }),
    )

    // The inventory the manual release path tags and publishes is the exact list those commits produced.
    check(
        `${name}: names every absent version as name@version`,
        mapped.pending_inventory.split(' ').length === mapped.pending_inventory_count &&
            mapped.pending_inventory.split(' ').every((entry) => /.+@\d+\.\d+\.\d+$/.test(entry)),
        mapped.pending_inventory,
    )
}

{
    // A workspace with nothing pending and nothing missing takes the no-action path.
    const plan = planOf('pull-request-233')
    const mapped = mapReleasePlanToOutputs(plan)

    check(
        'a workspace with pending intent never reports absent inventory as the reason',
        mapped.should_version && mapped.pending_inventory_count === 0,
        JSON.stringify(mapped),
    )
}

// ── reporting ────────────────────────────────────────────────────────────────

{
    const plan = planOf('pull-request-234')
    const markdown = renderReleasePlanReportMarkdown(
        plan,
        selectReleasePhase(mapReleasePlanToOutputs(plan)),
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
            `the report carries the Workspace renderer's "${marker}"`,
            markdown.includes(marker),
        )
    }

    check(
        'the report states the phase and withholds authorization',
        markdown.includes('**Phase:** `pending_release`') &&
            markdown.includes('**Publish authorized by the plan:** `false`') &&
            markdown.includes('not permission to publish'),
        markdown.slice(0, 500),
    )
}

if (failures > 0) {
    console.error(`\n${failures} workspace release-plan adapter self-test(s) failed.`)
    process.exit(1)
}

console.log('\nAll workspace release-plan adapter self-tests passed.')
