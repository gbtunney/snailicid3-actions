// Self-test for bin/check-caller-contract.ts.
//
// A contract checker that never fails is worse than no checker at all, so
// every rule gets a fixture that must trip it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runContractCheck } from './check-caller-contract.ts'

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

interface TestCase {
    name: string
    reusable: string
    caller: string
    /** Substring the failure must mention, or null when the fixture must pass. */
    expect: string | null
}

const cases: TestCase[] = [
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
        caller: CALLER.replace('GH_PAT: ${{ secrets.GH_PAT }}', 'NPM_TOKEN: ${{ secrets.NPM_TOKEN }}'),
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
        caller: CALLER.replace('        secrets:', '        with:\n            run_chromatic: true\n        secrets:'),
        expect: 'does not forward CHROMATIC_PROJECT_TOKEN',
    },
    {
        name: 'granting fewer permissions than the called workflow declares is rejected',
        reusable: REUSABLE,
        caller: CALLER.replace('permissions:\n    contents: write', 'permissions:\n    contents: read'),
        expect: 'but call-thing.yml declares contents: write',
    },
]

let failures = 0

for (const testCase of cases) {
    const root = mkdtempSync(join(tmpdir(), 'caller-contract-'))
    try {
        mkdirSync(join(root, 'reusable'), { recursive: true })
        mkdirSync(join(root, 'callers'), { recursive: true })
        writeFileSync(join(root, 'reusable', 'call-thing.yml'), testCase.reusable)
        writeFileSync(join(root, 'callers', 'caller.yml'), testCase.caller)

        const { problems } = runContractCheck({
            reusableDir: join(root, 'reusable'),
            targets: [join(root, 'callers')],
            forceExternal: true,
        })

        const ok = testCase.expect
            ? problems.some((problem) => problem.includes(testCase.expect!))
            : problems.length === 0

        console.log(`${ok ? 'ok  ' : 'FAIL'}  ${testCase.name}`)
        if (!ok) {
            failures++
            console.log(`        expected: ${testCase.expect ?? '(no problems)'}`)
            console.log(`        got: ${problems.length ? problems.join('\n        ') : '(no problems)'}`)
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

if (failures > 0) {
    console.error(`\n${failures} contract-checker self-test(s) failed.`)
    process.exit(1)
}

console.log(`\nAll ${cases.length} contract-checker self-tests passed.`)
