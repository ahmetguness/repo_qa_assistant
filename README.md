# Repo QA Assistant

An AI-powered code analysis tool that connects to Bitbucket Cloud and public GitHub repositories, indexes your codebase, and lets anyone on your team ask questions in natural language — no technical expertise required.

Built for teams. One deployment, everyone signs in with their own Bitbucket account. Public GitHub repos can be analyzed without any login.

## Features

**Core**
- Bitbucket OAuth 2.0 — secure sign-in, each user sees only their own repos
- Public GitHub repo analysis — paste any GitHub URL, no auth needed
- Automatic repository indexing — files, commits, PRs, and branches cached in PostgreSQL
- AI-powered analysis — ask questions in plain language, get detailed technical breakdowns
- Streaming responses — answers appear word by word, can be stopped mid-stream
- Smart context — AI receives only relevant files based on your question, not the entire repo

**Chat**
- Per-repo conversations — each chat is scoped to one repository
- Persistent chat history — stored in PostgreSQL, survives page reloads
- Folders — organize chats with drag-and-drop, rename, delete (with confirmation)
- Search — filter conversations by title or repo name
- Edit & resend — modify your last message and get a new response
- Regenerate — retry any AI response with one click
- Stop generation — halt streaming responses mid-sentence
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
- Collapsible sidebar (desktop toggle + mobile overlay)
- Repo info card (click repo name in header for stats)
- Clickable repo names in AI responses
- GitHub icon for GitHub repos, Bitbucket icon for Bitbucket repos in sidebar
- Custom right-click context menus
- Mobile responsive

**Security**
- AES-256-GCM token encryption in database
- Security headers (X-Frame-Options, CSP, XSS protection)
- Per-user and per-IP rate limiting
- Input validation and length limits on all endpoints
- Resource limits (max 500 sessions, 50 folders per user)
- No caching of API responses with sensitive data

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Auth | NextAuth v5 (Bitbucket OAuth 2.0) |
| AI | OpenAI GPT-4o-mini (streaming SSE) |
| Styling | Tailwind CSS |
| Markdown | react-markdown + rehype-highlight |
| Encryption | Node.js crypto (AES-256-GCM) |

## How It Works

```
┌──────────────────┐     ┌──────────────┐     ┌────────────┐
│  Bitbucket repo   │────▶│  Bitbucket   │────▶│ PostgreSQL │
│  (user selects)   │     │  REST API    │     │  (cached)  │
└──────────────────┘     └──────────────┘     └─────┬──────┘
                                                     │
┌──────────────────┐     ┌──────────────┐           │
│  GitHub repo      │────▶│  GitHub API  │───────────┤
│  (paste URL)      │     │  (public)    │           │
└──────────────────┘     └──────────────┘           │
                                                     │
┌──────────────────┐     ┌──────────────┐           │
│  User asks        │────▶│  Read from   │◀──────────┘
│  a question       │     │  DB + OpenAI │
└──────────────────┘     └──────────────┘
```

- Repo data is fetched once and cached locally
- Chat requests never call Bitbucket/GitHub directly — only the local database
- AI context is built dynamically based on the question type

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A Bitbucket Cloud workspace (for Bitbucket repos)
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

# GitHub (optional — increases rate limit from 60 to 5000 req/hour)
GITHUB_TOKEN=""
```

### 3. Create Bitbucket OAuth Consumer

> The OAuth Consumer is the *application's* identity, not a user's. Create it once, all users sign in through it with their own accounts.

1. Go to any Bitbucket workspace → **Settings** → **OAuth consumers** → **Add consumer**
2. Fill in:
   - **Name**: Repo QA Assistant
   - **Callback URL**: `http://localhost:3000/api/auth/callback/bitbucket`
   - **Permissions**: Account (Read), Repositories (Read), Pull Requests (Read)
3. Save → copy the **Key** and **Secret** into `.env`

The Consumer can be created in any workspace. Users from *any* workspace can sign in — they see repos based on their own Bitbucket permissions.

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

### Bitbucket Repos
1. Sign in with your Bitbucket account
2. Select a repo from the dropdown (top-right)
3. Ask questions

### Public GitHub Repos
1. On the home screen, paste a GitHub URL in the "Public GitHub reposu analiz et" input
2. Click "Analiz Et" — the repo is indexed automatically
3. A new chat opens, scoped to that repo

### Example Questions

| Question | What you get |
|----------|-------------|
| "What does this project do?" | Project overview from README + code |
| "Show the file structure" | Visual tree of all files |
| "Explain the database schema" | Prisma schema / migration breakdown |
| "Summarize recent commits" | Commit history with changed files |
| "List open PRs" | PR overview with branch info |
| "Explain auth.ts" | File analysis with import tracing |
| "What technologies are used?" | Stack analysis from package.json |
| "Give me a detailed report" | Full 9-section technical analysis |

