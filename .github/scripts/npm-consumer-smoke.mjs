#!/usr/bin/env node
/**
 * npm consumer smoke.
 *
 * Answers one question per package: can a normal npm user install the
 * published package from the registry, import its public entry points, and
 * run a documented function? It never builds, links, packs, or patches
 * anything, and it never touches a workspace: every package is installed with
 * plain `npm install <name>@<version>` into its own empty `npm init -y`
 * project, exactly as an outside consumer would.
 *
 * Plain Node ESM with no dependencies, on purpose. The point is to observe the
 * packages without pnpm, so the harness itself must not need pnpm, tsx, or an
 * install step to run.
 *
 * Reporting is non-enforcing by default: failures are findings, written to the
 * report, and the process exits 0. `--mode abort_on_error` exits 1 when any
 * package fails. Operational problems (bad arguments, unreadable cases file)
 * always exit 2.
 *
 * @example
 * ```sh
 * node .github/scripts/npm-consumer-smoke.mjs --scope @snailicid3 --out ./npm-consumer-smoke
 * node .github/scripts/npm-consumer-smoke.mjs --package @snailicid3/utils --package @snailicid3/logger@0.1.0
 * ```
 */

import { spawnSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { EOL, release, tmpdir, type as osType } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CASES = join(SCRIPT_DIR, 'npm-consumer-smoke.cases.json')

const INSTALL_TIMEOUT_MS = 10 * 60_000
const RUN_TIMEOUT_MS = 60_000

/** Extensions Node can evaluate as a module. Anything else is checked for resolution only. */
const EVALUATED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/**
 * Stages in the order a consumer meets them. A package's result is the first
 * stage that failed, matching the "Final Result" checklist of the manual test.
 */
const RESULTS = {
    pass: 'PASS — install + import + execution all succeeded',
    pass_import_only:
        'PASS (import only) — install + import succeeded; no execution case is registered',
    pass_install_only:
        'PASS (install only) — installed; no public entry point could be imported without optional peers',
    fail_install: 'FAIL — npm installation',
    fail_resolution: 'FAIL — module/package resolution',
    fail_import_export: 'FAIL — public import/export',
    fail_runtime: 'FAIL — function execution/runtime',
    fail_other: 'FAIL — other',
}

// ─── arguments ────────────────────────────────────────────────

const usage = `Usage: npm-consumer-smoke.mjs [options]

  --scope <@scope>       Discover and test every published package in a scope
  --package <spec>       Test one package (name or name@version|range|tag); repeatable
  --cases <file>         Execution cases JSON (default: npm-consumer-smoke.cases.json beside this script)
  --out <dir>            Report directory (default: ./npm-consumer-smoke-report)
  --summary <file>       Also append the summary Markdown here (e.g. $GITHUB_STEP_SUMMARY)
  --outputs <file>       Write key=value outputs here (e.g. $GITHUB_OUTPUT)
  --mode <mode>          report (default) | abort_on_error
  --include-deprecated   Also test packages whose published version is deprecated
  --keep                 Keep each temporary consumer project for inspection`

const parseArguments = (argv) => {
    const options = {
        scope: '',
        packages: [],
        cases: DEFAULT_CASES,
        casesExplicit: false,
        out: resolve('npm-consumer-smoke-report'),
        summary: '',
        outputs: '',
        mode: 'report',
        includeDeprecated: false,
        keep: false,
    }
    const remaining = [...argv]
    const value = (flag) => {
        const next = remaining.shift()
        if (next === undefined || next.startsWith('--'))
            throw new Error(`${flag} needs a value`)
        return next
    }

    while (remaining.length > 0) {
        const argument = remaining.shift()
        switch (argument) {
            case '--':
                break
            case '--scope':
                options.scope = value(argument)
                break
            case '--package':
                // Workflow inputs arrive as one whitespace-separated string.
                options.packages.push(
                    ...value(argument).split(/\s+/).filter(Boolean),
                )
                break
            case '--cases':
                options.cases = resolve(value(argument))
                options.casesExplicit = true
                break
            case '--out':
                options.out = resolve(value(argument))
                break
            case '--summary':
                options.summary = value(argument)
                break
            case '--outputs':
                options.outputs = value(argument)
                break
            case '--mode':
                options.mode = value(argument)
                break
            case '--include-deprecated':
                options.includeDeprecated = true
                break
            case '--keep':
                options.keep = true
                break
            case '--help':
            case '-h':
                console.log(usage)
                process.exit(0)
            default:
                throw new Error(`unknown argument: ${argument}\n\n${usage}`)
        }
    }

    if (!['report', 'abort_on_error'].includes(options.mode)) {
        throw new Error(
            `invalid --mode ${options.mode}; expected report or abort_on_error`,
        )
    }
    if (options.scope && !/^@[a-z0-9][a-z0-9._-]*$/.test(options.scope)) {
        throw new Error(`invalid --scope ${options.scope}; expected @scope`)
    }
    if (!options.scope && options.packages.length === 0) {
        throw new Error(
            `nothing to test: pass --scope or --package\n\n${usage}`,
        )
    }
    return options
}

// ─── process helpers ──────────────────────────────────────────

/**
 * The environment a fresh terminal would have. Anything a package-manager
 * wrapper exported (`npm_config_*`, `npm_package_*`, pnpm's own variables)
 * is removed, so running this script through pnpm cannot leak pnpm settings
 * into the npm installs it is meant to observe.
 */
const consumerEnvironment = () =>
    Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !/^(npm_|pnpm_)/i.test(key) && key !== 'NODE_OPTIONS',
        ),
    )

