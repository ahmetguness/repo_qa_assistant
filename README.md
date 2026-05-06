# Repo QA Assistant

Repo QA Assistant is a team-focused AI code analysis app for Bitbucket Cloud and public GitHub repositories. It indexes repository metadata and selected source files into PostgreSQL, then answers questions with repo-aware context, file citations, API maps, dependency traces, and risk signals.

The goal is simple: pick a repository, ask a question, and get a precise technical answer without manually searching the codebase.

## Screenshots

Add screenshots here after capturing the app.

### Chat Workspace

![Chat workspace screenshot](docs/screenshots/chat-workspace.png)

Recommended capture: main chat view with sidebar, selected repo, streamed answer, and code citations.

### Repository Selection

![Repository selector screenshot](docs/screenshots/repository-selector.png)

Recommended capture: workspace/repo dropdown and sync progress banner.

### Public GitHub Analysis

![GitHub analysis screenshot](docs/screenshots/github-analysis.png)

Recommended capture: empty chat screen with GitHub URL input.

### Repo Insight Card

![Repo insight card screenshot](docs/screenshots/repo-info-card.png)

Recommended capture: repo name/header card with file, commit, branch, and PR stats.

## What It Does

- Signs users in with Bitbucket OAuth.
- Lets each user see only the Bitbucket workspaces and repositories they can access.
- Accepts public GitHub repository URLs without requiring GitHub login.
- Indexes repository files, commits, branches, and pull requests into PostgreSQL.
- Lets users ask natural-language questions about a selected repository.
- Streams AI answers in the chat UI.
- Stores chat sessions, messages, and folders in PostgreSQL.
- Builds targeted AI context instead of sending the entire repository blindly.

## Key Features

### Repository Analysis

- Bitbucket repository sync through the Bitbucket Cloud API.
- Public GitHub repository sync through the GitHub API and raw file endpoints.
- File tree extraction.
- Source file content indexing with size and extension filters.
- Commit history with changed-file paths.
- Pull request summaries with diff stats.
- Branch list indexing.

### AI Context Quality

The chat API builds a focused context package for every question:

- Repo profile and source map.
- API route map with HTTP methods.
- Prisma model summary.
- package.json script and dependency summary.
- Symbol/export map.
- Environment variable usage map.
- Import relationship map.
- Automatic risk signals.
- Query-matched evidence snippets with line numbers.
- Related imports and reverse dependents for selected files.
- Short-lived context cache for repeated questions.

This helps answers stay grounded in actual files instead of broad guesses.

### Chat

- Per-repo chat sessions.
- Persistent chat history.
- Sidebar folders.
- Search, rename, delete, and move chat sessions.
- Edit and resend user messages.
- Regenerate assistant responses.
- Stop streaming mid-answer.
- Copy full messages and code blocks.

### Security

- OAuth tokens are encrypted before being stored.
- Token encryption uses AES-256-GCM with a key derived from `AUTH_SECRET`.
- API responses use no-store cache headers.
- Input length limits are enforced.
- Per-user and per-IP rate limits are applied.
- Repository access checks are scoped to the authenticated user.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 App Router |
| Runtime UI | React 19 |
| Language | TypeScript |
| Database | PostgreSQL |
| ORM | Prisma |
| Auth | NextAuth v5 beta |
| OAuth provider | Bitbucket Cloud |
| AI | OpenAI API |
| Styling | Tailwind CSS 4 |
| Markdown | react-markdown, rehype-highlight |

## How It Works

```text
Bitbucket OAuth user
        |
        v
Workspace/repo discovery
        |
        v
Repo selected in chat
        |
        v
Bitbucket or GitHub API sync
        |
        v
PostgreSQL cache
        |
        v
Question-specific context builder
        |
        v
OpenAI streaming answer
        |
        v
Persisted chat history
```

Important detail: repositories are not cloned with `git clone`. The app reads repository data through Bitbucket/GitHub APIs and stores selected indexable content in PostgreSQL.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- OpenAI API key
- Bitbucket Cloud workspace, if using private Bitbucket repositories

### Install

```bash
git clone <repo-url>
cd repo_qa_assistant
npm install
```

### Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/qa_assistant?schema=public"

NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"
AUTH_SECRET="same-as-nextauth-secret"

AUTH_BITBUCKET_ID="your-bitbucket-oauth-key"
AUTH_BITBUCKET_SECRET="your-bitbucket-oauth-secret"

OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4.1"
OPENAI_FILE_SELECTOR_MODEL="gpt-4.1-mini"
AI_CONTEXT_CHARS="90000"

