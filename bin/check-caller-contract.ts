// ─────────────────────────────────────────────────────────────
// Validate the caller <-> reusable-workflow contract.
//
// A cross-repository caller that gets this contract wrong does not fail a
// job — GitHub refuses to start the run ("startup_failure", zero jobs),
// which is invisible to any same-repository self-test. This makes the
// boundary checkable without dispatching a workflow.
//
// Usage:
//   pnpm check:callers [--reusable <dir>] [--external] [<path> ...]
//
//   <path>       workflow file or directory of caller workflows to check.
//                Defaults to .github/workflows and templates/workflows.
//   --reusable   directory holding this repository's call-*.yml reusable
//                workflows (default .github/workflows).
//   --external   treat every <path> as a consumer-repository caller, which
//                must reference reusable workflows by their fully qualified
//                <owner>/<repo>/...@<ref> path. Implied for templates/.
// ─────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export const SOURCE_REPO = 'gbtunney/snailicid3-actions'

const PERMISSION_LEVELS: Record<string, number> = { none: 0, read: 1, write: 2 }

// ── minimal YAML reader ──────────────────────────────────────
// Workflow files are uniformly indented mappings; this pulls out the handful
// of keys the contract depends on without taking a YAML dependency, so the
// check can run before any install step.

const BLOCK_SCALAR = /^[|>][+-]?\d*(\s+#.*)?$/
const KEY_LINE = /^(["']?)([A-Za-z0-9_.$-][^:'"]*)\1:(?:\s+(.*))?$/

interface Node {
    indent: number
    key: string
    value: string
    line: number
}

interface IndexedNode extends Node {
    index: number
}

const parse = (text: string): Node[] => {
    const nodes: Node[] = []
    let scalarIndent: number | null = null

    text.split(/\r?\n/).forEach((raw, index) => {
        const trimmed = raw.trim()
        const indent = raw.length - raw.trimStart().length

        if (scalarIndent !== null) {
            if (trimmed === '' || indent > scalarIndent) return
            scalarIndent = null
        }
        if (trimmed === '' || trimmed.startsWith('#')) return

        // Sequence entries (steps, matrix values) are opaque here, but a block
        // scalar opened inside one still has to be skipped over.
        const body = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
        const match = KEY_LINE.exec(body)
        if (!match) return

        const value = (match[3] ?? '').trim()
        if (BLOCK_SCALAR.test(value)) scalarIndent = indent

        if (trimmed.startsWith('- ')) return
        nodes.push({ indent, key: match[2]!.trim(), value, line: index + 1 })
    })

    return nodes
}

const childrenOf = (nodes: Node[], index: number): IndexedNode[] => {
    if (index < 0) return []
    const parent = nodes[index]!
    const children: IndexedNode[] = []
    let childIndent: number | null = null

    for (let i = index + 1; i < nodes.length; i++) {
        const node = nodes[i]!
        if (node.indent <= parent.indent) break
        if (childIndent === null) childIndent = node.indent
        if (node.indent === childIndent) children.push({ ...node, index: i })
    }

    return children
}

const findChild = (nodes: Node[], index: number, key: string): number => {
    const hit = childrenOf(nodes, index).find((node) => node.key === key)
    return hit ? hit.index : -1
}

const topLevel = (nodes: Node[], key: string): number =>
    nodes.findIndex((node) => node.indent === 0 && node.key === key)

const permissionsAt = (nodes: Node[], index: number): Record<string, string> | null => {
    if (index < 0) return null
    const map: Record<string, string> = {}
    for (const child of childrenOf(nodes, index)) map[child.key] = child.value
    return map
}

// ── workflow model ───────────────────────────────────────────

interface DeclaredSecret {
    required: boolean
}

interface CallerJob {
    id: string
    line: number
    uses: string | null
    usesLine: number
    inheritsSecrets: boolean
    forwarded: string[] | null
    inputs: Record<string, string>
    permissions: Record<string, string> | null
}

export interface Workflow {
    path: string
    declared: Map<string, DeclaredSecret>
    referenced: Set<string>
    jobs: CallerJob[]
    permissions: Record<string, string> | null
}

export const loadWorkflow = (path: string): Workflow => {
    const text = readFileSync(path, 'utf8')
    const nodes = parse(text)

    const workflowCall = findChild(nodes, topLevel(nodes, 'on'), 'workflow_call')
    const secretsIndex = findChild(nodes, workflowCall, 'secrets')
    const declared = new Map<string, DeclaredSecret>()

    for (const secret of childrenOf(nodes, secretsIndex)) {
        const required = childrenOf(nodes, secret.index).find((node) => node.key === 'required')
        declared.set(secret.key, { required: required?.value === 'true' })
    }

    const referenced = new Set(
        [...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!),
    )

    const jobs = childrenOf(nodes, topLevel(nodes, 'jobs')).map((job): CallerJob => {
        const uses = childrenOf(nodes, job.index).find((node) => node.key === 'uses')
        const secrets = findChild(nodes, job.index, 'secrets')
        const inputs: Record<string, string> = {}
        for (const input of childrenOf(nodes, findChild(nodes, job.index, 'with'))) {
            inputs[input.key] = input.value
        }

        return {
            id: job.key,
            line: job.line,
            uses: uses?.value ?? null,
            usesLine: uses?.line ?? job.line,
            inheritsSecrets: nodes[secrets]?.value === 'inherit',
            forwarded: secrets < 0 ? null : childrenOf(nodes, secrets).map((node) => node.key),
            inputs,
            permissions: permissionsAt(nodes, findChild(nodes, job.index, 'permissions')),
        }
    })

    return {
        path,
        declared,
        referenced,
        jobs,
        permissions: permissionsAt(nodes, topLevel(nodes, 'permissions')),
    }
}

// ── target resolution ────────────────────────────────────────

interface Target {
    file: string
    qualified: boolean
    ref?: string
}

const resolveTarget = (uses: string | null): Target | null => {
    if (!uses) return null

    // Local: ./.github/workflows/x.yml or $/.github/workflows/x.yml
    const local = /^[.$]\/\.github\/workflows\/(?<file>[^@\s]+)$/.exec(uses)
    if (local?.groups) return { file: local.groups['file']!, qualified: false }

    // Remote: owner/repo/.github/workflows/x.yml@ref
    const remote =
        /^(?<repo>[^/]+\/[^/]+)\/\.github\/workflows\/(?<file>[^@\s]+)@(?<ref>\S+)$/.exec(uses)
    if (remote?.groups && remote.groups['repo'] === SOURCE_REPO) {
        return { file: remote.groups['file']!, qualified: true, ref: remote.groups['ref']! }
    }

    return null
}

// ── checks ───────────────────────────────────────────────────

export interface CheckResult {
    problems: string[]
    notes: string[]
    reusable: Map<string, Workflow>
    files: string[]
}

const checkReusable = (workflow: Workflow, fail: (l: number, m: string) => void): void => {
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

const checkCaller = (
    workflow: Workflow,
    options: { external: boolean; reusable: Map<string, Workflow> },
    fail: (line: number, message: string) => void,
    warn: (line: number, message: string) => void,
): void => {
    for (const job of workflow.jobs) {
        const target = resolveTarget(job.uses)

        if (job.inheritsSecrets) {
            fail(
                job.line,
                `job "${job.id}" uses secrets: inherit — forward the secrets the called workflow declares by name instead`,
            )
        }

        if (!target) continue

        if (options.external && !target.qualified) {
            fail(
                job.usesLine,
                `job "${job.id}" references ${job.uses} — a consumer repository has no such file; use ${SOURCE_REPO}/.github/workflows/...@<ref>`,
            )
            continue
        }

        const called = options.reusable.get(target.file)
        if (!called) {
            fail(job.usesLine, `job "${job.id}" calls unknown workflow ${target.file}`)
            continue
        }

        const forwarded = job.forwarded ?? []

        for (const secret of forwarded) {
            if (!called.declared.has(secret)) {
                fail(job.line, `job "${job.id}" forwards ${secret}, which ${target.file} does not declare`)
            }
        }

        for (const [secret, meta] of called.declared) {
            if (meta.required && !forwarded.includes(secret)) {
                fail(job.line, `job "${job.id}" omits ${secret}, required by ${target.file}`)
            }
        }

        if (job.inputs['run_chromatic'] === 'true' && !forwarded.includes('CHROMATIC_PROJECT_TOKEN')) {
            fail(job.line, `job "${job.id}" sets run_chromatic: true but does not forward CHROMATIC_PROJECT_TOKEN`)
        }

        // A caller must grant at least what the called workflow declares, or
        // the whole run dies at startup with zero jobs.
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
            const have = PERMISSION_LEVELS[granted[scope] ?? ''] ?? -1
            const need = PERMISSION_LEVELS[level] ?? 0
            if (have < need) {
                fail(
                    job.line,
                    `job "${job.id}" grants ${scope}: ${granted[scope] ?? 'nothing'} but ${target.file} declares ${scope}: ${level}`,
                )
            }
        }
    }
}

const expand = (path: string): string[] =>
    statSync(path).isDirectory()
        ? readdirSync(path)
              .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
              .sort()
              .map((file) => join(path, file))
        : [path]

export const runContractCheck = (options: {
    reusableDir: string
    targets: string[]
    forceExternal?: boolean
}): CheckResult => {
    const problems: string[] = []
    const notes: string[] = []

    const reusable = new Map<string, Workflow>()
    for (const file of expand(options.reusableDir)) {
        if (!basename(file).startsWith('call-')) continue
        reusable.set(basename(file), loadWorkflow(file))
    }

    if (reusable.size === 0) {
        throw new Error(`no call-*.yml reusable workflows found in ${options.reusableDir}`)
    }

    for (const workflow of reusable.values()) {
        checkReusable(workflow, (line, message) => problems.push(`${workflow.path}:${line}: ${message}`))
    }

    const files = options.targets.flatMap(expand)
    for (const file of files) {
        const external = options.forceExternal === true || relative('.', file).split(sep).includes('templates')
        checkCaller(
            loadWorkflow(file),
            { external, reusable },
            (line, message) => problems.push(`${file}:${line}: ${message}`),
            (line, message) => notes.push(`${file}:${line}: ${message}`),
        )
    }

    return { problems, notes, reusable, files }
}

// ── cli ──────────────────────────────────────────────────────

const main = (): void => {
    const args = process.argv.slice(2)
    let reusableDir = join('.github', 'workflows')
    let forceExternal = false
    const targets: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        // `pnpm run <script> -- --flag` forwards a bare separator through.
        if (arg === '--') continue
        else if (arg === '--reusable') reusableDir = args[++i]!
        else if (arg === '--external') forceExternal = true
        else if (arg.startsWith('-')) {
            console.error(`unknown option: ${arg}`)
            process.exit(2)
        } else targets.push(arg)
    }

    if (targets.length === 0) targets.push(reusableDir, join('templates', 'workflows'))

    let result: CheckResult
    try {
        result = runContractCheck({ reusableDir, targets, forceExternal })
    } catch (error) {
        console.error((error as Error).message)
        process.exit(2)
    }

    console.log('Reusable workflow secret contract:')
    for (const [file, workflow] of [...result.reusable].sort()) {
        const declared = [...workflow.declared.keys()]
        console.log(`  ${file}: ${declared.length ? declared.join(', ') : '(no secrets)'}`)
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

// Runs as a CLI only when it is the entry point; the self-test imports it.
if (basename(process.argv[1] ?? '') === 'check-caller-contract.ts') main()
