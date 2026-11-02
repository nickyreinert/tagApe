# justfile: composed by YAW. Stack recipes are imported from just/ (below); `just --list` shows them.
default:
    @just --list

# Agent adapter files (skills, hook settings, hook shim) match their source (ADR-0012). Part of `check`.
sync-check: decisions-check map-check
    @if command -v yaw >/dev/null 2>&1; then yaw sync --check; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" sync --check; else echo "sync-check: the YAW kit is not installed, agent adapter files were not checked"; fi

# yaw:browser-extension
import 'just/browser-extension.just'
# /yaw:browser-extension

# yaw:code-map
import 'just/code-map.just'
# /yaw:code-map

# yaw:decisions
import 'just/decisions.just'
# /yaw:decisions

# yaw:sessions
import 'just/sessions.just'
# /yaw:sessions

# yaw:tasks
import 'just/tasks.just'
# /yaw:tasks
