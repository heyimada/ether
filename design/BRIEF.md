# Ether UI directions, round 2: brief

## What Ether is

Ether is a self-hosted, invite-only code hosting platform for a small group of trusted people. Think GitHub or GitLab, scoped down. It is a **professional daily-driver tool** that developers keep open all day. It is not a concept piece, a themed art project or a marketing page.

The bar is what Linear, GitHub, Vercel and Stripe ship: calm, precise and dense where it helps, with obvious affordances and no gimmicks. Polish comes from:
- typography and alignment
- spacing rhythm
- state design: hover, focus, selected, disabled, empty and loading
- information hierarchy

It does not come from decoration.

## Real product facts (do not invent features that contradict these)

- **Accounts:** usernames. Sign-up is by one-time invite link only. An admin creates invites.
- **Repositories:** always private. The owner adds collaborators with a Read or Write role.
- **Git:** over HTTPS only. Clone URL format is `https://ether.example.ts.net/<owner>/<repo>.git`. Git authenticates with a personal access token, never the account password. There is no SSH, no CI and no status checks.
- **Network:** reachable only inside the owner's Tailscale tailnet. Never mention "Funnel", public access or "Sign in with GitHub".
- **Code browser:**
  - Branches and tags, including names with `/` such as `feature/invites`.
  - File tree, file view with syntax highlighting and line numbers, rendered README.
  - Commit history and commit diffs.
- **Issues and pull requests** share one number sequence per repository.
  - Issues have a title, a Markdown body, comments, and Open/Closed state.
  - Pull requests compare two branches in the same repo, with Conversation / Commits / Files changed tabs.
  - Merge creates a merge commit and is blocked when there are conflicts. There is no squash or rebase option.
  - There are no labels, assignees or reviewers yet. You may show labels as a near-future feature, but keep them subtle and optional.
- **Diffs:** unified or split view toggle, per-file headers with +/− counts.

## Sample data (use consistently, no lorem ipsum)

- **People:** `admin` (owner), `mira`, `jonas`, `kat`.
- **Repository:** `admin/ether-core`. Description: "Server, web client and git transport for Ether."
- **Branches:** `main` (default), `feature/invites`, `fix/session-rotation`. One tag: `v0.3.0`. 214 commits.
- **Latest commit:** mira, "Harden session cookie rotation on login", sha `3f9a1c2`, 2 hours ago.
- **Root files:**

  | Path | Last commit | Age | Size |
  |---|---|---|---|
  | `src/` | "Add invite token table and consume flow" | 2 hours ago | |
  | `e2e/` | "Cover expired invites in signup spec" | yesterday | |
  | `drizzle/` | "Migration 0004: invites table" | 2 hours ago | |
  | `README.md` | | 5 days ago | 4.2 KB |
  | `package.json` | | 3 days ago | 1.8 KB |
  | `tsconfig.json` | | 3 weeks ago | 612 B |

- **README:**
  - Heading "ether-core".
  - One paragraph.
  - A code block:
    ```sh
    bun install
    bun run build
    bun run ether create-admin <you> --password '...'
    bun run start
    ```
  - Three bullets.
- **Counts, which must agree everywhere:**
  - Issues: 5 open, 9 closed. The Issues tab badge shows 5.
  - Pull requests: 1 open. The tab badge shows 1.
  - PR #12 "Add invite-only registration" by admin wants to merge `feature/invites` into `main`. It has 3 commits and 4 files changed (+148 −31). It has two comments: mira asks about making the invite claim atomic, and admin replies that it's fixed. It is mergeable.
- **Diff excerpt:** `src/server/invites.ts` (+8 −2), with about 12 lines of realistic TypeScript. It makes the invite claim conditional on `usedAt IS NULL`.
- **Open issues:**

  | # | Title | Author | Opened |
  |---|---|---|---|
  | #21 | Session cookie survives logout in Safari | kat | 3 days ago |
  | #19 | Show file sizes in the tree on narrow screens | jonas | 4 days ago |
  | #17 | Clone hangs on packfiles over 200 MB | jonas | 5 days ago |
  | #14 | Invite link should show who invited you | mira | 1 week ago |
  | #11 | Document the backup command | admin | 2 weeks ago |

  Give them varied comment counts.

