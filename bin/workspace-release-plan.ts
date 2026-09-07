/**
 * Adapter between the canonical `@snailicid3/workspace` release-plan contract and this repository's legacy
 * release-state outputs.
 *
 * Actions used to re-derive release truth in YAML and Bash. Workspace now owns that derivation and publishes it as a
 * versioned JSON document, so the job here is deliberately small: invoke the canonical producer, refuse a document
 * whose `schemaVersion` this adapter does not support, and *map* the result onto the output names existing callers
 * already consume. Nothing in this module recomputes registry state, release intent, per-package status, or publish
 * eligibility — every one of those is read from the plan.
 *
 * This module is not wired into the active release path. `call-detect-release-state.yml` remains the detector that
 * decides anything, and `call-compare-release-plan.yml` runs this adapter beside it in non-enforcing comparison mode.
 *
 * @see file://./../.github/workflows/call-compare-release-plan.yml
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
    createReleasePlan,
    getRepoRoot,
    observeWorkspaceChangesetIntent,
    observeWorkspaceRegistry,
    type ReleasePackagePlan,
    type ReleasePlan,
    releasePlanSchema,
    renderReleasePlanMarkdown,
    safeGetWorkspaceSnapshot,
} from '@snailicid3/workspace'

/**
 * The only release-plan schema this adapter can read.
 *
 * Declared as its own constant rather than inferred from the installed `@snailicid3/workspace` SemVer: the document
 * states its own version, and package SemVer is not a proxy for it.
 */
export const SUPPORTED_RELEASE_PLAN_SCHEMA_VERSION = 1

/**
 * Doctor is not run by this slice, so its facts are recorded as unknown rather than assumed valid.
 *
 * `unknown` is the honest value and the safe one: it can only ever hold a package back, never advance it.
 */
const OBSERVATION_DOCTOR_FACTS = {
    artifact: 'unknown',
    dependencyClosure: 'unknown',
} as const

/**
 * An observation selects no publish channel, so every package's policy is held.
 *
 * This is the property that keeps registry absence from reading as publish authorization: a package missing from the
 * registry becomes `pending_held` inventory, and `availableNextOperations` never gains `publish`.
 */
const OBSERVATION_PUBLISH_POLICY = {
    decision: 'held',
    reason: 'No publish operation selected',
} as const

/** The result of validating an externally received release-plan document. */
export type ReleasePlanDocumentResult =
    | { ok: false; reason: string }
    | { ok: true; plan: ReleasePlan }

/**
 * The legacy `call-detect-release-state.yml` output surface, as a mapped projection of the canonical plan.
 *
 * A `null` field is one `schemaVersion: 1` does not carry. It is left null rather than filled with a plausible value,
 * because a guessed number is indistinguishable from an observed one once it reaches a caller.
 */
export interface LegacyReleaseStateOutputs {
    already_published_count: number
    changeset_count: null | number
    changeset_slugs: null | string
    has_pending_changesets: boolean
    has_publish_candidates: boolean
    invalid_package_count: number
    lookup_failed_count: number
    new_package_count: null | number
    new_version_count: null | number
    package_count: number
    /**
     * Public packages whose exact version the registry reports as absent.
     *
     * This is inventory, not authorization. It is the quantity the legacy detector called `publish_candidate_count`,
     * carried under a name that cannot be mistaken for permission to publish.
     */
    pending_inventory: string
    pending_inventory_count: number
    primary_changeset_slug: null | string
    private_package_count: number
    public_package_count: number
    publish_candidate_count: number
    publish_candidates: string
    should_publish: boolean
    should_skip: boolean
    should_version: boolean
}

/** How one output name is expected to behave when the two derivations are compared. */
export type ReleaseStateFieldPolicy = 'intentional' | 'parity' | 'unmapped'

/** One field's declared expectation, and why it holds. */
export interface ReleaseStateFieldRule {
    policy: ReleaseStateFieldPolicy
    reason: string
}

/**
 * The difference ledger: what each output is expected to do, recorded before any comparison runs.
 *
 * Writing the expectations down first is what makes a dual run reviewable. Without it, every difference looks equally
 * like a bug, and the one difference that matters — that an observation refuses to authorize publication from registry
 * absence — reads as noise beside twelve accounting rows.
 */
export const RELEASE_STATE_FIELD_RULES: Record<
    keyof LegacyReleaseStateOutputs,
    ReleaseStateFieldRule
