/**
 * The historical release-state cases this adapter is characterized against.
 *
 * Two documents per case, recorded at the same head commit:
 *
 * - `test-fixtures/release-plan/<case>.json` — the canonical `@snailicid3/workspace` release plan, copied verbatim from
 *   the frozen documents in `gbtunney/snailicid3` (`packages/workspace/test-fixtures/release-plan`). They are copied
 *   rather than imported because the published package ships only `dist` and `types`; its test fixtures are not part of
 *   the npm artifact. Copies must stay byte-identical to the upstream documents.
 *
 * - `test-fixtures/legacy-release-state/<case>.json` — what this repository's detector reports for the same facts.
 *
 * The legacy documents are reconstructions, not captures of a historical workflow run, and they are deliberately scoped
 * to the twelve canonical workspace members the plan records. That scoping is what makes the comparison about
 * *classification* rather than about discovery: the detector's filesystem walk also finds the repository root manifest
 * and any nested non-member manifests, which would otherwise swamp every count with a difference that has nothing to do
 * with release semantics. Discovery is compared live instead, against a real detector run, by
 * `.github/workflows/call-compare-release-plan.yml`.
 *
 * `new_package_count` and `new_version_count` are recorded as `null` on every case. The detector distinguishes "this
 * package name is not on npm at all" from "the name exists but this version is new"; the canonical plan records only
 * whether the exact `name@version` exists. The historical split was never captured anywhere this repository can read,
 * so recording a number would be inventing one. Their sum is `publish_candidate_count`.
 *
 * The three cases, from `gbtunney/snailicid3`:
 *
 * - `pull-request-232` (head `a7093c8`): no pending changesets, and `storybook-config@0.1.0` and `workspace@0.1.0` were
 *   the two exact versions absent from npm. The detector reads that absence as two publish candidates.
 * - `pull-request-233` (head `e78f39e`): the `whole-banks-swim` changeset was pending, yet every public exact version
 *   already existed on npm, so intent alone produced no candidates.
 * - `pull-request-234` (head `ddf77e3`): that changeset had been consumed and its versions applied, leaving nine public
 *   exact versions absent from npm.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file so the fixtures load from any working directory. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const releaseStateFixtureNames = [
    'pull-request-232',
    'pull-request-233',
    'pull-request-234',
] as const

export type ReleaseStateFixtureName = (typeof releaseStateFixtureNames)[number]

/**
 * Read one recorded detector output.
 *
 * Typed as `unknown` for the same reason the plan fixture is: it stands in for a value arriving from a workflow, and a
 * reader has to earn its types rather than assert them.
 */
export function readLegacyReleaseStateFixture(
    name: ReleaseStateFixtureName,
): unknown {
    return readJson(
        join(REPO_ROOT, 'test-fixtures', 'legacy-release-state', `${name}.json`),
    )
}

/** Read one frozen canonical plan document as `unknown`, so it must be validated before it is read. */
export function readReleasePlanFixture(name: ReleaseStateFixtureName): unknown {
    return readJson(
        join(REPO_ROOT, 'test-fixtures', 'release-plan', `${name}.json`),
    )
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'))
}
