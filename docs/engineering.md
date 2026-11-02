# Engineering practices

## Behavior and maintenance

- Unit tests are optional: the Quality reviewer must not require a unit-test suite or report its absence as findings.
- Test changed behavior, boundaries, failure paths and security-sensitive checks; add regression tests for bugs. Report what could not be tested.
- Keep user-facing errors concise, actionable and consistent. Never swallow errors silently; keep stack traces out of public errors. Use structured console logs; redact secrets and personal data.
- Keep setup, public contracts, non-obvious decisions and recovery instructions current; explain intent rather than restating code. Follow the stack formatter, linter and type checks; validate external inputs and use parameterized queries.

## Dependencies and runtime

- Do not add an application command wrapper; document native installation, running, checks and build commands.
- Prefer standard-library features; justify external dependencies. Do not invent cryptography or authentication.

Run `just check` before reporting completion.