> = {
    already_published_count: {
        policy: 'parity',
        reason: 'Both count public packages whose exact version the registry reports as present.',
    },
    changeset_count: {
        policy: 'unmapped',
        reason: 'The plan records per-package release intent, not the pending changeset files it came from.',
    },
    changeset_slugs: {
        policy: 'unmapped',
        reason: 'Changeset filenames are a Changesets implementation detail the plan does not carry.',
    },
    has_pending_changesets: {
        policy: 'parity',
        reason: 'Pending intent is visible in the plan as a package whose intent source is changesets.',
    },
    has_publish_candidates: {
        policy: 'intentional',
        reason: 'Follows publish_candidate_count: an observation offers no publish operation, so it reports none.',
    },
    invalid_package_count: {
        policy: 'intentional',
        reason: 'A malformed name or version is rejected at the plan boundary, so no plan record can carry one and the mapped count is structurally zero.',
    },
    lookup_failed_count: {
        policy: 'parity',
        reason: 'Both count public packages whose registry lookup did not answer.',
    },
    new_package_count: {
        policy: 'unmapped',
        reason: 'The plan records whether an exact name@version exists, not whether the package name itself is new, so the legacy split cannot be reconstructed.',
    },
    new_version_count: {
        policy: 'unmapped',
        reason: 'Same as new_package_count: only the exact-version answer is recorded, and their sum is pending_inventory_count.',
    },
    package_count: {
        policy: 'parity',
        reason: 'Both count the repository’s packages; the plan uses the package manager’s workspace listing where the detector walks the filesystem, so a repository holding non-member manifests will differ here.',
    },
    pending_inventory: {
        policy: 'parity',
        reason: 'Compared against the legacy publish_candidates string: the same inventory, named so it cannot be read as authorization.',
    },
    pending_inventory_count: {
        policy: 'parity',
        reason: 'Compared against the legacy publish_candidate_count: the same inventory count, under a name that does not imply permission.',
    },
    primary_changeset_slug: {
        policy: 'unmapped',
        reason: 'Derived from changeset filenames, which the plan does not carry.',
    },
    private_package_count: {
        policy: 'parity',
        reason: 'Both count packages their manifest marks private.',
    },
    public_package_count: {
        policy: 'parity',
        reason: 'Both count packages their manifest does not mark private.',
    },
    publish_candidate_count: {
        policy: 'intentional',
        reason: 'The legacy detector treats registry absence as a publish candidate. The plan counts only packages that actually offer a publish operation, which an observation never does.',
    },
    publish_candidates: {
        policy: 'intentional',
        reason: 'Same as publish_candidate_count; the equivalent inventory is reported as pending_inventory.',
    },
    should_publish: {
        policy: 'intentional',
        reason: 'Follows publish_candidate_count, and additionally requires an execution that is not a read-only observation.',
    },
    should_skip: {
        policy: 'intentional',
        reason: 'Consequence of should_publish: with nothing to version and nothing authorized to publish, an observation of pending inventory reports skip where the detector reports a release.',
    },
    should_version: {
        policy: 'parity',
        reason: 'Both report that release intent is pending.',
    },
}

/** One field's outcome in a dual run. */
export interface ReleaseStateComparisonRow {
    equal: boolean
    field: keyof LegacyReleaseStateOutputs
    legacy: string
    mapped: string
    policy: ReleaseStateFieldPolicy
    reason: string
}

/** The whole dual run, split into what agreed, what was expected to differ, and what was not. */
export interface ReleaseStateComparison {
    /** Rows expected to agree that did not. These are the only rows a reviewer must act on. */
    divergent: ReleaseStateComparisonRow[]
    /** Rows that agreed, or that differed exactly where the ledger says they should. */
    expected: ReleaseStateComparisonRow[]
    rows: ReleaseStateComparisonRow[]
}

/** Recorded legacy detector output, as read from a fixture or from a live detector job. */
export type LegacyReleaseStateRecord = Partial<
    Record<keyof LegacyReleaseStateOutputs, unknown>
>

/**
 * Compare a mapped plan against legacy detector output, field by field, without deciding anything.
 *
 * The comparison is non-enforcing by construction: it returns rows. Whether a divergence should fail a job is a
 * caller's policy, and during this slice no caller makes it one.
 */
export function compareReleaseState(
    mapped: LegacyReleaseStateOutputs,
    legacy: LegacyReleaseStateRecord,
): ReleaseStateComparison {
    const rows = (
        Object.keys(RELEASE_STATE_FIELD_RULES) as Array<
            keyof LegacyReleaseStateOutputs
        >
    ).map((field): ReleaseStateComparisonRow => {
        const rule = RELEASE_STATE_FIELD_RULES[field]
        const mappedValue = mapped[field]
        const legacyValue = readLegacyField(legacy, field)

        return {
            equal: formatValue(mappedValue) === formatValue(legacyValue),
            field,
            legacy: formatValue(legacyValue),
            mapped: formatValue(mappedValue),
            policy: rule.policy,
            reason: rule.reason,
        }
    })

    return {
        divergent: rows.filter((row) => row.policy === 'parity' && !row.equal),
        expected: rows.filter((row) => row.policy !== 'parity' || row.equal),
        rows,
    }
}

