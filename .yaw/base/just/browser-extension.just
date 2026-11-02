# profiles/browser-extension: the uniform verbs (doc 01 §6). Verbs that do not apply print a note and exit 0.

# Node >= 22.13, then web-ext and the linters (npm install); .env from .env.example (devenv module).
setup:
    @node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 13)) { console.error(`Node >= 22.13 is required, found ${process.version}`); process.exit(1); }'
    npm install --no-audit --no-fund
    @if [ -f .env.example ] && [ ! -f .env ]; then cp .env.example .env && echo "setup: created .env from .env.example, fill in the values"; fi

# Load extension/ into a temporary browser profile and reload on change: firefox (default) or chromium.
dev target="firefox-desktop":
    npx web-ext run --source-dir extension --target {{target}}

fmt:
    @echo "fmt: not applicable for browser-extension (stylelint --fix is optional: npx stylelint --fix 'extension/**/*.css')"

lint:
    npx web-ext lint --source-dir extension
    npx html-validate extension
    npx stylelint 'extension/**/*.css'

typecheck:
    @echo "typecheck: not applicable for browser-extension"

# manifest.json is Manifest V3 and every file it names exists inside extension/ (no network).
test:
    node scripts/check-manifest.mjs

check: lint typecheck test audit sync-check

# The store package: dist/<name>-<version>.zip, the same file for the Chrome Web Store and addons.mozilla.org.
build:
    npx web-ext build --source-dir extension --artifacts-dir dist --overwrite-dest

# Only shipped dependencies: the extension is static files, web-ext and linters are dev tools (ADR-0034).
audit:
    npm audit --omit=dev
