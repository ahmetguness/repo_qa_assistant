# Aider Workflow

Use aider for small, scoped patches in this repo. Prefer Codex or manual review for broad architecture, auth, database schema, migrations, and security-sensitive changes.

## Good tasks

- Fix a focused bug in one or a few files.
- Add or update tests.
- Clean up lint or TypeScript errors.
- Refactor a component or route without changing behavior.
- Improve copy, prompts, or small UI states.

## Risky tasks

- Next.js 16 APIs without first checking `node_modules/next/dist/docs/`.
- NextAuth, token encryption, OAuth refresh, and authorization logic.
- Prisma schema or migration changes.
- Large multi-module rewrites.
- Changes touching `.env`, `.repo_cache`, `backup`, generated output, or lock files.

## Suggested commands

Start with explicit files:

```bash
aider src/components/Chatbot.tsx src/app/api/chat/route.ts
```

After every aider change, run:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
```

## Prompt style

Give aider narrow instructions:

```text
Fix the first-message local session state bug in Chatbot.tsx. Keep the diff small.
Do not change unrelated UI, API contracts, or auth behavior.
```

Avoid broad prompts like:

```text
Improve the whole app.
Refactor everything.
Make the AI perfect.
```

## Repo-specific rules

- This is Next.js 16. Read the relevant docs in `node_modules/next/dist/docs/` before changing Next APIs.
- Preserve existing TypeScript strictness.
- Keep user data access scoped to the authenticated user.
- Do not bypass lint/build failures by disabling rules globally.
- Keep generated/cache folders out of edits.
