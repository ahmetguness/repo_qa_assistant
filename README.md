# Repo QA Assistant

An AI-powered code analysis tool that connects to Bitbucket Cloud, indexes your repositories, and lets anyone on your team ask questions about the codebase in natural language — no technical expertise required.

Built for teams. One deployment, everyone signs in with their own Bitbucket account and sees only the repos they have access to.

## Features

**Core**
- Bitbucket OAuth 2.0 — secure sign-in, each user sees only their own repos
- Automatic repository indexing — files, commits, PRs, and branches cached in PostgreSQL
- AI-powered analysis — ask questions in plain language, get detailed technical breakdowns
- Streaming responses — answers appear word by word, can be stopped mid-stream
- Smart context — AI receives only relevant files based on your question, not the entire repo

**Chat**
- Per-repo conversations — each chat is scoped to one repository
- Persistent chat history — stored in PostgreSQL, survives page reloads
- Folders — organize chats with drag-and-drop, rename, delete
- Search — filter conversations by title or repo name
- Regenerate — retry any AI response with one click
- Copy buttons — copy full messages or individual code blocks

**Code Analysis**
- Syntax-highlighted code blocks (GitHub Dark theme)
- File tree visualization
- Import/dependency tracing — when you ask about a file, related imports are included
- Commit history with changed file paths
- PR analysis with diff stats
- Branch listing

**UI/UX**
- Dark theme optimized for code readability
- Collapsible sidebar
- Repo info card (click repo name in header)
- Clickable repo names in AI responses
- Mobile responsive
- Custom right-click menus

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Auth | NextAuth v5 (Bitbucket OAuth 2.0) |
| AI | OpenAI GPT-4o-mini (streaming) |
| Styling | Tailwind CSS |
| Markdown | react-markdown + rehype-highlight |

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│  User picks  │────▶│  Bitbucket   │────▶│ PostgreSQL │
│  a repo      │     │  REST API    │     │  (cached)  │
└─────────────┘     └──────────────┘     └─────┬──────┘
                                                │
┌─────────────┐     ┌──────────────┐           │
│  User asks   │────▶│  Read from   │◀──────────┘
│  a question  │     │  DB + OpenAI │
└─────────────┘     └──────────────┘
```

- Repo data is fetched from Bitbucket once and cached locally
- Chat requests never call Bitbucket directly — only the local database
- AI context is built dynamically based on the question (commits, PRs, specific files, etc.)

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A Bitbucket Cloud workspace
- An OpenAI API key

### 1. Install

```bash
git clone <repo-url>
cd repo-qa-assistant
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Database
DATABASE_URL="postgresql://postgres:password@localhost:5432/qa_assistant?schema=public"

# Auth secrets (generate: openssl rand -base64 32)
NEXTAUTH_SECRET="your-random-secret"
AUTH_SECRET="your-random-secret"

# Bitbucket OAuth Consumer (see below)
AUTH_BITBUCKET_ID="your-consumer-key"
AUTH_BITBUCKET_SECRET="your-consumer-secret"

# OpenAI
OPENAI_API_KEY="sk-..."
```

### 3. Create Bitbucket OAuth Consumer

> **Important**: The OAuth Consumer is the *application's* identity, not a user's. You create it once, and all users sign in through it with their own Bitbucket accounts.

1. Go to any Bitbucket workspace → **Settings** → **OAuth consumers** → **Add consumer**
2. Fill in:
   - **Name**: Repo QA Assistant
   - **Callback URL**: `http://localhost:3000/api/auth/callback/bitbucket`
   - **Permissions**: Account (Read), Repositories (Read), Pull Requests (Read)
3. Save → copy the **Key** and **Secret** into `.env`

The Consumer can be created in any workspace. Users from *any* workspace can sign in — they'll see repos based on their own Bitbucket permissions, not the Consumer's workspace.

### 4. Set Up Database

```bash
createdb qa_assistant
npx prisma migrate dev --name init
```

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. **Sign in** with your Bitbucket account
2. **Select a repo** from the dropdown (top-right) — first selection triggers indexing
3. **Ask questions**:

| Question | What you get |
|----------|-------------|
| "What does this project do?" | Project overview from README + code analysis |
| "Show the file structure" | Visual tree of all files |
| "Explain the database schema" | Prisma schema / migration breakdown |
| "Summarize recent commits" | Commit history with changed files |
| "List open PRs" | PR overview with branch info and diff stats |
| "Explain auth.ts" | File analysis with import tracing |
| "What technologies are used?" | Stack analysis from package.json + code |
| "Give me a detailed report" | Full 9-section technical analysis |