GITHUB_TOKEN=""
```

`GITHUB_TOKEN` is optional, but recommended for higher GitHub API rate limits.

### Create a Bitbucket OAuth Consumer

Create one OAuth consumer for the deployment:

1. Open Bitbucket Cloud.
2. Go to workspace settings.
3. Open OAuth consumers.
4. Add a consumer.
5. Use this callback URL locally:

```text
http://localhost:3000/api/auth/callback/bitbucket
```

Required permissions:

- Account: Read
- Repositories: Read
- Pull requests: Read

Copy the generated key and secret into `AUTH_BITBUCKET_ID` and `AUTH_BITBUCKET_SECRET`.

### Set Up the Database

```bash
createdb qa_assistant
npx prisma migrate dev
```

### Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Usage

### Bitbucket Repositories

1. Sign in with Bitbucket.
2. Select a workspace and repository.
3. Wait for the sync progress to finish.
4. Ask questions about architecture, APIs, auth, database models, files, commits, PRs, or risks.

### Public GitHub Repositories

1. Start from an empty chat.
2. Paste a public GitHub URL.
3. Click analyze.
4. Ask questions after indexing completes.

### Example Questions

| Question | Expected answer |
| --- | --- |
| What does this project do? | Repo summary grounded in README, package files, and source map |
| Explain the auth flow | Auth files, token handling, session flow, and risks |
| List API endpoints | Route map with HTTP methods and source files |
| Explain the database schema | Prisma models and relationships |
| Where is this function used? | File source plus import/dependent context |
| Summarize recent commits | Commit list and changed files |
| What are the production risks? | Security, reliability, and config risks with sources |
| Give me an onboarding report | Structured architecture and development overview |

## Repository Indexing Rules

The app indexes useful source and config files, and skips noisy or expensive files.

Usually indexed:

- TypeScript, JavaScript, Python, Go, Java, Rust, C#, PHP, Ruby
- React components
- JSON, YAML, TOML, XML
- Markdown and documentation
- Prisma schemas
- SQL
- Docker and environment examples

Usually skipped:

- `node_modules`
- `.git`
- `.next`
- `dist`
- `build`
- cache folders
- lock files
- minified files
- source maps
- files larger than 500 KB

## AI Context Strategy

The app does not send the entire repository to the model. For each question it:

1. Loads repository metadata.
2. Scores files against the user question.
3. Selects high-value candidate files.
4. Optionally asks a smaller model to refine file selection.
5. Hydrates only selected file contents from PostgreSQL.
6. Adds imports, reverse dependents, API maps, schema summaries, and evidence snippets.
7. Sends the final context to the configured OpenAI model.

This design improves speed, lowers token usage, and makes answers more precise.

## Project Structure

```text
src/
  app/
    api/
      auth/[...nextauth]/       NextAuth route handlers
      chat/                     Streaming AI chat and chat CRUD
      github/analyze/           Public GitHub indexing endpoint
      repos/                    Repo listing, sync, and stats
      workspaces/               Bitbucket workspace discovery
    login/                      Login page
    page.tsx                    Auth-gated main app
  components/
    Chatbot.tsx                 Main client-side orchestrator
    ChatInput.tsx               Message input and stop button
    ChatMessage.tsx             Markdown rendering and actions
    GitHubInput.tsx             Public GitHub URL input
    RepoInfoCard.tsx            Repo stats popover
    RepoSelector.tsx            Workspace/repo picker
    Sidebar.tsx                 Chat history and folders
  lib/
    auth.ts                     NextAuth config
    auth-adapter.ts             Custom Prisma adapter with token encryption
    bitbucket.ts                Bitbucket API client
    encryption.ts               AES-256-GCM helpers
    get-access-token.ts         Token refresh helper
    github.ts                   GitHub API client
    github-indexer.ts           GitHub indexing service
    indexer.ts                  Bitbucket indexing service
    prisma.ts                   Prisma singleton
    rate-limit.ts               In-memory rate limiter
    types.ts                    Shared UI types
prisma/
  schema.prisma                 Database schema
  migrations/                   Prisma migrations
```

## Database Tables

| Table | Purpose |
| --- | --- |
| `users` | Authenticated users |
| `accounts` | OAuth accounts and encrypted tokens |
| `sessions` | NextAuth sessions |
| `workspaces` | Bitbucket workspaces |
| `user_workspaces` | User to workspace access mapping |
| `repositories` | Bitbucket and GitHub repository records |
| `repo_files` | Indexed files and selected contents |
| `repo_commits` | Commit history |
| `repo_pull_requests` | Pull request metadata |
| `repo_branches` | Branch metadata |
| `chat_folders` | User folders |
| `chat_sessions` | Chat sessions scoped to repositories |
| `chat_messages` | Persisted messages |

## Scripts

```bash
npm run dev      # start local dev server
npm run build    # production build
npm start        # start production server
npm run lint     # run ESLint
```

Recommended verification before merging changes:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run build
```

## Production Deployment

1. Provision PostgreSQL.
2. Set production environment variables.
3. Set `NEXTAUTH_URL` to the deployed HTTPS URL.
4. Update the Bitbucket OAuth callback URL:

```text
https://your-domain.com/api/auth/callback/bitbucket
```

5. Apply migrations:

```bash
npx prisma migrate deploy
```

6. Build and start:

```bash
npm run build
npm start
```

## Operational Notes

- Current rate limiting is in-memory. For multi-instance production, replace it with Redis or another shared store.
- Repository sync runs during API requests today. For very large repositories, a background job queue would improve reliability.
- Public GitHub analysis is intentionally unauthenticated, but should be protected with stricter abuse controls in public deployments.
- AI quality depends heavily on indexed file coverage and the configured OpenAI model.

## Development With Aider

This repository includes optional Aider guidance:

- `.aider.conf.yml`
- `.aiderignore`
- `AIDER.md`

Use Aider for small, scoped patches. Avoid using it for broad rewrites, auth/security changes, or Prisma migrations without careful review.
