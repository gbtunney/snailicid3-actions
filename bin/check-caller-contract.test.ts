/**
 * Self-test for {@link file://./check-caller-contract.ts}.
 *
 * A contract checker that never fails is worse than no checker at all, so every
 * rule gets a fixture that must trip it, and the baseline fixture proves the
 * rules stay quiet on a correct pair of workflows.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runContractCheck } from './check-caller-contract.js'

/** A correct reusable workflow: one optional secret, declared and read. */
const REUSABLE = `name: z Call Thing

on:
    workflow_call:
        secrets:
            GH_PAT:
                description: Optional token.
                required: false

        inputs:
            run_chromatic:
                required: false
                default: false
                type: boolean

permissions:
    contents: write

jobs:
    thing:
        runs-on: ubuntu-latest
        steps:
            - name: Use it
              run: echo "\${{ secrets.GH_PAT }}"
`

/** A correct consumer-side caller for {@link REUSABLE}. */
const CALLER = `name: Caller

on:
    workflow_dispatch:

permissions:
    contents: write

jobs:
    call:
        uses: gbtunney/snailicid3-actions/.github/workflows/call-thing.yml@v1
        secrets:
            GH_PAT: \${{ secrets.GH_PAT }}
`

/** One rule, expressed as the workflow pair that must trip it. */
interface ContractFixture {
    name: string
    reusable: string
    caller: string
    /** Substring the failure must mention, or null when the pair must pass. */
    expect: string | null
}

const fixtures: ContractFixture[] = [
    {
        name: 'baseline passes',
        reusable: REUSABLE,
        caller: CALLER,
        expect: null,
    },
    {
        name: 'blanket secrets: inherit is rejected',
        reusable: REUSABLE,
        caller: CALLER.replace(/ {8}secrets:\n.*\n/s, '        secrets: inherit\n'),
        expect: 'secrets: inherit',
    },
    {
        name: 'forwarding an undeclared secret is rejected',
        reusable: REUSABLE,
        caller: CALLER.replace(
            'GH_PAT: ${{ secrets.GH_PAT }}',
            'NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
        ),
        expect: 'does not declare',
    },
    {
        name: 'omitting a required secret is rejected',
        reusable: REUSABLE.replace('required: false', 'required: true'),
        caller: CALLER.replace(/ {8}secrets:\n {12}GH_PAT.*\n/, ''),
        expect: 'required by',
    },
    {
        name: 'reading an undeclared secret is rejected',
        reusable: REUSABLE.replace('secrets.GH_PAT', 'secrets.NPM_TOKEN'),
        caller: CALLER,
        expect: 'without declaring it',
    },
    {
        name: 'declaring an unread secret is rejected',
        reusable: REUSABLE.replace(
            '            GH_PAT:\n',
            '            NPM_TOKEN:\n                description: Unused.\n                required: false\n            GH_PAT:\n',
        ),
        caller: CALLER,
        expect: 'never reads it',
    },
    {
        /**
         * Documentation comments naming a secret are common in these files, so
         * a comment-blind scan would quietly retire the unread-secret rule.
         */
        name: 'a secret named only in a comment still counts as unread',
        reusable: REUSABLE.replace(
            'jobs:',
            '# Callers may set GH_PAT; it reaches steps as ${{ secrets.GH_PAT }}.\njobs:',
        ).replace('run: echo "${{ secrets.GH_PAT }}"', 'run: echo "nothing secret here"'),
        caller: CALLER,
        expect: 'never reads it',
    },
    {
        name: 'a trailing comment naming a secret does not count as a read',
        reusable: REUSABLE.replace(
            'run: echo "${{ secrets.GH_PAT }}"',
            'run: echo "nothing secret here" # not a use of ${{ secrets.GH_PAT }}',
        ),
        caller: CALLER,
        expect: 'never reads it',
    },
    {
        name: 'a consumer-side local workflow ref is rejected',
        reusable: REUSABLE,
        caller: CALLER.replace(
            'gbtunney/snailicid3-actions/.github/workflows/call-thing.yml@v1',
            './.github/workflows/call-thing.yml',
        ),
        expect: 'a consumer repository has no such file',
    },
    {
        name: 'run_chromatic without the token is rejected',
        reusable: REUSABLE.replace(
            '        secrets:\n            GH_PAT:',
            '        secrets:\n            CHROMATIC_PROJECT_TOKEN:\n                description: Chromatic.\n                required: false\n            GH_PAT:',
        ).replace('secrets.GH_PAT', 'secrets.GH_PAT }} ${{ secrets.CHROMATIC_PROJECT_TOKEN'),
        caller: CALLER.replace(
            '        secrets:',
            '        with:\n            run_chromatic: true\n        secrets:',
        ),
        expect: 'does not forward CHROMATIC_PROJECT_TOKEN',
    },
    {
        name: 'granting fewer permissions than the called workflow declares is rejected',
        reusable: REUSABLE,
        caller: CALLER.replace(
            'permissions:\n    contents: write',
            'permissions:\n    contents: read',
        ),
        expect: 'but call-thing.yml declares contents: write',
    },
]

/** Run one fixture in a throwaway directory and report whether it behaved. */
const runFixture = (fixture: ContractFixture): boolean => {
    const root = mkdtempSync(join(tmpdir(), 'caller-contract-'))

    try {
        mkdirSync(join(root, 'reusable'), { recursive: true })
        mkdirSync(join(root, 'callers'), { recursive: true })
        writeFileSync(join(root, 'reusable', 'call-thing.yml'), fixture.reusable)
        writeFileSync(join(root, 'callers', 'caller.yml'), fixture.caller)

        const { problems } = runContractCheck({
            reusableDirectory: join(root, 'reusable'),
            targets: [join(root, 'callers')],
            forceExternal: true,
        })

        const passed = fixture.expect
            ? problems.some((problem) => problem.includes(fixture.expect!))
            : problems.length === 0

        console.log(`${passed ? 'ok  ' : 'FAIL'}  ${fixture.name}`)
        if (!passed) {
            console.log(`        expected: ${fixture.expect ?? '(no problems)'}`)
            console.log(
                `        got: ${problems.length > 0 ? problems.join('\n             ') : '(no problems)'}`,
            )
        }

        return passed
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

const failures = fixtures.filter((fixture) => !runFixture(fixture))

if (failures.length > 0) {
    console.error(`\n${failures.length} contract-checker self-test(s) failed.`)
    process.exit(1)
}

console.log(`\nAll ${fixtures.length} contract-checker self-tests passed.`)