const run = (command, args, { cwd, timeout = RUN_TIMEOUT_MS } = {}) => {
    const started = Date.now()
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env: { ...consumerEnvironment(), NO_COLOR: '1', FORCE_COLOR: '0' },
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === 'win32',
        timeout,
    })
    return {
        command: [command, ...args].join(' '),
        status: result.status,
        signal: result.signal,
        error: result.error ? String(result.error.message ?? result.error) : '',
        stdout: (result.stdout ?? '').trimEnd(),
        stderr: (result.stderr ?? '').trimEnd(),
        ok: result.status === 0 && !result.error,
        ms: Date.now() - started,
    }
}

const combinedOutput = (outcome) =>
    [
        outcome.stdout,
        outcome.stderr,
        outcome.error && `[spawn] ${outcome.error}`,
        outcome.signal && `[signal] ${outcome.signal}`,
    ]
        .filter(Boolean)
        .join('\n')

const npmJson = (args, cwd) => {
    const outcome = run('npm', [...args, '--json'], { cwd })
    if (!outcome.ok) return { ok: false, outcome }
    try {
        return {
            ok: true,
            value: JSON.parse(outcome.stdout || 'null'),
            outcome,
        }
    } catch {
        return { ok: false, outcome }
    }
}

// ─── discovery ────────────────────────────────────────────────

/**
 * Every package the registry lists under a scope.
 *
 * The registry search endpoint is fuzzy text search, so results are filtered
 * to the exact `@scope/` prefix. Search is eventually consistent: a package
 * published minutes ago can be missing, which is why `--package` exists.
 */
const discoverScope = async (scope) => {
    const registry =
        run('npm', ['config', 'get', 'registry']).stdout.trim() ||
        'https://registry.npmjs.org/'
    const url = new URL(
        '-/v1/search',
        registry.endsWith('/') ? registry : `${registry}/`,
    )
    url.searchParams.set('text', scope)
    url.searchParams.set('size', '250')

    const response = await fetch(url)
    if (!response.ok)
        throw new Error(
            `registry search failed: ${response.status} ${response.statusText} (${url})`,
        )
    const body = await response.json()
    return [...new Set(body.objects.map((entry) => entry.package.name))]
        .filter((name) => name.startsWith(`${scope}/`))
        .sort()
}

/** Split `@scope/name@range` into its name and requested version spec. */
const splitSpec = (spec) => {
    const at = spec.lastIndexOf('@')
    return at > 0
        ? { name: spec.slice(0, at), requested: spec.slice(at + 1) }
        : { name: spec, requested: 'latest' }
}

// ─── exports analysis ─────────────────────────────────────────

/**
 * The public subpaths a package declares, each with the target Node would
 * pick for `import` and for `require`. Only declared subpaths are exercised:
 * reaching into `dist/` or `src/` is not something a consumer may rely on.
 */
