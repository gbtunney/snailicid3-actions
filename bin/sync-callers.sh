#!/usr/bin/env bash
set -euo pipefail

# Sync the canonical caller workflow templates into one or more consumer
# repositories. The thin trigger workflows (dispatch-*, pr-checks, push-*)
# cannot be shared cross-repo by GitHub, so they are copied verbatim from
# templates/workflows/ with the template header swapped for a synced marker.
#
# Usage:
#   bin/sync-callers.sh [--check] <path-to-consumer-repo> [<path> ...]
#
# --check writes nothing and exits non-zero if a consumer workflow has
# drifted from its template, or if a consumer still carries a synced workflow
# whose template no longer exists. The secret contract lives in the templates,
# so a drifted consumer — and an obsolete caller holding the *old* contract
# forever — is a consumer that can start failing at workflow startup with zero
# jobs. See templates/README.md.
#
# Example (all repos cloned side by side):
#   bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
#   bin/sync-callers.sh --check ../snailicid3

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates/workflows"

[[ -d "$TEMPLATE_DIR" ]] || {
    echo "error: template directory not found: $TEMPLATE_DIR" >&2
    exit 1
}

CHECK_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
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
    echo "usage: bin/sync-callers.sh [--check] <path-to-consumer-repo> [<path> ...]" >&2
    exit 1
}

# The marker identifies a file as generated, so --check can find synced
# workflows whose template has since been deleted or renamed. Keep it and the
# header below in one place — a drifted marker makes orphans undetectable.
SYNC_MARKER='SYNCED from gbtunney/snailicid3-actions/templates/workflows'

SYNC_HEADER="# ─────────────────────────────────────────────────────────────
# ${SYNC_MARKER} — do not edit
# here. Change the template and re-run bin/sync-callers.sh.
# ─────────────────────────────────────────────────────────────"

# Render one template to stdout exactly as it should appear in a consumer.
render() {
    local template="$1"
    {
        printf '%s\n' "$SYNC_HEADER"
        # Drop the template's own header block (first comment ruler pair).
        awk 'BEGIN{skip=1} skip && /^# ─/{count++; if(count==2){skip=0}; next} skip && /^#/{next} {print}' "$template"
    }
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

    # A template that was deleted or renamed leaves its generated copy behind
    # in every consumer, still wired to the contract it was generated from.
    # Looping over templates alone can never see that file.
    while IFS= read -r -d '' synced; do
        name="$(basename "$synced")"

        if [[ -f "$TEMPLATE_DIR/$name" ]]; then
            continue
        fi

        if [[ "$CHECK_ONLY" == "true" ]]; then
            echo "orphaned $name in $target (no matching template — delete it)"
            drift=1
        else
            echo "warning: $name in $target has no matching template; delete it by hand" >&2
        fi
    done < <(grep -rlZ --include='*.yml' --include='*.yaml' -- "$SYNC_MARKER" "$target" 2> /dev/null || true)
done

if [[ "$CHECK_ONLY" == "true" && "$drift" -ne 0 ]]; then
    echo "error: consumer workflows have drifted from templates/workflows; re-run bin/sync-callers.sh" >&2
    exit 1
fi
