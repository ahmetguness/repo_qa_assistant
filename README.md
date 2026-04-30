# Repo QA Assistant

An AI-powered code analysis tool that connects to your Bitbucket Cloud account, indexes your repositories, and lets anyone on your team ask questions about the codebase in natural language — no technical expertise required.

Built with Next.js, PostgreSQL, and OpenAI GPT-4o.

## Features

- **Bitbucket OAuth 2.0** — Secure authentication with granular read-only permissions
- **Automatic repository indexing** — Files, commits, pull requests, and branches are synced and cached in PostgreSQL
- **AI-powered code analysis** — Ask questions in plain language, get detailed technical breakdowns
- **Clickable repo names** — AI responses include interactive repo links for quick navigation
- **Markdown rendering** — Responses include syntax-highlighted code blocks, tables, and structured formatting
- **Session-based chat history** — Conversations are preserved across page reloads
- **Smart context building** — README and config files are prioritized; file tree is rendered as a visual hierarchy
- **Branch-aware** — Handles complex branch names (including `/` separators) via commit hash resolution
- **Dark theme** — Purpose-built dark UI optimized for code readability

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Auth | NextAuth v5 (Bitbucket OAuth 2.0) |
| AI | OpenAI GPT-4o |
| Styling | Tailwind CSS |

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A Bitbucket Cloud account
- An OpenAI API key

### Installation

```bash
git clone <repo-url>
cd repo-qa-assistant
npm install
```

### Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

```env
# Database
DATABASE_URL="postgresql://postgres:password@localhost:5432/qa_assistant?schema=public"

# Auth (generate secret: openssl rand -base64 32)
NEXTAUTH_SECRET="your-random-secret"
AUTH_SECRET="your-random-secret"

# Bitbucket OAuth
AUTH_BITBUCKET_ID="your-client-id"
AUTH_BITBUCKET_SECRET="your-client-secret"

# OpenAI
OPENAI_API_KEY="sk-..."
```

### Bitbucket OAuth Setup

1. Go to your **Bitbucket Workspace Settings** → **OAuth consumers** → **Add consumer**
2. Set the **Callback URL** to `http://localhost:3000/api/auth/callback/bitbucket`
3. Grant the following **permissions**:
   - Account — Read
   - Repositories — Read
   - Pull Requests — Read
4. Copy the **Key** and **Secret** into your `.env` file

### Database Setup

```bash
createdb qa_assistant
npx prisma migrate dev --name init
```

### Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Sign in with your Bitbucket account
2. Select a repository from the dropdown (top-right). The first selection triggers indexing and may take a few seconds.
3. Ask questions:

| Example | What it does |
|---------|-------------|
| "What does this project do?" | High-level project overview |
| "Give me a detailed analysis" | Full 9-section technical report |
| "Show the file structure" | Visual tree of all indexed files |
| "Explain the database schema" | Prisma schema / migration analysis |
| "Summarize recent commits" | Commit history with changed files |
| "List open PRs" | Pull request overview with branch info |
| "Explain the auth flow" | Traces authentication logic across files |

You can also type a repo name directly in chat — it will be auto-detected and selected.

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/   # OAuth endpoints
│   │   ├── chat/                 # AI chat (DB read only, no external API calls)
│   │   ├── repos/                # Repository list + sync trigger
│   │   └── workspaces/           # Workspace discovery
│   ├── login/                    # Login page
│   └── page.tsx                  # Main app (auth-gated)
├── components/
│   ├── Chatbot.tsx               # Core chat orchestrator
│   ├── ChatInput.tsx             # Message input with auto-resize
│   ├── ChatMessage.tsx           # Message bubble with markdown + clickable repos
│   ├── RepoSelector.tsx          # Workspace/repo picker dropdown
│   └── Sidebar.tsx               # Chat session history panel
└── lib/
    ├── auth.ts                   # NextAuth configuration
    ├── auth-adapter.ts           # Custom Prisma adapter for NextAuth
    ├── bitbucket.ts              # Bitbucket REST API client
    ├── get-access-token.ts       # Token management with auto-refresh
    ├── indexer.ts                # Repository indexing service
    ├── prisma.ts                 # Prisma client singleton
    └── types.ts                  # Shared TypeScript types
```

### Data Flow

```
User selects repo → /api/repos/sync → Bitbucket API → PostgreSQL (cached)
User sends message → /api/chat → Read from PostgreSQL → OpenAI GPT-4o → Response
```

Chat requests never call the Bitbucket API directly. All repository data is read from the local database, keeping response times fast after the initial sync.

### Database Schema

| Table | Purpose |
|-------|---------|
| `users` | Authenticated Bitbucket users |
| `accounts` | OAuth tokens (access + refresh) |
| `sessions` | Active user sessions |
| `workspaces` | Bitbucket workspaces |
| `repositories` | Indexed repositories with metadata |
| `repo_files` | File contents (cached, max 500KB per file) |
| `repo_commits` | Commit history with changed file paths |
| `repo_pull_requests` | Pull requests with diff stats |
| `repo_branches` | Branch list with head commit hashes |
| `chat_sessions` | Conversation sessions |
| `chat_messages` | Individual chat messages |

### Indexing Strategy

- Repositories are synced lazily — only when selected by a user
- File contents are cached with a **1-hour cooldown** before re-sync
- Files larger than **500KB** are skipped (binary assets, lock files)
- Supported file types: source code, config, markdown, Docker, CI/CD, SQL, and more
- Branch names containing `/` are resolved to commit hashes via the Bitbucket refs API

### AI Context Building

When a user asks a question, the system builds a context payload for GPT-4o with the following priority:

1. **README files** — always included in full (up to 10K chars)
2. **Config/dependency files** — `package.json`, `Dockerfile`, `schema.prisma`, etc. (up to 5K chars each)
3. **Source code files** — remaining files up to the 100K character context budget
4. **Commit history** — last 30 commits with changed file paths
5. **Pull requests** — last 20 PRs with diff stats
6. **Branch list** — all branches with default branch highlighted

## Deployment

### Production Build

```bash
npm run build
npx prisma migrate deploy
npm start
```

### Environment

Update `NEXTAUTH_URL` to your production domain. Ensure PostgreSQL is accessible from your server.

### Recommended Stack

- **VPS**: Any Linux server (Ubuntu 22.04+)
- **Database**: PostgreSQL 14+ (local or managed)
- **Process Manager**: PM2 or systemd
- **Reverse Proxy**: Nginx or Caddy

## License

Private — internal use only.