const publicEntryPoints = (manifest) => {
    const { exports } = manifest
    if (exports === undefined || exports === null) {
        // Node ignores `module`; without `main` it falls back to index.js.
        const main = manifest.main ?? 'index.js'
        return [
            {
                subpath: '.',
                importTarget: main,
                requireTarget: main,
                legacy: true,
            },
        ]
    }

    const isSubpathMap =
        typeof exports === 'object' &&
        !Array.isArray(exports) &&
        Object.keys(exports).some((key) => key.startsWith('.'))
    const entries = isSubpathMap ? Object.entries(exports) : [['.', exports]]

    return entries
        .filter(([subpath]) => subpath !== './package.json')
        .map(([subpath, target]) => ({
            subpath,
            pattern: subpath.includes('*'),
            importTarget: pickTarget(target, ['node', 'import', 'default']),
            requireTarget: pickTarget(target, ['node', 'require', 'default']),
        }))
}

/** Resolve an exports target the way Node walks conditions: first matching key wins, in object order. */
const pickTarget = (target, conditions) => {
    if (target === null) return null
    if (typeof target === 'string') return target
    if (Array.isArray(target)) {
        for (const candidate of target) {
            const picked = pickTarget(candidate, conditions)
            if (picked) return picked
        }
        return null
    }
    for (const [condition, nested] of Object.entries(target)) {
        if (condition === 'types') continue
        if (conditions.includes(condition)) {
            const picked = pickTarget(nested, conditions)
            if (picked) return picked
        }
    }
    return null
}

const extensionOf = (target) => {
    const match = /(\.[a-z0-9]+)$/i.exec(target ?? '')
    return match ? match[1].toLowerCase() : ''
}

