#!/usr/bin/env bash
set -euo pipefail

# Sync the canonical caller workflow templates into one or more consumer
# repositories. The thin trigger workflows (dispatch-*, pr-checks, push-*)
# cannot be shared cross-repo by GitHub, so they are copied verbatim from
# templates/workflows/ with the template header swapped for a synced marker.
#
# Usage:
#   bin/sync-callers.sh [--chromatic] [--check] <path-to-consumer-repo> [<path> ...]
#
# --chromatic flips run_chromatic to true in the synced pr-checks and
# push-main callers, for repos whose projects have a chromatic script
# (requires the CHROMATIC_PROJECT_TOKEN repository secret).
#
# --check writes nothing and exits non-zero if a consumer workflow has
# drifted from its template. The secret contract lives in the templates, so
# a drifted consumer is a consumer that can start failing at workflow
# startup with zero jobs — see templates/README.md.
#
# Example (all repos cloned side by side):
#   bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
#   bin/sync-callers.sh --chromatic ../gbt-monorepov2
#   bin/sync-callers.sh --check ../snailicid3

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates/workflows"

[[ -d "$TEMPLATE_DIR" ]] || {
    echo "error: template directory not found: $TEMPLATE_DIR" >&2
    exit 1
}

ENABLE_CHROMATIC=false
CHECK_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --chromatic)
            ENABLE_CHROMATIC=true
            shift
            ;;
        --check)
            CHECK_ONLY=true
            shift
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "error: unknown option: $1" >&2
            exit 1
            ;;
        *) break ;;
    esac
done

[[ $# -ge 1 ]] || {
    echo "usage: bin/sync-callers.sh [--chromatic] [--check] <path-to-consumer-repo> [<path> ...]" >&2
    exit 1
}

SYNC_HEADER='# ─────────────────────────────────────────────────────────────
# SYNCED from gbtunney/snailicid3-actions/templates/workflows — do not edit
# here. Change the template and re-run bin/sync-callers.sh.
# ─────────────────────────────────────────────────────────────'

# Render one template to stdout exactly as it should appear in a consumer.
render() {
    local template="$1"
    local name
    name="$(basename "$template")"

    {
        printf '%s\n' "$SYNC_HEADER"
        # Drop the template's own header block (first comment ruler pair).
        awk 'BEGIN{skip=1} skip && /^# ─/{count++; if(count==2){skip=0}; next} skip && /^#/{next} {print}' "$template"
    } | if [[ "$ENABLE_CHROMATIC" == "true" && ("$name" == "pr-checks.yml" || "$name" == "push-main.yml") ]]; then
        sed 's/run_chromatic: false/run_chromatic: true/'
    else
        cat
    fi
}

drift=0

for repo in "$@"; do
    target="$repo/.github/workflows"

    [[ -d "$target" ]] || {
        echo "error: not a repo with workflows: $repo" >&2
        exit 1
    }

    for template in "$TEMPLATE_DIR"/*.yml; do
        name="$(basename "$template")"

        if [[ "$CHECK_ONLY" == "true" ]]; then
            if [[ ! -f "$target/$name" ]]; then
                echo "missing  $name in $target"
                drift=1
            elif ! render "$template" | diff -u --label "template/$name" --label "$target/$name" - "$target/$name"; then
                echo "drifted  $name in $target"
                drift=1
            else
                echo "in sync  $name in $target"
            fi
            continue
        fi

        render "$template" > "$target/$name"
        echo "synced $name -> $target"
    done
done

if [[ "$CHECK_ONLY" == "true" && "$drift" -ne 0 ]]; then
    echo "error: consumer workflows have drifted from templates/workflows; re-run bin/sync-callers.sh" >&2
    exit 1
fi
