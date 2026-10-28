<!-- Thanks for contributing! See CONTRIBUTING.md for setup and conventions. -->

## What and why

<!-- What this changes and why. Link the issue: "Fixes #123". -->

## How I tested it

<!-- The e2e specs you added or ran, plus any manual steps. -->

## Screenshots

<!-- For UI changes: before and after, in light and dark theme if colors are involved. Delete this section otherwise. -->

## Checklist

- [ ] `bun run build`, `bun run typecheck` and `bun run test` pass
- [ ] `bun run test:e2e` passes, and new behavior has an e2e test
- [ ] For `cli/` changes: `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and `cargo build` are clean
- [ ] Schema changes include a generated migration in `drizzle/`
- [ ] New data is only shown to people who can read it (see `src/server/access.ts`)
- [ ] The README is updated for changed commands, environment variables or behavior