You can also type a repo name in chat — it auto-detects and opens a new conversation for that repo.

## Team Deployment (10+ users)

This is designed for team use. One deployment serves everyone.

### What you need

- 1 VPS (Ubuntu 22.04+, 4GB RAM)
- PostgreSQL (on the same VPS or managed)
- 1 Bitbucket OAuth Consumer (created once by an admin)
- 1 OpenAI API key (shared, billed to company)
- Domain + SSL (Nginx + Let's Encrypt)

### How it works for users

1. Admin deploys the app and configures `.env` on the server
2. Each team member goes to `https://repoqa.company.com`
3. Clicks "Sign in with Bitbucket"
4. Sees only the repos they have access to in Bitbucket
5. No setup required from users — just sign in and ask

### Security model

- Users authenticate with their own Bitbucket accounts
- Each user can only see repos their Bitbucket account has access to
- OAuth tokens are stored per-user in the database
- Token refresh is automatic
- `.env` secrets stay on the server, never exposed to users
- All repo data access is read-only

### Cost estimate

| Item | Cost |
|------|------|
| VPS (4GB) | ~$10-20/month |
| OpenAI (gpt-4o-mini, 10 users) | ~$5-20/month |
| PostgreSQL | Free (local on VPS) |
| Bitbucket | Already have it |
| SSL | Free (Let's Encrypt) |

### Production deployment

```bash
npm run build
npx prisma migrate deploy
npm start  # or use PM2: pm2 start npm --name repoqa -- start
```

Update `.env` on the server:
```env
NEXTAUTH_URL="https://repoqa.company.com"
```

Nginx config:
```nginx
server {
    server_name repoqa.company.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/   # OAuth endpoints
│   │   ├── chat/                 # AI chat (streaming SSE)
│   │   │   ├── sessions/         # CRUD for chat sessions
│   │   │   └── folders/          # CRUD for chat folders
│   │   ├── repos/                # Repo list, sync, stats
│   │   └── workspaces/           # Workspace discovery
│   ├── login/                    # Login page
│   └── page.tsx                  # Main app (auth-gated)
├── components/
│   ├── Chatbot.tsx               # Core orchestrator (state, streaming, sessions)
│   ├── ChatInput.tsx             # Input with stop button
│   ├── ChatMessage.tsx           # Message with markdown, copy, regenerate
│   ├── RepoSelector.tsx          # Workspace/repo picker
│   ├── RepoInfoCard.tsx          # Repo stats popup
│   └── Sidebar.tsx               # History, folders, search, drag-drop
└── lib/
    ├── auth.ts                   # NextAuth config
    ├── auth-adapter.ts           # Custom Prisma adapter
    ├── bitbucket.ts              # Bitbucket API client (CHANGE-2770 compatible)
    ├── get-access-token.ts       # Token management + auto-refresh
    ├── indexer.ts                # Repo indexing (files, commits, PRs, branches)
    ├── prisma.ts                 # Prisma singleton
    └── types.ts                  # Shared types
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | Authenticated Bitbucket users |
| `accounts` | OAuth tokens (access + refresh, per user) |
| `sessions` | Active login sessions |
| `workspaces` | Bitbucket workspaces |
| `repositories` | Indexed repos with metadata |
| `repo_files` | Cached file contents (max 500KB each) |
| `repo_commits` | Commit history with changed file paths |
| `repo_pull_requests` | PRs with diff stats |
| `repo_branches` | Branch list |
| `chat_folders` | User-created folders |
| `chat_sessions` | Conversations (scoped to repo) |
| `chat_messages` | Individual messages |

## AI Context Strategy

The system doesn't dump the entire repo into the AI prompt. Instead, it analyzes the user's question and selects relevant data:

| User asks about... | Context sent to AI |
|--------------------|--------------------|
| Project overview | README + package.json + schema + file tree |
| Specific file | That file + its imports (up to 5 related files) |
| Commits | Last 20 commits with changed file paths |
| PRs | Last 15 PRs with descriptions and diff stats |
| Branches | Full branch list |
| API/routes | Route, controller, and service files |
| General question | README + config + schema + file tree + recent commits |

Total context budget: ~50K characters (~12K tokens), well within model limits.

## Bitbucket API Compatibility

This project is compatible with Bitbucket Cloud's post-CHANGE-2770 API (April 2026):
- Uses `/user/workspaces` instead of deprecated `/workspaces`
- Workspace-scoped `/repositories/{workspace}` for repo listing
- Branch names with `/` are resolved to commit hashes via refs API
- File tree uses trailing slash format required by the src endpoint

## License

Private — internal use only.
