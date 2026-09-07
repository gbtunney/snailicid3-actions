/**
 * Adapter between the canonical `@snailicid3/workspace` release-plan contract and this repository's release workflows.
 *
 * Actions used to re-derive release truth in YAML and Bash. Workspace owns that derivation and publishes it as a
 * versioned JSON document, so the job here is deliberately small: invoke the canonical producer, refuse a document
 * whose `schemaVersion` this adapter does not support, and map the result onto the output names existing callers
 * already consume. Nothing in this module recomputes registry state, release intent, per-package status, or publish
 * eligibility — every one of those is read from the plan.
 *
 * This is the only source of release phase selection. The detector that preceded it (`call-detect-release-state.yml`)
 * survives for exactly one reason: it owns the pending-changeset filenames that `schemaVersion: 1` does not carry, and
 * `call-release-plan.yml` still needs them to name a version branch. It no longer decides anything.
 *
 * What `schemaVersion: 1` does not carry, and therefore never appears here: `changeset_count`, `changeset_slugs` and
 * `primary_changeset_slug` (Changesets filenames), and the split between `new_package_count` and `new_version_count`
 * (the plan records whether an exact `name@version` exists, not whether the package name itself is new). Those stay
 * detector-derived and are reported as such rather than approximated from the plan.
 *
 * @see file://./../.github/workflows/call-release-plan.yml
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
 * The release-state values `call-release-plan.yml` surfaces, mapped from the canonical plan.
 *
 * Every field here is read or counted from the plan and is surfaced as a workflow output. Fields that were only ever
 * needed to compare this mapping against the detector are gone: they had no consumer once the canonical plan became
 * the active source, and an output nothing reads is a claim nothing checks.
 */
export interface ReleaseStateOutputs {
    /**
     * Public packages whose exact version the registry reports as absent, as `name@version`.
     *
     * This is inventory, not authorization. It is the quantity the retired detector called `publish_candidates`,
     * carried under a name that cannot be mistaken for permission to publish, and surfaced under the original name for
     * callers that still read it.
     */
    pending_inventory: string
    pending_inventory_count: number
    /**
     * True only when the plan actually offers a publish operation.
     *
     * False for every read-only observation, whatever the registry is missing. Callers that want "there is something
     * to release" want `pending_inventory_count`.
     */
    should_publish: boolean
    should_version: boolean
}

/**
 * The phases `call-release-plan.yml` selects between.
 *
 * A phase names what a ref *looks like*, never what may be done to it. `pending_release` in particular says the
 * registry is missing package versions this workspace holds — inventory — and says nothing about permission to publish
 * them. Authorization stays where it already was: an explicit non-dry-run invocation that clears `guard_real_release`.
 */
export type ReleasePhase = 'main' | 'pending_changeset' | 'pending_release'

export interface ReleasePhaseSelection {
    phase: ReleasePhase
    /**
     * Whether the plan offers a publish operation at all.
     *
     * Read straight from the mapped plan, and false for every observation. It is reported beside the phase so a reader
     * can see that reaching `pending_release` did not grant anything.
     */
    publishAuthorized: boolean
    reason: string
}

/** Map the canonical plan onto the release-state values the workflow surfaces. */
export function mapReleasePlanToOutputs(plan: ReleasePlan): ReleaseStateOutputs {
    const pendingInventory = plan.packages.filter(
        (packagePlan) =>
            !packagePlan.private && packagePlan.registry.state === 'missing',
    )
    const publishable = plan.packages.filter((packagePlan) =>
        packagePlan.availableNextOperations.includes('publish'),
    )

    return {
        pending_inventory: formatPackageList(pendingInventory),
        pending_inventory_count: pendingInventory.length,
        should_publish:
            plan.execution.operation !== 'observe' && publishable.length > 0,
        should_version: plan.packages.some(
            (packagePlan) => packagePlan.intent.source !== 'none',
        ),
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
            reason: `Unsupported release-plan schemaVersion ${String(declared)}; this adapter supports ${SUPPORTED_RELEASE_PLAN_SCHEMA_VERSION} only.`,
        }
    }

    return {
        ok: false,
        reason: `Malformed release-plan document: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
    }
}

/** Render the selected phase and the plan it came from, with the plan drawn by the Workspace renderer. */
export function renderReleasePlanReportMarkdown(
    plan: ReleasePlan,
    selection: ReleasePhaseSelection,
): string {
    return [
        '# Release phase',
        '',
        `- **Phase:** \`${selection.phase}\``,
        `- **Publish authorized by the plan:** \`${selection.publishAuthorized}\``,
        '',
        selection.reason,
        '',
        'Reaching `pending_release` is not permission to publish. It reports that the registry is missing package',
        'versions this workspace holds; publication still requires an explicit non-dry-run invocation that clears the',
        'real-release guard.',
        '',
        renderReleasePlanMarkdown(plan),
    ].join('\n')
}

/**
 * Select the release phase from the canonical plan's mapped outputs.
 *
 * Every input is a value the plan recorded; nothing here re-derives release eligibility. Order encodes precedence and
 * matches the rule the retired detector used, with one deliberate difference: the second branch tests *inventory*
 * (`pending_inventory_count`) rather than the detector's `publish_candidate_count`, because the canonical plan reports
 * a missing exact version as held inventory and offers no publish operation for it. Selecting the phase from
 * authorization instead would make `pending_release` unreachable and silently strand the manual release path.
 */
export function selectReleasePhase(
    mapped: ReleaseStateOutputs,
): ReleasePhaseSelection {
    const publishAuthorized = mapped.should_publish

    if (mapped.should_version) {
        return {
            phase: 'pending_changeset',
            publishAuthorized,
            reason: 'The plan records pending release intent for at least one package.',
        }
    }

    if (mapped.pending_inventory_count > 0) {
        return {
            phase: 'pending_release',
            publishAuthorized,
            reason: `${mapped.pending_inventory_count} package version(s) are absent from the registry. That is inventory: publication still requires an explicitly selected operation.`,
        }
    }

    return {
        phase: 'main',
        publishAuthorized,
        reason: 'The plan records no pending release intent and no absent package versions.',
    }
}

/** `name@version`, space-delimited and name-ordered, matching the string shape callers already read. */
function formatPackageList(
    packages: ReadonlyArray<ReleasePackagePlan>,
): string {
    return packages
        .map((packagePlan) => `${packagePlan.name}@${packagePlan.version}`)
        .sort()
        .join(' ')
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
