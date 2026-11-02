# sessions module (ADR-0029): `just sessions <verb> ...` runs `yaw sessions <verb> ...`.
# verbs: find "words", for <T-012|#34|ADR-0004|hash|file>, resume <id>, list, current, handoff [--title "..."]  (--all: every project)
[positional-arguments]
sessions *args:
    @if command -v yaw >/dev/null 2>&1; then yaw sessions "$@"; elif [ -f "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" ]; then node "${YAW_KIT:-$HOME/.yaw/kit}/bin/yaw" sessions "$@"; else echo "sessions: the YAW kit is not installed"; exit 1; fi