## Required screens (each in its own clearly labelled frame, ~1280px wide)

1. **Repository code view:**
   - Global header: logo, global navigation, search or Ctrl K, user menu.
   - Repository header with a Private indicator.
   - Repository tabs: Code, Issues 5, Pull requests 1, Settings.
   - Branch picker, latest-commit bar, file list and clone control.
   - Rendered README.
2. **Pull request:**
   - Title with `#12`, Open state, branch summary.
   - Tabs: Conversation, Commits 3, Files changed 4.
   - Timeline with the two comments.
   - Merge box, plus a comment composer.
   - One file's diff shown inline, or a small "Files changed" preview.
3. **Issues list:**
   - Open/Closed toggle with counts.
   - Search or filter input, New issue primary button, the five rows.
   - Pagination or footer.

**Also show at least two of these states somewhere,** labelled small:
- An empty state, such as "No closed issues match".
- A loading skeleton for the file list.
- A keyboard-focus ring on a control.
- The branch picker opened as a popover with a filter field.
- A conflict merge box.

## Quality bar (hard requirements)

- **One coherent design system per direction:**
  - 4/8px spacing scale.
  - Type scale with at least 4 steps.
  - One icon family drawn as consistent inline SVG: 1.5px stroke, 16px and 20px sizes, Lucide or Phosphor style.
  - One accent hue. Semantic colours (open, merged, closed, danger, add/remove diff) are separate from the accent.
- **Contrast:** 4.5:1 for text, 3:1 for UI glyphs and borders that carry meaning, in both light and dark.
- **Themes:** design both properly, not by inversion.
  - Tokens go on `:root`.
  - Redefine them for dark under `@media (prefers-color-scheme: dark)` with `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`.
  - Set an explicit body background.
- **States:**
  - Every interactive element has hover, focus-visible (2px ring, never removed), active and disabled states where relevant.
  - `cursor: pointer` on clickables.
  - Transitions of 120–200ms on colour and opacity only. Respect `prefers-reduced-motion`.
- **Meaning is never colour-only:** state badges carry an icon and a word, and diff lines carry +/− glyphs.
- **Each screen has exactly one primary action:** Merge on the PR page, New issue on the issues list, Clone or Code on the repo page.
- **Numbers:** tabular numerals for counts, sizes and line numbers. Monospace only for code, shas, paths and branch names.
- **Text:**
  - Body text 14px for this dense desktop tool, never below 12px for anything.
  - Line length of 75ch or less for prose such as the README and comments.
- **Responsive:**
  - Works at 375px with no horizontal page scroll.
  - Tables and diffs scroll inside their own container.
  - Navigation collapses sensibly.
- **Accessibility:** semantic HTML, visible labels on inputs, `aria-label` on icon-only buttons.
- **Copy:** sentence case and plain words. No emoji, no lorem ipsum, no marketing copy inside the app.
- **Files:** each file is self-contained HTML+CSS with tiny inline JS only if needed. Fonts only from Google Fonts with real fallbacks. No other external resources.
- **Header comment:** start each file with an HTML comment of 3–5 lines: the direction's name, layout model, palette, type, and what makes it distinct.

## Verification (required before you report)

Playwright and Chromium are installed in `C:\Users\Syrr\Documents\Projects\ether` (`node_modules/@playwright/test`).
- Write a small script in your own scratch location (not in the repo) that loads each of your files.
- Capture viewports 1280×900 and 375×800, each in `colorScheme: 'light'` and `'dark'`.
- Assert `document.documentElement.scrollWidth <= innerWidth`.
- Save screenshots to `C:\Users\Syrr\Documents\Projects\ether\design\mocks-v2\shots\<file>-<w>-<scheme>.png`.
- **Look at the screenshots** and fix what's off: misalignment, clipping, poor contrast, inconsistent spacing.
- Report honestly what you checked.

## Deliverable

Write files to `C:\Users\Syrr\Documents\Projects\ether\design\mocks-v2\NN-<slug>.html` with the numbers you were assigned. Touch nothing else in the repository.
