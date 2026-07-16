#!/usr/bin/env bash
set -euo pipefail

# Sync the canonical caller workflow templates into one or more consumer
# repositories. The thin trigger workflows (dispatch-*, pr-checks, push-*)
# cannot be shared cross-repo by GitHub, so they are copied verbatim from
# templates/workflows/ with the template header swapped for a synced marker.
#
# Usage:
#   bin/sync-callers.sh [--chromatic] <path-to-consumer-repo> [<path> ...]
#
# --chromatic flips run_chromatic to true in the synced pr-checks and
# push-main callers, for repos whose projects have a chromatic script
# (requires the CHROMATIC_PROJECT_TOKEN repository secret).
#
# Example (all repos cloned side by side):
#   bin/sync-callers.sh ../snailicid3 ../gbt-template-boilerplate ../gbt-schema-form
#   bin/sync-callers.sh --chromatic ../gbt-monorepov2

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates/workflows"

[[ -d "$TEMPLATE_DIR" ]] || {
    echo "error: template directory not found: $TEMPLATE_DIR" >&2
    exit 1
}

ENABLE_CHROMATIC=false
if [[ "${1:-}" == "--chromatic" ]]; then
    ENABLE_CHROMATIC=true
    shift
fi

[[ $# -ge 1 ]] || {
    echo "usage: bin/sync-callers.sh [--chromatic] <path-to-consumer-repo> [<path> ...]" >&2
    exit 1
}

SYNC_HEADER='# ─────────────────────────────────────────────────────────────
# SYNCED from gbtunney/snailicid3-actions/templates/workflows — do not edit
# here. Change the template and re-run bin/sync-callers.sh.
# ─────────────────────────────────────────────────────────────'

for repo in "$@"; do
    target="$repo/.github/workflows"

    [[ -d "$target" ]] || {
        echo "error: not a repo with workflows: $repo" >&2
        exit 1
    }

    for template in "$TEMPLATE_DIR"/*.yml; do
        name="$(basename "$template")"

        {
            printf '%s\n' "$SYNC_HEADER"
            # Drop the template's own header block (first comment ruler pair).
            awk 'BEGIN{skip=1} skip && /^# ─/{count++; if(count==2){skip=0}; next} skip && /^#/{next} {print}' "$template"
        } > "$target/$name"

        if [[ "$ENABLE_CHROMATIC" == "true" && ( "$name" == "pr-checks.yml" || "$name" == "push-main.yml" ) ]]; then
            sed -i.bak 's/run_chromatic: false/run_chromatic: true/' "$target/$name"
            rm -f "$target/$name.bak"
        fi

        echo "synced $name -> $target"
    done
done