const specifierFor = (name, subpath) =>
    subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`

// ─── failure classification ───────────────────────────────────

/**
 * Map Node's error to the stage a consumer would say broke.
 *
 * "Cannot find" a module means resolution. A subpath that is not exported, a
 * named export that does not exist, or an ESM/CJS format mismatch means the
 * public import/export surface is wrong. During the import stage anything else
 * thrown while the module evaluates still means the import failed; only during
 * the execution stage is it a function runtime failure.
 */
const classifyFailure = (output, stage) => {
    if (
        /ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT|does not provide an export named|ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE|ERR_UNKNOWN_FILE_EXTENSION|ERR_IMPORT_ATTRIBUTE|Named export .* not found|ERR_INVALID_PACKAGE_TARGET|ERR_INVALID_PACKAGE_CONFIG/.test(
            output,
        )
    ) {
        return 'fail_import_export'
    }
    if (
        /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (package|module)/.test(
            output,
        )
    )
        return 'fail_resolution'
    return stage === 'import' ? 'fail_import_export' : 'fail_runtime'
}

/** The dependency Node could not find, when the failure names one. */
const missingModule = (output) =>
    /Cannot find (?:package|module) '([^']+)'/.exec(output)?.[1] ?? null

// ─── one package ──────────────────────────────────────────────

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const writeTestFile = (projectRoot, fileName, lines) => {
    const source = `${lines.join('\n')}\n`
    writeFileSync(join(projectRoot, fileName), source)
    return source
}

const smokePackage = (spec, context) => {
    const { name, requested } = splitSpec(spec)
    const report = {
        spec,
        name,
        requested,
        version: null,
        deprecated: null,
        result: null,
        install: null,
        registryCheck: null,
        npmLs: null,
        bins: [],
        imports: [],
        executions: [],
        notes: [],
        projectRoot: null,
    }

    const view = npmJson(
        ['view', `${name}@${requested}`, 'version', 'deprecated'],
        context.root,
    )
    // `npm view` returns an array when a range matches several versions (highest last),
    // and exits 0 with no output when nothing matches.
    const viewed = view.ok
        ? Array.isArray(view.value)
            ? view.value.at(-1)
            : view.value
        : null
    report.version =
        (typeof viewed === 'string' ? viewed : viewed?.version) ?? null
    report.deprecated =
        typeof viewed === 'object' ? (viewed?.deprecated ?? null) : null
    if (!report.version) {
        report.result = 'fail_install'
        report.install = {
            ...view.outcome,
            ok: false,
            command: `npm view ${name}@${requested} version deprecated --json`,
        }
        report.notes.push(
            `The registry has no version of ${name} matching \`${requested}\`.`,
        )
        return report
    }

    if (report.deprecated && !context.includeDeprecated) {
        report.result = 'skipped_deprecated'
        report.notes.push(
            `Skipped: ${name}@${report.version} is deprecated on the registry ("${report.deprecated}").`,
        )
        return report
    }

    const projectRoot = mkdtempSync(
        join(context.root, `${name.replace(/[@/]/g, '_')}-`),
    )
    report.projectRoot = projectRoot

    // 1 ── a fresh project, the way a person starts one.
    const init = run('npm', ['init', '-y'], { cwd: projectRoot })
    if (!init.ok) {
        report.result = 'fail_other'
        report.install = init
        report.notes.push(
            '`npm init -y` failed before the package was involved.',
        )
        return report
    }

    // 2 ── install from the registry, exact version so the report reproduces.
    report.install = run('npm', ['install', `${name}@${report.version}`], {
        cwd: projectRoot,
        timeout: INSTALL_TIMEOUT_MS,
    })
    if (!report.install.ok) {
        report.result = 'fail_install'
        return report
    }

    report.npmLs = run('npm', ['ls', name], { cwd: projectRoot })

    // The manual test forbids links, tarballs, git and workspace sources, so
    // prove the lockfile resolved the package from the registry.
    const lock = existsSync(join(projectRoot, 'package-lock.json'))
        ? readJson(join(projectRoot, 'package-lock.json'))
        : null
    const locked = lock?.packages?.[`node_modules/${name}`]
    report.registryCheck = {
        resolved: locked?.resolved ?? null,
        fromRegistry: Boolean(locked?.resolved?.startsWith(context.registry)),
        version: locked?.version ?? null,
    }

    const packageRoot = join(projectRoot, 'node_modules', ...name.split('/'))
    const manifest = readJson(join(packageRoot, 'package.json'))

    // Bins are checked for presence only. Running an arbitrary bin with
    // `--help` is not safe in general — some set up or tear down files.
    const bins =
        typeof manifest.bin === 'string'
            ? { [name.split('/').pop()]: manifest.bin }
            : (manifest.bin ?? {})
    for (const [binName, target] of Object.entries(bins)) {
        const linked = join(projectRoot, 'node_modules', '.bin', binName)
        const targetPath = join(packageRoot, target)
        report.bins.push({
            name: binName,
            target,
            targetExists: existsSync(targetPath),
            linked: existsSync(linked),
            executable:
                existsSync(targetPath) && process.platform !== 'win32'
                    ? (statSync(targetPath).mode & 0o111) !== 0
                    : null,
        })
    }

    // 3 ── import every declared public entry point.
    const optionalPeers = new Set(
        Object.entries(manifest.peerDependenciesMeta ?? {})
            .filter(([, meta]) => meta?.optional === true)
            .map(([peer]) => peer),
    )
    const entryPoints = publicEntryPoints(manifest)
    if (entryPoints.length === 0) {
        report.notes.push(
            'The package declares no runtime entry point (no `exports`, `main`, or `module`).',
        )
    }

    entryPoints.forEach((entry, index) => {
        const specifier = specifierFor(name, entry.subpath)
        if (entry.pattern) {
            report.imports.push({
                specifier,
                kind: 'pattern',
                state: 'skipped',
                detail: 'Wildcard subpath; no single file to import.',
            })
            return
        }

        const importTarget = entry.importTarget
        const requireTarget = entry.requireTarget
        const evaluatesAsEsm =
            importTarget &&
            (EVALUATED_EXTENSIONS.has(extensionOf(importTarget)) ||
                entry.legacy)

        if (importTarget && evaluatesAsEsm) {
            const file = `import-${index}.mjs`
            const source = writeTestFile(projectRoot, file, [
                `import * as entry from ${JSON.stringify(specifier)}`,
                '',
                'const names = Object.keys(entry).sort()',
                "console.log(`${names.length} export(s): ${names.join(', ')}`)",
            ])
            report.imports.push(
                importCheck(
                    {
                        specifier,
                        kind: 'esm',
                        target: importTarget,
                        file,
                        source,
                    },
                    projectRoot,
                    optionalPeers,
                ),
            )
        } else if (importTarget) {
            // JSON, shell, CSS: tools resolve these by path rather than
            // evaluating them, so resolution is the consumer-facing contract.
            const file = `resolve-${index}.mjs`
            const source = writeTestFile(projectRoot, file, [
                "import { existsSync } from 'node:fs'",
                "import { fileURLToPath } from 'node:url'",
                '',
                `const resolved = fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))`,
                "if (!existsSync(resolved)) throw new Error(`Cannot find module '${resolved}'`)",
                'console.log(resolved)',
            ])
            report.imports.push(
                importCheck(
                    {
                        specifier,
                        kind: 'resolve',
                        target: importTarget,
                        file,
                        source,
                    },
                    projectRoot,
                    optionalPeers,
                ),
            )
        }

        // CommonJS is exercised only where the package offers it: a distinct
        // `require` target, a .cjs file, or a classic `main` in a CommonJS
        // package. An import-only entry rejecting `require()` is its design.
        const offersRequire =
            requireTarget &&
            (requireTarget !== importTarget ||
                extensionOf(requireTarget) === '.cjs' ||
                (entry.legacy && manifest.type !== 'module'))
        if (
            offersRequire &&
            EVALUATED_EXTENSIONS.has(extensionOf(requireTarget))
        ) {
            const file = `require-${index}.cjs`
            const source = writeTestFile(projectRoot, file, [
                `const entry = require(${JSON.stringify(specifier)})`,
                '',
                'const names = Object.keys(entry).sort()',
                "console.log(`${names.length} export(s): ${names.join(', ')}`)",
            ])
            report.imports.push(
                importCheck(
                    {
                        specifier,
                        kind: 'cjs',
                        target: requireTarget,
                        file,
                        source,
                    },
                    projectRoot,
                    optionalPeers,
                ),
            )
        }
    })

    // 4 ── execute documented functions, when a case is registered.
    for (const [index, testCase] of (context.cases[name] ?? []).entries()) {
        const file = `execute-${index}.${testCase.format === 'cjs' ? 'cjs' : 'mjs'}`
        const source = writeTestFile(projectRoot, file, testCase.source)
        const outcome = run(process.execPath, [file], { cwd: projectRoot })
        // The last line is the case's answer; anything a package prints first
        // (banners, logging) stays in the report's full terminal output.
        const actual = outcome.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
        report.executions.push({
            name: testCase.name,
            file,
            source,
            expected: testCase.expected,
            actual,
            outcome,
            state:
                outcome.ok && actual === testCase.expected
                    ? 'passed'
                    : 'failed',
            classification: outcome.ok
                ? 'fail_runtime'
                : classifyFailure(combinedOutput(outcome), 'execution'),
        })
    }

    report.result = finalResult(report)
    return report
}

