# decisions module (ADR-0028): `just decisions <verb> ...` runs `yaw decisions <verb> ...`.
# verbs: recall "task" [--path f], record ..., query --text "...", list, rebuild, check, taxonomy [add ...], seed
[positional-arguments]
decisions *args:
    @if command -v yaw >/dev/null 2>&1; then yaw decisions "$@"; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" decisions "$@"; else echo "decisions: the YAW kit is not installed"; exit 1; fi

# Part of `check` (a gate, run by sync-check): record IDs are unique, records parse, the index matches them.
decisions-check:
    @if command -v yaw >/dev/null 2>&1; then yaw decisions check; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" decisions check; else echo "decisions-check: the YAW kit is not installed, the decision journal was not checked"; fi