/**
 * Map the canonical plan onto the legacy output names.
 *
 * Every value here is read or counted from the plan. The one place this function adds a name of its own is
 * `pending_inventory`, which exists precisely so the inventory the legacy detector called a publish candidate can be
 * compared without inheriting the word "candidate".
 */
export function mapReleasePlanToLegacyOutputs(
    plan: ReleasePlan,
): LegacyReleaseStateOutputs {
    const publicPackages = plan.packages.filter(
        (packagePlan) => !packagePlan.private,
    )
    const pendingInventory = publicPackages.filter(
        (packagePlan) => packagePlan.registry.state === 'missing',
    )
    const publishable = plan.packages.filter((packagePlan) =>
        packagePlan.availableNextOperations.includes('publish'),
    )
    const hasPublishCandidates =
        plan.execution.operation !== 'observe' && publishable.length > 0
    const shouldVersion = plan.packages.some(
        (packagePlan) => packagePlan.intent.source !== 'none',
    )

    return {
        already_published_count: plan.summary.published,
        changeset_count: null,
        changeset_slugs: null,
        has_pending_changesets: plan.packages.some(
            (packagePlan) => packagePlan.intent.source === 'changesets',
        ),
        has_publish_candidates: hasPublishCandidates,
        invalid_package_count: 0,
        lookup_failed_count: plan.summary.unknown,
        new_package_count: null,
        new_version_count: null,
        package_count: plan.summary.packages,
        pending_inventory: formatPackageList(pendingInventory),
        pending_inventory_count: pendingInventory.length,
        primary_changeset_slug: null,
        private_package_count: plan.summary.private,
        public_package_count: publicPackages.length,
        publish_candidate_count: hasPublishCandidates ? publishable.length : 0,
        publish_candidates: hasPublishCandidates
            ? formatPackageList(publishable)
            : '',
        should_publish: hasPublishCandidates,
        should_skip: !shouldVersion && !hasPublishCandidates,
        should_version: shouldVersion,
    }
}

/**
 * Produce the canonical release plan for a checked-out repository.
 *
 * Composition only: registry observation, release intent and plan composition all come from `@snailicid3/workspace`.
 * The per-package axes this function fills in itself are the two an observation has no business deciding — Doctor
 * facts it did not gather, and a publish policy it did not select — and both are set to the value that can only hold a
 * package back.
 */
export async function produceWorkspaceReleasePlan(
    repoRoot: string = getRepoRoot({ fallbackToCwd: true }),
): Promise<ReleasePlan> {
    const snapshot = safeGetWorkspaceSnapshot(repoRoot)

    if (!snapshot.success) {
        throw new Error(
            `Unable to read workspace packages from ${repoRoot}:\n${snapshot.error}`,
        )
    }

    const registry = new Map(
        observeWorkspaceRegistry({ repoRoot }).map((observation) => [
            observation.name,
            observation.registry,
        ]),
    )
    const intent = new Map(
        (await observeWorkspaceChangesetIntent({ repoRoot })).map(
            (observation) => [observation.name, observation],
        ),
    )

    return createReleasePlan({
        packages: snapshot.data.list.map((pkg) => {
            const access = readPublishAccess(repoRoot, pkg.path)
            const observedIntent = intent.get(pkg.name)

            return {
                ...(access === null ? {} : { access }),
                doctor: OBSERVATION_DOCTOR_FACTS,
                gitTag: { selected: false },
                intent: observedIntent?.intent ?? { source: 'none' },
                name: pkg.name,
                policy: OBSERVATION_PUBLISH_POLICY,
                private: pkg.private === true,
                registry: registry.get(pkg.name) ?? {
                    distTags: {},
                    registryUrl: null,
                    state: 'unknown_registry',
                },
                version: pkg.version,
                versionState: observedIntent?.versionState ?? {
                    state: 'current',
                },
            }
        }),
    })
}

/**
 * Validate an externally received release-plan document before a single field is read.
 *
 * Parsing is the version check. `releasePlanSchema` encodes `schemaVersion: 1` as a literal, so a document from a
 * future contract fails here rather than being partially understood — and the failure names the version it saw, so an
 * operator can tell "unsupported contract" from "malformed document".
 */