const importCheck = (check, projectRoot, optionalPeers) => {
    const outcome = run(process.execPath, [check.file], { cwd: projectRoot })
    const output = combinedOutput(outcome)
    const missing = outcome.ok ? null : missingModule(output)
    // An entry point documented as needing an optional peer cannot load
    // without it; npm is right not to install it, so that is not a failure.
    if (missing && optionalPeers.has(missing)) {
        return {
            ...check,
            outcome,
            state: 'skipped',
            classification: null,
            missing,
            detail: `Needs the optional peer dependency \`${missing}\`, which npm does not install; a consumer adds it to use this entry point.`,
        }
    }
    return {
        ...check,
        outcome,
        state: outcome.ok ? 'passed' : 'failed',
        classification: outcome.ok ? null : classifyFailure(output, 'import'),
        missing,
    }
}

const finalResult = (report) => {
    const failedImport = report.imports.find(
        (check) => check.state === 'failed',
    )
    if (failedImport) return failedImport.classification
    const failedExecution = report.executions.find(
        (check) => check.state === 'failed',
    )
    if (failedExecution) return failedExecution.classification
    if (report.registryCheck && !report.registryCheck.fromRegistry)
        return 'fail_other'
    if (!report.imports.some((check) => check.state === 'passed'))
        return 'pass_install_only'
    return report.executions.length > 0 ? 'pass' : 'pass_import_only'
}

// ─── reporting ────────────────────────────────────────────────

const packageLabel = (report) =>
    `${report.name}@${report.version ?? report.requested}`

