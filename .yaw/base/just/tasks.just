# tasks module (ADR-0010): `just task <verb> ...` runs `yaw task <verb> ...`.
# verbs: list, next, start <id>, log <id> "text" [--resume "text"] [--progress n], done <id>, new "title", sync
[positional-arguments]
task *args:
    @if command -v yaw >/dev/null 2>&1; then yaw task "$@"; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" task "$@"; else echo "task: the YAW kit is not installed"; exit 1; fi