export function readReleasePlanDocument(
    document: unknown,
): ReleasePlanDocumentResult {
    const parsed = releasePlanSchema.safeParse(document)

    if (parsed.success) return { ok: true, plan: parsed.data }

    const declared = readDeclaredSchemaVersion(document)

    if (declared !== SUPPORTED_RELEASE_PLAN_SCHEMA_VERSION) {
        return {
            ok: false,
            reason: `Unsupported release-plan schemaVersion ${formatValue(declared)}; this adapter supports ${SUPPORTED_RELEASE_PLAN_SCHEMA_VERSION} only.`,
        }
    }

    return {
        ok: false,
        reason: `Malformed release-plan document: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
    }
}

/** Render the dual run as Markdown, with the canonical plan drawn by the Workspace renderer. */
export function renderComparisonMarkdown(
    plan: ReleasePlan,
    comparison: ReleaseStateComparison,
): string {
    // An unmapped field has nothing to agree or disagree about, so it is labelled rather than scored.
    const result = (row: ReleaseStateComparisonRow): string =>
        row.policy === 'unmapped' ? 'n/a' : row.equal ? 'same' : 'differs'

    const rowLine = (row: ReleaseStateComparisonRow): string =>
        `| \`${row.field}\` | \`${row.mapped}\` | \`${row.legacy}\` | ${result(row)} | ${row.policy} |`

    return [
        '# Release-state dual run (non-enforcing)',
        '',
        comparison.divergent.length === 0
            ? 'Every field expected to agree agreed. Remaining differences are the declared, intentional ones.'
            : `${comparison.divergent.length} field(s) expected to agree did not. This run reports them; it does not fail on them.`,
        '',
        '## Mapped outputs',
        '',
        '| Field | Canonical plan | Legacy detector | Result | Policy |',
        '|---|---|---|---|---|',
        ...comparison.rows.map(rowLine),
        '',
        '## Declared differences',
        '',
        ...comparison.rows
            .filter((row) => row.policy !== 'parity')
            .map((row) => `- \`${row.field}\` (${row.policy}): ${row.reason}`),
        ...(comparison.divergent.length === 0
            ? []
            : [
                  '',
                  '## Unexpected differences',
                  '',
                  ...comparison.divergent.map(
                      (row) =>
                          `- \`${row.field}\`: plan \`${row.mapped}\` vs detector \`${row.legacy}\`. ${row.reason}`,
                  ),
              ]),
        '',
        renderReleasePlanMarkdown(plan),
    ].join('\n')
}

/** `name@version`, space-delimited and name-ordered, matching the legacy string shape. */
function formatPackageList(
    packages: ReadonlyArray<ReleasePackagePlan>,
): string {
    return packages
        .map((packagePlan) => `${packagePlan.name}@${packagePlan.version}`)
        .sort()
        .join(' ')
}

/**
 * Render any recorded value as the string a workflow output would carry, so booleans and numbers compare alike.
 *
 * An unrecorded value and an empty one are rendered differently on purpose: "nothing was recorded" and "the list was
 * empty" are the difference between an unmapped field and a real answer of zero packages.
 */
function formatValue(value: unknown): string {
    if (value === null || value === undefined) return '(unmapped)'
    if (value === '') return '(empty)'

    return String(value)
}

/** Read one legacy field, treating an absent key as unrecorded rather than as an empty value. */
function readLegacyField(
    legacy: LegacyReleaseStateRecord,
    field: keyof LegacyReleaseStateOutputs,
): unknown {
    if (field === 'pending_inventory') return legacy.publish_candidates
    if (field === 'pending_inventory_count') {
        return legacy.publish_candidate_count
    }

    return legacy[field]
}

/** Pull `schemaVersion` off an unparsed document so a rejection can name what it saw. */
function readDeclaredSchemaVersion(document: unknown): unknown {
    if (typeof document !== 'object' || document === null) return undefined

    return (document as Record<string, unknown>).schemaVersion
}

/** Read `publishConfig.access` from a workspace member's manifest, or null when it declares none. */
function readPublishAccess(
    repoRoot: string,
    packagePath: string,
): 'public' | 'restricted' | null {
    try {
        const manifest: unknown = JSON.parse(
            readFileSync(join(repoRoot, packagePath, 'package.json'), 'utf8'),
        )
        const publishConfig = (manifest as Record<string, unknown>)
            .publishConfig
        const access = (publishConfig as Record<string, unknown> | undefined)
            ?.access

        return access === 'public' || access === 'restricted' ? access : null
    } catch {
        return null
    }
}
