# Repo QA Assistant

A Streamlit-based web application that clones any public GitHub repository, indexes its contents using RAG (Retrieval-Augmented Generation), and answers natural language questions about the codebase through OpenAI's language models.

## Features

- **Repository Analysis** — Clones a GitHub repo, reads source files, and builds a searchable vector index using ChromaDB and OpenAI embeddings.
- **Pull Request Inspection** — Fetches open and closed PRs with metadata. Automatically retrieves diffs when a specific PR is referenced in a question.
- **Issue and Branch Tracking** — Displays open issues and branch information from the GitHub API.
- **Commit History** — Shows recent commits and contributor activity.
- **File-Level Queries** — Detects file references in questions and injects the full file content into the prompt for precise answers.
- **Adaptive Model Selection** — Routes simple questions to `gpt-4o-mini` and complex analysis requests (architecture, security, refactoring) to `gpt-4o`.
- **Conversation Memory** — Summarizes long conversations to preserve context without exceeding token limits.
- **Code Health Metrics** — Displays file count, line count, test coverage ratio, and dependency count in the sidebar.
- **Session Persistence** — Saves and loads chat sessions via SQLite. Supports export to Markdown.
- **Repository Caching** — Caches cloned repositories locally. Subsequent loads use `git pull` instead of a full clone.

## Project Structure

```
repo_qa_assistant/
├── app.py                    # Streamlit UI and main application logic
├── core/
│   ├── __init__.py
│   ├── github_client.py      # GitHub API: PRs, issues, branches, commits
│   ├── repo_loader.py        # Clone, cache, file reading, code health
│   ├── indexer.py             # RAG: chunking, embedding, ChromaDB
│   ├── chat.py                # Model selection, prompt building, summarization
│   └── storage.py             # SQLite session persistence and export
├── .env.example               # Environment variable template
├── requirements.txt           # Python dependencies
└── README.md
```

## Requirements

- Python 3.10+
- Git (available in PATH)
- An OpenAI API key

## Installation

1. Clone this repository:

```bash
git clone https://github.com/your-username/repo_qa_assistant.git
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

4. Open `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-key-here
```

Optionally, add a GitHub personal access token for private repositories and higher API rate limits (5,000 requests/hour vs. 60 without a token):

```
GITHUB_TOKEN=ghp_your-token-here
```

## Usage

Start the application:

```bash
streamlit run app.py
```

The app opens at `http://localhost:8501`. Enter a GitHub repository URL in the sidebar and click "Load Repository". The application will:

1. Clone the repository (or update the local cache)
2. Read and index source files
3. Fetch PRs, issues, branches, and commit history from the GitHub API
4. Build a vector search index using OpenAI embeddings

Once loaded, ask questions in the chat input. Examples:

- "What does this repository do?"
- "Summarize the open pull requests"
- "Explain the project architecture"
- "What changed in PR #5?"
- "Describe the `src/main.py` file"
- "Who are the most active contributors?"

## How It Works

### RAG Pipeline

Source files are split into overlapping chunks (1,500 characters with 200-character overlap), embedded using `text-embedding-3-small`, and stored in an in-memory ChromaDB collection. When a question is asked, the query is embedded and the top 12 most relevant chunks are retrieved and included in the prompt.

### Model Routing

Questions are classified by complexity:

| Complexity | Model         | Trigger Examples                              |
|------------|---------------|-----------------------------------------------|
| Light      | gpt-4o-mini   | General questions, summaries, explanations    |
| Deep       | gpt-4o        | Architecture, security, refactoring, reviews  |

### Conversation Summarization

After 10 messages, older messages are summarized into a compact paragraph using `gpt-4o-mini`. The summary is included in the system prompt, and only the most recent messages are sent in full. This keeps token usage manageable during long sessions.

## Configuration

| Variable         | Required | Description                                      |
|------------------|----------|--------------------------------------------------|
| `OPENAI_API_KEY` | Yes      | OpenAI API key for embeddings and chat            |
| `GITHUB_TOKEN`   | No       | GitHub PAT for private repos and higher rate limits |
| `REPO_CACHE_DIR` | No       | Custom cache directory (default: `.repo_cache`)   |

## Limitations

- The vector index is stored in memory and is lost when the application restarts. Reloading a repository rebuilds the index.
- Very large repositories may exceed the 300,000-character context limit. Files beyond this limit are skipped.
- Individual files larger than 50 KB are excluded from indexing.
- GitHub API rate limits apply: 60 requests/hour without a token, 5,000 with a token.

## License

This project is provided as-is for educational and prototyping purposes.
