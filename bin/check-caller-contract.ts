/**
 * Validate the caller ⇄ reusable-workflow contract.
 *
 * A cross-repository caller that gets this contract wrong does not fail a job:
 * GitHub refuses to start the run at all ("startup_failure", zero jobs), which
 * is invisible to any same-repository self-test. Checking it statically is the
 * only way to catch the mistake before a consumer does.
 *
 * @example
 * ```sh
 * pnpm check:callers [--reusable <dir>] [--external] [<path> ...]
 * ```
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

/** Repository that owns the reusable workflows, as consumers reference it. */
export const SOURCE_REPO = 'gbtunney/snailicid3-actions'

/** Ordering for GitHub permission levels, so a caller's grant can be compared. */
const PERMISSION_LEVELS: Record<string, number> = { none: 0, read: 1, write: 2 }

const BLOCK_SCALAR_VALUE = /^[|>][+-]?\d*(\s+#.*)?$/
const MAPPING_KEY_LINE = /^(["']?)([A-Za-z0-9_.$-][^:'"]*)\1:(?:\s+(.*))?$/
const SECRET_REFERENCE = /secrets\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Chromatic project tokens are per-project and named, so the rule below finds
 * them from what the called workflow declares rather than hard-coding a list
 * that would drift every time a Storybook project is added.
 */
const CHROMATIC_TOKEN = /^CHROMATIC_PROJECT_TOKEN_[A-Z0-9_]+$/

/** Step policies `chromatic_mode` accepts; anything else fails the job at runtime. */
const CHROMATIC_MODES = new Set(['skip', 'report', 'abort_on_error'])

/**
 * One mapping key found in a workflow file.
 *
 * Workflow files are uniformly indented mappings, so tracking indentation is
 * enough to answer the handful of structural questions the contract depends on.
 * That keeps the check dependency-free, so it can run before any install step.
 */
interface WorkflowNode {
    /** Leading-space count, which is what establishes parent/child nesting. */
    indent: number
    /** The mapping key itself, unquoted. */
    key: string
    /** Inline scalar after the colon; empty when the value is a nested block. */
    value: string
    /** One-based line number, for pointing a reviewer at the right place. */
    line: number
}

/** A {@link WorkflowNode} plus its position in the flat node list. */
interface IndexedWorkflowNode extends WorkflowNode {
    index: number
}

/**
 * Remove YAML comments so they cannot be mistaken for workflow content.
 *
 * Without this, a line documenting a secret — `# reads ${{ secrets.GH_PAT }}` —
 * makes the secret look consumed, and the "declared but never read" rule
 * silently stops working. Comments explaining secrets are common in these
 * files, so the false negative is the likely case rather than the exotic one.
 *
 * A `#` only opens a comment at the start of a line or after whitespace, and
 * never inside quotes, which also leaves shell constructs such as `${#array}`
 * inside `run:` blocks intact.
 */
export const stripComments = (text: string): string =>
    text
        .split(/\r?\n/)
        .map((rawLine) => {
            if (rawLine.trimStart().startsWith('#')) return ''

            let quote: string | null = null
            let previous = ''

            for (const [position, character] of [...rawLine].entries()) {
                if (quote) {
                    if (character === quote) quote = null
                } else if (character === '"' || character === "'") {
                    quote = character
                } else if (character === '#' && (position === 0 || /\s/.test(previous))) {
                    return rawLine.slice(0, position)
                }
                previous = character
            }

            return rawLine
        })
        .join('\n')

/** Flatten a workflow file into its mapping keys, skipping comments and block scalars. */
const parseWorkflowNodes = (text: string): WorkflowNode[] => {
    const nodes: WorkflowNode[] = []
    let blockScalarIndent: number | null = null

    text.split(/\r?\n/).forEach((rawLine, offset) => {
        const trimmed = rawLine.trim()
        const indent = rawLine.length - rawLine.trimStart().length

        if (blockScalarIndent !== null) {
            if (trimmed === '' || indent > blockScalarIndent) return
            blockScalarIndent = null
        }
        if (trimmed === '' || trimmed.startsWith('#')) return

        /**
         * Sequence entries are opaque here, but a block scalar opened inside
         * one still has to be skipped over.
         */
        const body = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
        const keyMatch = MAPPING_KEY_LINE.exec(body)
        if (!keyMatch) return

        const value = (keyMatch[3] ?? '').trim()
        if (BLOCK_SCALAR_VALUE.test(value)) blockScalarIndent = indent

        if (trimmed.startsWith('- ')) return
        nodes.push({ indent, key: keyMatch[2]!.trim(), value, line: offset + 1 })
    })

    return nodes
}

/** Keys nested directly under `nodes[parentIndex]`, ignoring deeper levels. */
const directChildren = (nodes: WorkflowNode[], parentIndex: number): IndexedWorkflowNode[] => {
    if (parentIndex < 0) return []

    const parent = nodes[parentIndex]!
    const children: IndexedWorkflowNode[] = []
    let childIndent: number | null = null

    for (const [offset, node] of nodes.slice(parentIndex + 1).entries()) {
        if (node.indent <= parent.indent) break
        if (childIndent === null) childIndent = node.indent
        if (node.indent === childIndent) children.push({ ...node, index: parentIndex + 1 + offset })
    }

    return children
}

/** Index of the child named `key`, or -1 when absent. */
const childIndex = (nodes: WorkflowNode[], parentIndex: number, key: string): number =>
    directChildren(nodes, parentIndex).find((node) => node.key === key)?.index ?? -1

/** Index of the top-level key named `key`, or -1 when absent. */
const topLevelIndex = (nodes: WorkflowNode[], key: string): number =>
    nodes.findIndex((node) => node.indent === 0 && node.key === key)

/** Read a `permissions:` block into scope → level, or null when there is none. */
const readPermissions = (
    nodes: WorkflowNode[],
    permissionsIndex: number,
): Record<string, string> | null => {
    if (permissionsIndex < 0) return null

    const permissions: Record<string, string> = {}
    for (const scope of directChildren(nodes, permissionsIndex)) permissions[scope.key] = scope.value
    return permissions
}

/** A secret declared under `on.workflow_call.secrets`. */
interface DeclaredSecret {
    required: boolean
}

/** A job that calls another workflow, and the contract it passes along. */
interface CallerJob {
    id: string
    line: number
    /** Raw `uses:` value, or null for a normal `runs-on` job. */
    uses: string | null
    usesLine: number
    /** True when the job forwards everything via `secrets: inherit`. */
    inheritsSecrets: boolean
    /** Secret names forwarded by name, or null when no `secrets:` block exists. */
    forwarded: string[] | null
    /** Literal `with:` values, used to spot inputs that imply a secret. */
    inputs: Record<string, string>
    /** Job-level permissions, which replace the workflow-level block entirely. */
    permissions: Record<string, string> | null
}

/** Everything the contract check needs to know about one workflow file. */
export interface Workflow {
    path: string
    declared: Map<string, DeclaredSecret>
    /** Secrets actually referenced in workflow content, comments excluded. */
    referenced: Set<string>
    jobs: CallerJob[]
    permissions: Record<string, string> | null
}

/** Read one workflow file into the model the contract rules run against. */
export const loadWorkflow = (path: string): Workflow => {
    const text = readFileSync(path, 'utf8')
    const nodes = parseWorkflowNodes(text)

    const workflowCallIndex = childIndex(nodes, topLevelIndex(nodes, 'on'), 'workflow_call')
    const declaredIndex = childIndex(nodes, workflowCallIndex, 'secrets')
    const declared = new Map<string, DeclaredSecret>()

    for (const secret of directChildren(nodes, declaredIndex)) {
        const required = directChildren(nodes, secret.index).find((node) => node.key === 'required')
        declared.set(secret.key, { required: required?.value === 'true' })
    }

    const referenced = new Set(
        [...stripComments(text).matchAll(SECRET_REFERENCE)].map(
            (reference) => reference.groups!['name']!,
        ),
    )

    const jobs = directChildren(nodes, topLevelIndex(nodes, 'jobs')).map((job): CallerJob => {
        const uses = directChildren(nodes, job.index).find((node) => node.key === 'uses')
        const forwardedIndex = childIndex(nodes, job.index, 'secrets')
        const inputs: Record<string, string> = {}
        for (const input of directChildren(nodes, childIndex(nodes, job.index, 'with'))) {
            inputs[input.key] = input.value
        }

        return {
            id: job.key,
            line: job.line,
            uses: uses?.value ?? null,
            usesLine: uses?.line ?? job.line,
            inheritsSecrets: nodes[forwardedIndex]?.value === 'inherit',
            forwarded:
                forwardedIndex < 0
                    ? null
                    : directChildren(nodes, forwardedIndex).map((secret) => secret.key),
            inputs,
            permissions: readPermissions(nodes, childIndex(nodes, job.index, 'permissions')),
        }
    })

    return {
        path,
        declared,
        referenced,
        jobs,
        permissions: readPermissions(nodes, topLevelIndex(nodes, 'permissions')),
    }
}

/** A reusable workflow in {@link SOURCE_REPO} that a caller job points at. */
interface CallTarget {
    /** Bare filename, e.g. `call-pipeline.yml`. */
    file: string
    /** True for `<owner>/<repo>/...@<ref>`, which is what consumers must use. */
    qualified: boolean
}

/** Resolve a `uses:` value to one of this repository's reusable workflows. */
const resolveTarget = (uses: string | null): CallTarget | null => {
    if (!uses) return null

    const local = /^[.$]\/\.github\/workflows\/(?<file>[^@\s]+)$/.exec(uses)
    if (local?.groups) return { file: local.groups['file']!, qualified: false }

    const remote =
        /^(?<repo>[^/]+\/[^/]+)\/\.github\/workflows\/(?<file>[^@\s]+)@(?<ref>\S+)$/.exec(uses)
    if (remote?.groups && remote.groups['repo'] === SOURCE_REPO) {
        return { file: remote.groups['file']!, qualified: true }
    }

    return null
}

/** Reports a contract violation at a given line. */
type Reporter = (line: number, message: string) => void

/**
 * Check a reusable workflow's own secret declarations.
 *
 * Declared-but-unread means the contract advertises something callers are
 * expected to supply for no reason; read-but-undeclared means a caller cannot
 * supply it at all, because GitHub rejects secrets the callee never declared.
 */
const checkReusableWorkflow = (workflow: Workflow, fail: Reporter): void => {
    for (const secret of workflow.declared.keys()) {
        if (!workflow.referenced.has(secret)) {
            fail(1, `declares secret ${secret} but never reads it — drop the declaration or use it`)
        }
    }

    for (const secret of workflow.referenced) {
        if (secret === 'GITHUB_TOKEN') continue
        if (!workflow.declared.has(secret)) {
            fail(1, `reads secrets.${secret} without declaring it under on.workflow_call.secrets`)
        }
    }
}

/**
 * Check a job's Chromatic wiring against the tokens the callee declares.
 *
 * A caller that turns Chromatic on without forwarding any project token gets a
 * job failure deep into a pipeline run, long after build and test have spent
 * their minutes. Expression values cannot be resolved statically, so only
 * literal modes are judged.
 */
const checkChromaticContract = (job: CallerJob, called: Workflow, fail: Reporter): void => {
    const mode = job.inputs['chromatic_mode']
    if (mode === undefined || mode.startsWith('${{')) return

    if (!CHROMATIC_MODES.has(mode)) {
        fail(
            job.line,
            `job "${job.id}" sets chromatic_mode: ${mode}, which is not one of ${[...CHROMATIC_MODES].join(', ')}`,
        )
        return
    }

    if (mode === 'skip') return

    const projectTokens = [...called.declared.keys()].filter((secret) => CHROMATIC_TOKEN.test(secret))
    if (projectTokens.length === 0) return

    if (!forwardsAnyOf(job, projectTokens)) {
        fail(
            job.line,
            `job "${job.id}" sets chromatic_mode: ${mode} but forwards none of ${projectTokens.join(', ')}`,
        )
    }
}

/** True when the job forwards at least one of the given secret names. */
const forwardsAnyOf = (job: CallerJob, secrets: string[]): boolean =>
    (job.forwarded ?? []).some((forwarded) => secrets.includes(forwarded))

/** Check every job in a caller against the workflow it invokes. */
const checkCallerWorkflow = (
    workflow: Workflow,
    context: { external: boolean; reusable: Map<string, Workflow> },
    fail: Reporter,
    warn: Reporter,
): void => {
    for (const job of workflow.jobs) {
        if (job.inheritsSecrets) {
            fail(
                job.line,
                `job "${job.id}" uses secrets: inherit — forward the secrets the called workflow declares by name instead`,
            )
        }

        const target = resolveTarget(job.uses)
        if (!target) continue

        if (context.external && !target.qualified) {
            fail(
                job.usesLine,
                `job "${job.id}" references ${job.uses} — a consumer repository has no such file; use ${SOURCE_REPO}/.github/workflows/...@<ref>`,
            )
            continue
        }

        const called = context.reusable.get(target.file)
        if (!called) {
            fail(job.usesLine, `job "${job.id}" calls unknown workflow ${target.file}`)
            continue
        }

        const forwarded = job.forwarded ?? []

        for (const secret of forwarded) {
            if (!called.declared.has(secret)) {
                fail(
                    job.line,
                    `job "${job.id}" forwards ${secret}, which ${target.file} does not declare`,
                )
            }
        }

        for (const [secret, declaration] of called.declared) {
            if (declaration.required && !forwarded.includes(secret)) {
                fail(job.line, `job "${job.id}" omits ${secret}, required by ${target.file}`)
            }
        }

        checkChromaticContract(job, called, fail)

        /** A job-level block replaces the workflow-level one rather than merging. */
        const granted = job.permissions ?? workflow.permissions
        if (!called.permissions) continue

        if (!granted) {
            warn(
                job.line,
                `job "${job.id}" declares no permissions; ${target.file} needs ${JSON.stringify(called.permissions)}`,
            )
            continue
        }

        for (const [scope, level] of Object.entries(called.permissions)) {
            const grantedLevel = PERMISSION_LEVELS[granted[scope] ?? ''] ?? -1
            const requiredLevel = PERMISSION_LEVELS[level] ?? 0
            if (grantedLevel < requiredLevel) {
                fail(
                    job.line,
                    `job "${job.id}" grants ${scope}: ${granted[scope] ?? 'nothing'} but ${target.file} declares ${scope}: ${level}`,
                )
            }
        }
    }
}

/** Expand a path to the workflow files it holds, or to itself when it is a file. */
const expandPath = (path: string): string[] =>
    statSync(path).isDirectory()
        ? readdirSync(path)
              .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
              .sort()
              .map((file) => join(path, file))
        : [path]

/** Options accepted by {@link runContractCheck} and the CLI. */
export interface ContractCheckOptions {
    /** Directory holding this repository's `call-*.yml` reusable workflows. */
    reusableDirectory: string
    /** Caller workflow files or directories to check. */
    targets: string[]
    /** Treat every target as a consumer-repository caller. */
    forceExternal?: boolean
}

/** Outcome of a contract check: blocking problems, advisory notes, and context. */
export interface ContractCheckResult {
    problems: string[]
    notes: string[]
    reusable: Map<string, Workflow>
    files: string[]
}

/** Run every contract rule and collect what it found, without printing or exiting. */
export const runContractCheck = (options: ContractCheckOptions): ContractCheckResult => {
    const problems: string[] = []
    const notes: string[] = []

    const reusable = new Map<string, Workflow>()
    for (const file of expandPath(options.reusableDirectory)) {
        if (basename(file).startsWith('call-')) reusable.set(basename(file), loadWorkflow(file))
    }

    if (reusable.size === 0) {
        throw new Error(`no call-*.yml reusable workflows found in ${options.reusableDirectory}`)
    }

    for (const workflow of reusable.values()) {
        checkReusableWorkflow(workflow, (line, message) =>
            problems.push(`${workflow.path}:${line}: ${message}`),
        )
    }

    const files = options.targets.flatMap(expandPath)
    for (const file of files) {
        const external =
            options.forceExternal === true || relative('.', file).split(sep).includes('templates')

        checkCallerWorkflow(
            loadWorkflow(file),
            { external, reusable },
            (line, message) => problems.push(`${file}:${line}: ${message}`),
            (line, message) => notes.push(`${file}:${line}: ${message}`),
        )
    }

    return { problems, notes, reusable, files }
}

/** Turn CLI arguments into {@link ContractCheckOptions}, applying defaults. */
export const parseArguments = (argv: string[]): ContractCheckOptions => {
    const remaining = [...argv]
    const targets: string[] = []
    let reusableDirectory = join('.github', 'workflows')
    let forceExternal = false

    while (remaining.length > 0) {
        const argument = remaining.shift()!

        /** `pnpm run <script> -- --flag` forwards a bare separator through. */
        if (argument === '--') continue

        if (argument === '--reusable') {
            const directory = remaining.shift()
            if (directory === undefined) throw new Error('--reusable needs a directory')
            reusableDirectory = directory
        } else if (argument === '--external') {
            forceExternal = true
        } else if (argument.startsWith('-')) {
            throw new Error(`unknown option: ${argument}`)
        } else {
            targets.push(argument)
        }
    }

    if (targets.length === 0) targets.push(reusableDirectory, join('templates', 'workflows'))

    return { reusableDirectory, targets, forceExternal }
}

/** CLI entry point: run the check, print a report, and set the exit code. */
const main = (): void => {
    let result: ContractCheckResult

    try {
        result = runContractCheck(parseArguments(process.argv.slice(2)))
    } catch (error) {
        console.error((error as Error).message)
        process.exit(2)
    }

    console.log('Reusable workflow secret contract:')
    for (const [file, workflow] of [...result.reusable].sort()) {
        const declared = [...workflow.declared.keys()]
        console.log(`  ${file}: ${declared.length > 0 ? declared.join(', ') : '(no secrets)'}`)
    }

    console.log(`\nCallers checked (${result.files.length}):`)
    for (const file of result.files) console.log(`  ${file}`)

    for (const note of result.notes) console.log(`\n::warning::${note}`)

    if (result.problems.length > 0) {
        console.error(`\n${result.problems.length} caller-contract problem(s):`)
        for (const problem of result.problems) console.error(`::error::${problem}`)
        process.exit(1)
    }

    console.log('\nCaller contract OK.')
}

/** Filenames this module runs as a CLI under; the self-test imports it instead. */
const ENTRY_POINTS = new Set(['check-caller-contract.ts', 'check-caller-contract.js'])

if (ENTRY_POINTS.has(basename(process.argv[1] ?? ''))) main()