## Team Deployment (10+ users)

One deployment serves everyone. No per-user setup required.

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
4. Sees only the repos they have access to
5. No setup required from users — just sign in and ask

### Cost estimate

| Item | Cost |
|------|------|
| VPS (4GB) | ~$10-20/month |
| OpenAI (gpt-4o-mini, 10 users) | ~$5-20/month |
| PostgreSQL | Free (local on VPS) |
| SSL | Free (Let's Encrypt) |

### Production deployment

```bash
npm run build
npx prisma migrate deploy
npm start  # or: pm2 start npm --name repoqa -- start
```

Update `.env`:
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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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
│   │   ├── github/analyze/       # Public GitHub repo indexing
│   │   ├── repos/                # Repo list, sync, stats
│   │   └── workspaces/           # Workspace discovery
│   ├── login/                    # Login page
│   └── page.tsx                  # Main app (auth-gated)
├── components/
│   ├── Chatbot.tsx               # Core orchestrator
│   ├── ChatInput.tsx             # Input with stop button
│   ├── ChatMessage.tsx           # Markdown, copy, regenerate, edit
│   ├── GitHubInput.tsx           # GitHub URL input
│   ├── RepoSelector.tsx          # Workspace/repo picker
│   ├── RepoInfoCard.tsx          # Repo stats popup
│   └── Sidebar.tsx               # History, folders, search, drag-drop
├── middleware.ts                  # Security headers
└── lib/
    ├── auth.ts                   # NextAuth config
    ├── auth-adapter.ts           # Custom Prisma adapter (with encryption)
    ├── bitbucket.ts              # Bitbucket API client
    ├── encryption.ts             # AES-256-GCM token encryption
    ├── get-access-token.ts       # Token management + auto-refresh
    ├── github.ts                 # GitHub public API client
    ├── github-indexer.ts         # GitHub repo indexing service
    ├── indexer.ts                # Bitbucket repo indexing service
    ├── prisma.ts                 # Prisma singleton
    ├── rate-limit.ts             # In-memory rate limiter
    └── types.ts                  # Shared types
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | Authenticated Bitbucket users |
| `accounts` | Encrypted OAuth tokens (access + refresh) |
| `sessions` | Active login sessions |
| `workspaces` | Bitbucket workspaces |
| `repositories` | Indexed repos (Bitbucket + GitHub) |
| `repo_files` | Cached file contents (max 500KB each) |
| `repo_commits` | Commit history with changed file paths |
| `repo_pull_requests` | PRs with diff stats |
| `repo_branches` | Branch list |
| `chat_folders` | User-created folders (max 50/user) |
| `chat_sessions` | Conversations scoped to repo (max 500/user) |
| `chat_messages` | Individual messages |

## Security

### Token Storage
- OAuth tokens encrypted with AES-256-GCM before database storage
- Encryption key derived from `AUTH_SECRET` via SHA-256
- Backward compatible — reads both encrypted and legacy plaintext tokens

### HTTP Security
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cache-Control: no-store` on all API responses

### Rate Limiting
| Endpoint | Limit |
|----------|-------|
| `/api/chat` | 20 req/min per user |
| `/api/github/analyze` | 5 req/min per IP |
| `/api/repos/sync` | 10 req/min per user |
| Other endpoints | 60 req/min |

### Input Validation
- Chat messages: max 10,000 characters
- Session titles: max 200 characters
- Folder names: max 100 characters
- GitHub URLs: validated format + max 200 characters
- Repo/workspace params: max 100 characters

### Resource Limits
- Max 500 chat sessions per user
- Max 50 folders per user
- Max 500KB per indexed file
- Conversation history trimmed to last 8 messages for AI context

## AI Context Strategy

The system analyzes the user's question and selects relevant data:

| User asks about... | Context sent to AI |
|--------------------|--------------------|
| Project overview | README + package.json + schema + file tree |
| Specific file | That file + its imports (up to 5 related files) |
| Commits | Last 20 commits with changed file paths |
| PRs | Last 15 PRs with descriptions and diff stats |
| Branches | Full branch list |
| API/routes | Route, controller, and service files |
| General question | README + config + schema + file tree + recent commits |

Total context budget: ~50K characters (~12K tokens).

## Bitbucket API Compatibility

Compatible with Bitbucket Cloud's post-CHANGE-2770 API (April 2026):
- Uses `/user/workspaces` instead of deprecated `/workspaces`
- Workspace-scoped `/repositories/{workspace}` for repo listing
- Branch names with `/` resolved to commit hashes via refs API
- File tree uses trailing slash format required by the src endpoint