const fence = (text, language = '') => {
    const body = text === '' ? '(no output)' : text
    const ticks = '`'.repeat(
        Math.max(
            3,
            ...[...body.matchAll(/`+/g)].map((match) => match[0].length + 1),
        ),
    )
    return `${ticks}${language}\n${body}\n${ticks}`
}

const yesNo = (value) => (value ? 'YES' : 'NO')

const linesMatching = (text, pattern) =>
    text
        .split(/\r?\n/)
        .filter((line) => pattern.test(line))
        .join('\n')

/** One package, laid out as the five sections of the manual consumer smoke test. */
const packageMarkdown = (report, environment) => {
    const out = []
    const push = (...lines) => out.push(...lines)
    const label =
        report.result === 'skipped_deprecated'
            ? 'SKIPPED — deprecated on the registry'
            : RESULTS[report.result]

    push(
        `# npm consumer smoke — \`${packageLabel(report)}\``,
        '',
        `**Result:** ${label}`,
        '',
    )
    for (const note of report.notes) push(`> ${note}`, '')

    push(
        '## 1. Environment',
        '',
        fence(
            [
                `Package: ${report.name}`,
                `Installed package version: ${report.registryCheck?.version ?? report.version ?? 'n/a'}`,
                `Node version: ${environment.node}`,
                `npm version: ${environment.npm}`,
                `Operating system: ${environment.os}`,
            ].join('\n'),
        ),
        '',
    )
    if (report.npmLs)
        push('`npm ls` output:', '', fence(combinedOutput(report.npmLs)), '')

    push(
        '## 2. Installation',
        '',
        'Exact commands, run in an empty directory:',
        '',
        fence(['npm init -y', report.install?.command ?? ''].join('\n'), 'sh'),
        '',
    )
    if (report.install) {
        const output = combinedOutput(report.install)
        push(
            fence(
                [
                    `Install successful: ${yesNo(report.install.ok)}`,
                    `Warnings: ${linesMatching(output, /^npm warn/i) || 'none'}`,
                    `Errors: ${linesMatching(output, /^npm (error|ERR!)/i) || 'none'}`,
                ].join('\n'),
            ),
            '',
        )
        push(
            '<details><summary>Full install output</summary>',
            '',
            fence(output),
            '',
            '</details>',
            '',
        )
    }
    if (report.registryCheck) {
        push(
            `Registry source: \`${report.registryCheck.resolved ?? 'unknown'}\` (from registry: ${yesNo(report.registryCheck.fromRegistry)})`,
            '',
        )
    }
    if (report.bins.length > 0) {
        push(
            'Declared bins (presence check only; bins are not run):',
            '',
            '| bin | target | target exists | linked in node_modules/.bin | executable |',
            '| --- | --- | --- | --- | --- |',
        )
        for (const bin of report.bins) {
            push(
                `| \`${bin.name}\` | \`${bin.target}\` | ${yesNo(bin.targetExists)} | ${yesNo(bin.linked)} | ${bin.executable === null ? 'n/a' : yesNo(bin.executable)} |`,
            )
        }
        push('')
    }

    push('## 3. Import Test', '')
    if (report.imports.length === 0) push('Not reached.', '')
    for (const check of report.imports) {
        push(`### \`${check.specifier}\` (${check.kind})`, '')
        if (check.kind === 'pattern') {
            push(check.detail, '')
            continue
        }
        push(
            `Declared target: \`${check.target}\` — test file \`${check.file}\`:`,
            '',
            fence(check.source.trimEnd(), check.kind === 'cjs' ? 'js' : 'js'),
            '',
        )
        if (check.state === 'skipped') {
            push(
                `Not counted: ${check.detail}`,
                '',
                '<details><summary>Output</summary>',
                '',
                fence(combinedOutput(check.outcome)),
                '',
                '</details>',
                '',
            )
            continue
        }
        push(fence(`Import successful: ${yesNo(check.state === 'passed')}`), '')
        push(
            check.state === 'passed' ? 'Output:' : 'Complete error, unedited:',
            '',
            fence(combinedOutput(check.outcome)),
            '',
        )
    }

    push('## 4. Execution Test', '')
    if (report.executions.length === 0) {
        push(
            report.imports.length > 0
                ? 'No execution case is registered for this package, so no function was called.'
                : 'Not reached.',
            '',
        )
    }
    for (const execution of report.executions) {
        push(
            `### ${execution.name}`,
            '',
            `Run command: \`node ${execution.file}\``,
            '',
            fence(execution.source.trimEnd(), 'js'),
            '',
        )
        push(
            fence(
                [
                    `Function executed: ${yesNo(execution.outcome.ok)}`,
                    '',
                    `Expected result: ${execution.expected}`,
                    `Actual result: ${execution.actual || '(none)'}`,
                ].join('\n'),
            ),
            '',
        )
        push(
            'Complete terminal output:',
            '',
            fence(combinedOutput(execution.outcome)),
            '',
        )
    }

    push(
        '## 5. Final Result',
        '',
        fence(
            Object.entries(RESULTS)
                .map(
                    ([key, text]) =>
                        `[${report.result === key ? 'x' : ' '}] ${text}`,
                )
                .join('\n'),
        ),
        '',
    )
    return out.join('\n')
}

const firstFailure = (report) => {
    if (report.result === 'fail_install')
        return combinedOutput(report.install ?? {})
    const failed = [...report.imports, ...report.executions].find(
        (check) => check.state === 'failed',
    )
    if (!failed) return ''
    if (failed.expected !== undefined && failed.outcome.ok)
        return `expected ${failed.expected}, got ${failed.actual || '(none)'}`
    return combinedOutput(failed.outcome)
}

const excerpt = (text, limit = 1500) =>
    text.length > limit
        ? `${text.slice(0, limit)}\n… (truncated; full output in the package report)`
        : text

const summaryMarkdown = (reports, environment, options) => {
    const out = []
    const counts = reports.reduce(
        (tally, report) => ({
            ...tally,
            [report.result]: (tally[report.result] ?? 0) + 1,
        }),
        {},
    )
    const failed = reports.filter((report) => report.result.startsWith('fail_'))

    out.push(
        `## 📦 npm consumer smoke — ${options.scope || 'selected packages'}`,
        '',
    )
    out.push(
        `Node \`${environment.node}\` · npm \`${environment.npm}\` · ${environment.os} · registry \`${environment.registry}\``,
        '',
    )
    out.push(
        `**${reports.length - failed.length - (counts.skipped_deprecated ?? 0)} passed · ${failed.length} failed${counts.skipped_deprecated ? ` · ${counts.skipped_deprecated} skipped (deprecated)` : ''}** of ${reports.length} package(s). Every package was installed with plain \`npm install <name>@<version>\` into its own empty \`npm init -y\` project — no pnpm, no workspace, no links, no local tarballs.`,
        '',
    )
    out.push(
        '| Package | Version | Install | Imports | Execution | Result |',
        '| --- | --- | --- | --- | --- | --- |',
    )
    for (const report of reports) {
        const imports = report.imports.filter(
            (check) => check.state !== 'skipped',
        )
        const skippedImports = report.imports.length - imports.length
        const importCell = `${imports.length === 0 ? '—' : `${imports.filter((check) => check.state === 'passed').length}/${imports.length}`}${skippedImports > 0 ? ` (+${skippedImports} skipped)` : ''}`
        const executionCell =
            report.executions.length === 0
                ? '—'
                : `${report.executions.filter((check) => check.state === 'passed').length}/${report.executions.length}`
        const installCell = report.install
            ? report.install.ok
                ? '✅'
                : '❌'
            : '—'
        const resultCell =
            report.result === 'skipped_deprecated'
                ? '⏭️ deprecated'
                : `${report.result.startsWith('fail_') ? '❌' : '✅'} ${RESULTS[report.result].split(' — ')[0]}${report.result.startsWith('fail_') ? ` — ${RESULTS[report.result].split(' — ')[1]}` : ''}`
        out.push(
            `| \`${report.name}\` | \`${report.version ?? report.requested}\` | ${installCell} | ${importCell} | ${executionCell} | ${resultCell} |`,
        )
    }
    out.push('')

    for (const report of failed) {
        const failing =
            report.imports.find((check) => check.state === 'failed') ??
            report.executions.find((check) => check.state === 'failed')
        out.push(
            `### ❌ \`${packageLabel(report)}\` — ${RESULTS[report.result]}`,
            '',
        )
        if (failing)
            out.push(
                `First failing check: \`${failing.specifier ?? failing.name}\`${failing.missing ? ` — cannot find \`${failing.missing}\`` : ''}`,
                '',
            )
        out.push(fence(excerpt(firstFailure(report))), '')
    }

    out.push(
        'Full per-package reports, in the format of the manual consumer smoke test, are in the uploaded report artifact.',
        '',
    )
    return out.join('\n')
}

// ─── main ─────────────────────────────────────────────────────

const loadCases = (path, explicit) => {
    if (!existsSync(path)) {
        if (explicit) throw new Error(`cases file not found: ${path}`)
        return {}
    }
    const raw = readJson(path)
    const cases = {}
    for (const [name, entries] of Object.entries(raw)) {
        if (name.startsWith('$')) continue
        cases[name] = entries.map((entry) => ({
            name: entry.name,
            format: entry.format ?? 'esm',
            source: Array.isArray(entry.source)
                ? entry.source
                : String(entry.source).split('\n'),
            expected: String(entry.expected),
        }))
    }
    return cases
}

const readOsName = () => {
    try {
        const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(
            readFileSync('/etc/os-release', 'utf8'),
        )?.[1]
        if (pretty) return `${pretty} (${osType()} ${release()})`
    } catch {
        // Not Linux, or no os-release; the kernel string is still useful.
    }
    return `${osType()} ${release()}`
}

const main = async () => {
    let options
    try {
        options = parseArguments(process.argv.slice(2))
    } catch (error) {
        console.error(error.message)
        process.exit(2)
    }

    let cases
    try {
        cases = loadCases(options.cases, options.casesExplicit)
    } catch (error) {
        console.error(error.message)
        process.exit(2)
    }
    const registry =
        run('npm', ['config', 'get', 'registry']).stdout.trim() ||
        'https://registry.npmjs.org/'
    const environment = {
        node: process.version,
        npm: run('npm', ['--version']).stdout.trim(),
        os: readOsName(),
        registry,
    }

    const specs =
        options.packages.length > 0
            ? options.packages
            : await discoverScope(options.scope)
    if (specs.length === 0) {
        console.error(`No packages found for ${options.scope}.`)
        process.exit(2)
    }

    const root = mkdtempSync(join(tmpdir(), 'npm-consumer-smoke-'))
    const context = {
        root,
        cases,
        registry,
        includeDeprecated: options.includeDeprecated,
    }
    console.log(
        `npm consumer smoke: ${specs.length} package(s) · node ${environment.node} · npm ${environment.npm}`,
    )

    const reports = []
    for (const spec of specs) {
        process.stdout.write(`  ${spec} … `)
        const report = smokePackage(spec, context)
        reports.push(report)
        console.log(
            report.result === 'skipped_deprecated'
                ? 'skipped (deprecated)'
                : RESULTS[report.result],
        )
    }

    mkdirSync(join(options.out, 'packages'), { recursive: true })
    for (const report of reports) {
        const fileName = packageLabel(report)
            .replace(/^@/, '')
            .replace(/\//g, '__')
            .replace(/[^A-Za-z0-9._@-]/g, '_')
        writeFileSync(
            join(options.out, 'packages', `${fileName}.md`),
            packageMarkdown(report, environment),
        )
    }
    const summary = summaryMarkdown(reports, environment, options)
    writeFileSync(join(options.out, 'summary.md'), summary)
    writeFileSync(
        join(options.out, 'results.json'),
        `${JSON.stringify({ environment, scope: options.scope || null, reports: reports.map(({ projectRoot, ...report }) => report) }, null, 2)}\n`,
    )
    if (options.summary)
        writeFileSync(options.summary, `${summary}${EOL}`, { flag: 'a' })

    const failed = reports.filter((report) => report.result.startsWith('fail_'))
    if (process.env.GITHUB_ACTIONS === 'true') {
        // One annotation per failed package, so a run that reports rather
        // than fails still shows what broke on its summary page.
        const level = options.mode === 'abort_on_error' ? 'error' : 'warning'
        for (const report of failed) {
            console.log(
                `::${level} title=npm consumer smoke (node ${process.version})::${packageLabel(report)} — ${RESULTS[report.result]}`,
            )
        }
    }
    if (options.outputs) {
        writeFileSync(
            options.outputs,
            [
                `tested=${reports.length}`,
                `failed=${failed.length}`,
                `failed_packages=${failed.map(packageLabel).join(' ')}`,
                '',
            ].join(EOL),
            { flag: 'a' },
        )
    }

    if (options.keep) console.log(`Consumer projects kept under ${root}`)
    else rmSync(root, { recursive: true, force: true })

    console.log(
        `\n${failed.length} of ${reports.length} package(s) failed. Report: ${options.out}`,
    )
    if (failed.length > 0 && options.mode === 'abort_on_error') process.exit(1)
}

await main()
