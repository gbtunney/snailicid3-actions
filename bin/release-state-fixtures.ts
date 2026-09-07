/**
 * The historical release-state cases the adapter is characterized against.
 *
 * `test-fixtures/release-plan/<case>.json` holds the canonical `@snailicid3/workspace` release plan recorded at that
 * pull request's head commit, copied verbatim from the frozen documents in `gbtunney/snailicid3`
 * (`packages/workspace/test-fixtures/release-plan`). They are copied rather than imported because the published
 * package ships only `dist` and `types`; its test fixtures are not part of the npm artifact. Copies must stay
 * byte-identical to the upstream documents.
 *
 * The recorded detector outputs that sat beside these during the migration are gone. They existed to prove the
 * canonical mapping reached the detector's own answers before the cutover; the detector no longer decides anything, so
 * what remains worth asserting is that these documents still select the phases those commits are known to have
 * produced, which the self-test states directly.
 *
 * The three cases, from `gbtunney/snailicid3`:
 *
 * - `pull-request-232` (head `a7093c8`): no pending changesets, and `storybook-config@0.1.0` and `workspace@0.1.0`
 *   were the two exact versions absent from npm.
 * - `pull-request-233` (head `e78f39e`): the `whole-banks-swim` changeset was pending, yet every public exact version
 *   already existed on npm, so intent alone produced no inventory.
 * - `pull-request-234` (head `ddf77e3`): that changeset had been consumed and its versions applied, leaving nine
 *   public exact versions absent from npm.
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

/** Read one frozen canonical plan document as `unknown`, so it must be validated before it is read. */
export function readReleasePlanFixture(name: ReleaseStateFixtureName): unknown {
    return readJson(
        join(REPO_ROOT, 'test-fixtures', 'release-plan', `${name}.json`),
    )
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'))
}
