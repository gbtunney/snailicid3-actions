import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(
    new URL('../templates/workflows/pr-checks.yml', import.meta.url),
)
const workflow = readFileSync(workflowPath, 'utf8')

const expectedGroup =
    'group: pr-${{ github.event.pull_request.number || github.ref_name }}'
const expectedCancellation =
    "cancel-in-progress: ${{ github.event_name == 'pull_request' && github.run_attempt == '1' }}"

/** Require the canonical caller to keep all attempts for one PR in the same scheduler group. */
function assertConcurrencyGroup(): void {
    if (!workflow.includes(expectedGroup)) {
        throw new Error(
            'PR Checks must keep the per-PR concurrency group so new head runs can supersede stale validation.',
        )
    }
}

/** Require only first-attempt PR runs to cancel work already running in that group. */
function assertCancellationPolicy(): void {
    if (!workflow.includes(expectedCancellation)) {
        throw new Error(
            'PR Checks must cancel stale work only for first-attempt pull_request runs; reruns must queue instead.',
        )
    }

    if (/^\s*cancel-in-progress:\s*true\s*$/mu.test(workflow)) {
        throw new Error(
            'PR Checks must not restore unconditional cancel-in-progress behavior.',
        )
    }
}

assertConcurrencyGroup()
assertCancellationPolicy()

console.log('PR concurrency policy preserves active checks across reruns.')
