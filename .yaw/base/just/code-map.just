# code-map module (ADR-0033): `just map <verb> ...` runs `yaw map <verb> ...`.
# verbs: update (refresh the generated sections and the local index), check (read-only), show [area]
[positional-arguments]
map *args:
    @if command -v yaw >/dev/null 2>&1; then yaw map "$@"; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" map "$@"; else echo "map: the YAW kit is not installed"; exit 1; fi

# Part of `check` (a gate, run by sync-check): docs/code-map.md matches the project structure.
map-check:
    @if command -v yaw >/dev/null 2>&1; then yaw map check; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" map check; else echo "map-check: the YAW kit is not installed, the code map was not checked"; fi
