# Repo QA Assistant

A Streamlit-based web application that analyzes GitHub and Bitbucket repositories using AI. It clones a repo, parses its code with AST-aware chunking, indexes it with RAG, and answers natural language questions about the codebase through OpenAI models.

## Features

### Repository Analysis
- Clones any public or private GitHub/Bitbucket repository
- AST-aware code parsing using tree-sitter (Python, TypeScript, JavaScript, Java, Go, Rust, C, C++, C#, Ruby)
- Semantic chunking that respects function and class boundaries instead of blind character splitting
- Vector search index using ChromaDB and OpenAI embeddings

### Pull Request Intelligence
- Lists open and closed/merged PRs with metadata
- Fetches full file contents from PR branches (even if not merged to main)
- Retrieves PR diffs with inline code changes
- Pulls review comments, approvals, and discussion threads
- Implicit PR detection: "son PR'daki dosyalar neler" automatically resolves to the latest PR

### Code Understanding
- File-level queries: reference a file by name and get its full content in context
- Multi-file references: "compare app.py and utils.py" loads both files
- Error trace parsing: paste a stack trace and the bot finds the relevant source files
- Fuzzy file matching: "test results" finds `test-results.md`, `test_results.md`, etc.

### Platform Support
- GitHub (REST API via PyGithub)
- Bitbucket Cloud (REST API 2.0)
- Bitbucket OAuth 2.0 login with automatic repo listing
- Auto-detection of platform from URL

### Adaptive Model Selection
- Simple questions route to `gpt-4o-mini`
- Complex analysis (architecture, security, refactoring) routes to `gpt-4o`
- Model and complexity mode displayed per response

### Session Management
- Conversation history saved to SQLite
- Load, delete, and export past sessions
- Markdown export for sharing or archiving
- Conversation summarization for long sessions to preserve context within token limits

### Sidebar Dashboard
- Repository summary: stars, forks, issues, open PRs
- Code health metrics: file count, line count, test ratio, dependency count
- Language distribution with visual progress bars
- Commit history and contributor activity

## Project Structure

```
repo_qa_assistant/
├── app.py                        # Streamlit UI and application logic
├── core/
│   ├── __init__.py
│   ├── ast_parser.py             # Tree-sitter AST parsing (10 languages)
│   ├── auth.py                   # Bitbucket OAuth 2.0 authentication
│   ├── bitbucket_client.py       # Bitbucket Cloud API integration
│   ├── chat.py                   # Model routing, prompt building, file/error detection
│   ├── github_client.py          # GitHub API: PRs, issues, branches, commits, reviews
│   ├── indexer.py                # RAG: AST-aware chunking, embedding, ChromaDB
│   ├── repo_loader.py            # Clone, cache, file reading, code health metrics
│   └── storage.py                # SQLite session persistence and export
├── .env.example                  # Environment variable template
├── requirements.txt              # Python dependencies
└── README.md
```

## Requirements

- Python 3.10+
- Git (available in PATH)
- An OpenAI API key

## Installation

1. Clone this repository:

```bash
git clone https://github.com/ahmetguness/repo_qa_assistant.git
cd repo_qa_assistant
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Create your environment file:

```bash
cp .env.example .env
```

4. Add your API keys to `.env`:

```
OPENAI_API_KEY=sk-your-key-here
```

## Usage

```bash
streamlit run app.py
```

The app opens at `http://localhost:8501`. Enter a repository URL in the sidebar and click "Load Repository".

### Example Questions

| Question | What Happens |
|----------|-------------|
| "What does this repo do?" | Summarizes the project based on README and structure |
| "Explain the architecture" | Analyzes folder structure, dependencies, and patterns |
| "What changed in PR #5?" | Fetches diff, file contents, and review comments |
| "Show the last PR's files" | Auto-detects latest PR and retrieves all file contents |
| "Describe test-results.md" | Finds the file (fuzzy match) and loads its full content |
| "Compare app.py and utils.py" | Loads both files into context for comparison |
| "Who are the most active contributors?" | Analyzes commit history |
| (paste a stack trace) | Extracts file paths from the trace and loads source files |

## How It Works

### AST-Aware Chunking

Source files are parsed using tree-sitter to extract semantic code units (functions, classes, methods). Each chunk represents a complete code block with metadata: name, type, language, and line range. Non-code files (markdown, JSON, YAML) fall back to character-based chunking.

Supported languages: Python, JavaScript, TypeScript, Java, Go, Rust, C, C++, C#, Ruby.

### RAG Pipeline

Chunks are embedded using `text-embedding-3-small` and stored in an in-memory ChromaDB collection. Each query is embedded and the top 12 most relevant chunks are retrieved. Rich metadata headers are included so the model knows which function in which file it is looking at.

### PR File Resolution

When a PR is referenced (explicitly via `#10` or implicitly via "last PR"), the application fetches file contents directly from the PR branch using `repo.get_contents(path, ref=pr.head.sha)`. This means files that exist only in the PR branch (not yet merged to main) are fully accessible.

### Model Routing

| Complexity | Model | Triggers |
|------------|-------|----------|
| Light | gpt-4o-mini | General questions, summaries |
| Deep | gpt-4o | Architecture, security, refactoring, code review |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `GITHUB_TOKEN` | No | GitHub PAT (raises rate limit from 60 to 5,000/hour) |
| `BB_CLIENT_ID` | No | Bitbucket OAuth consumer key (enables login button) |
| `BB_CLIENT_SECRET` | No | Bitbucket OAuth consumer secret |
| `BB_REDIRECT_URI` | No | OAuth callback URL (default: `http://localhost:8501`) |
| `BB_USERNAME` | No | Bitbucket username for app password auth |
| `BB_APP_PASSWORD` | No | Bitbucket app password |
| `REPO_CACHE_DIR` | No | Custom cache directory (default: `.repo_cache`) |

## Limitations

- The vector index is in-memory and rebuilt on each repo load.
- Files larger than 50 KB are excluded from indexing.
- Total indexable content is capped at 300,000 characters per repo.
- GitHub API: 60 requests/hour without token, 5,000 with token.
- Bitbucket OAuth requires an OAuth consumer configured in workspace settings.
- PR file contents are fetched via API; very large PRs with many files may be slow.

## License

This project is provided as-is for educational and prototyping purposes.
