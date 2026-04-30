"""Bitbucket Cloud API entegrasyonu: PR, issue, branch bilgilerini çeker.

Supports both Basic Auth (username + app password) and OAuth Bearer token.
"""

import re
import requests


def extract_bb_workspace_repo(repo_url: str) -> tuple[str, str] | None:
    """Bitbucket URL'sinden workspace ve repo slug çıkarır."""
    match = re.match(
        r"https?://bitbucket\.org/([^/]+)/([^/]+?)(?:\.git)?/?$", repo_url
    )
    if match:
        return match.group(1), match.group(2)
    return None


def _bb_get(
    url: str,
    auth: tuple | None = None,
    params: dict | None = None,
    bearer_token: str | None = None,
) -> dict:
    """Bitbucket REST API GET isteği."""
    headers = {}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
        auth = None
    resp = requests.get(
        url, auth=auth, headers=headers, params=params or {}, timeout=30
    )
    resp.raise_for_status()
    return resp.json()


def _resolve_auth(
    username: str | None,
    app_password: str | None,
    bearer_token: str | None,
) -> tuple[tuple | None, str | None]:
    """Returns (basic_auth, bearer_token) — bearer takes priority."""
    if bearer_token:
        return None, bearer_token
    if username and app_password:
        return (username, app_password), None
    return None, None


BB_API = "https://api.bitbucket.org/2.0"


def fetch_pull_requests(
    repo_url: str,
    username: str | None = None,
    app_password: str | None = None,
    bearer_token: str | None = None,
) -> str:
    """Bitbucket PR'larını çeker."""
    parsed = extract_bb_workspace_repo(repo_url)
    if not parsed:
        return "[PR bilgisi alınamadı: Geçersiz Bitbucket URL'si]\n"

    workspace, repo_slug = parsed
    auth, token = _resolve_auth(username, app_password, bearer_token)

    try:
        lines = []

        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests",
            auth=auth, bearer_token=token,
            params={"state": "OPEN", "pagelen": 15},
        )
        open_prs = data.get("values", [])
        if open_prs:
            lines.append("### Open Pull Requests")
            for pr in open_prs:
                src = pr.get("source", {}).get("branch", {}).get("name", "?")
                dst = pr.get("destination", {}).get("branch", {}).get("name", "?")
                author = pr.get("author", {}).get("display_name", "?")
                lines.append(
                    f"- **PR #{pr['id']}**: {pr['title']}\n"
                    f"  Author: {author} | Branch: `{src}` -> `{dst}` | "
                    f"Updated: {pr.get('updated_on', '-')[:10]}\n"
                    f"  Description: {(pr.get('description') or 'None')[:300]}"
                )

        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests",
            auth=auth, bearer_token=token,
            params={"state": "MERGED", "pagelen": 10},
        )
        merged_prs = data.get("values", [])

        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests",
            auth=auth, bearer_token=token,
            params={"state": "DECLINED", "pagelen": 5},
        )
        declined_prs = data.get("values", [])

        closed_prs = merged_prs + declined_prs
        if closed_prs:
            lines.append("\n### Closed / Merged PRs")
            for pr in closed_prs:
                state = pr.get("state", "?")
                status = "Merged" if state == "MERGED" else "Declined"
                author = pr.get("author", {}).get("display_name", "?")
                lines.append(
                    f"- **PR #{pr['id']}**: {pr['title']} [{status}]\n"
                    f"  Author: {author} | "
                    f"Date: {pr.get('updated_on', '-')[:10]}\n"
                    f"  Description: {(pr.get('description') or 'None')[:200]}"
                )

        return "\n".join(lines) if lines else "No PRs found.\n"
    except Exception as e:
        return f"[PR bilgisi alinamadi: {e}]\n"


def fetch_pr_diff(
    repo_url: str,
    pr_id: int,
    username: str | None = None,
    app_password: str | None = None,
    bearer_token: str | None = None,
) -> str:
    """Belirli bir Bitbucket PR'inin diff bilgisini çeker."""
    parsed = extract_bb_workspace_repo(repo_url)
    if not parsed:
        return ""

    workspace, repo_slug = parsed
    auth, token = _resolve_auth(username, app_password, bearer_token)

    try:
        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/diffstat",
            auth=auth, bearer_token=token,
        )
        files = data.get("values", [])

        pr_data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}",
            auth=auth, bearer_token=token,
        )
        title = pr_data.get("title", "")

        lines = [f"### PR #{pr_id} Diff: {title}"]
        lines.append(f"Changed files: {len(files)}\n")

        for f in files[:20]:
            path = f.get("new", {}).get("path") or f.get("old", {}).get("path", "?")
            added = f.get("lines_added", 0)
            removed = f.get("lines_removed", 0)
            status = f.get("status", "modified")
            lines.append(f"**{path}** ({status}) +{added} -{removed}")

        return "\n".join(lines)
    except Exception as e:
        return f"[PR diff alinamadi: {e}]\n"


def fetch_branches(
    repo_url: str,
    username: str | None = None,
    app_password: str | None = None,
    bearer_token: str | None = None,
) -> str:
    """Bitbucket branch'lerini çeker."""
    parsed = extract_bb_workspace_repo(repo_url)
    if not parsed:
        return "[Branch bilgisi alinamadi]\n"

    workspace, repo_slug = parsed
    auth, token = _resolve_auth(username, app_password, bearer_token)

    try:
        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/refs/branches",
            auth=auth, bearer_token=token,
            params={"pagelen": 30},
        )
        branches = data.get("values", [])
        if not branches:
            return "No branches found.\n"

        repo_data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}",
            auth=auth, bearer_token=token,
        )
        default = repo_data.get("mainbranch", {}).get("name", "main")

        lines = [f"### Branches (default: `{default}`)"]
        for b in branches:
            name = b.get("name", "?")
            marker = " (default)" if name == default else ""
            lines.append(f"- `{name}`{marker}")
        return "\n".join(lines)
    except Exception as e:
        return f"[Branch bilgisi alinamadi: {e}]\n"


def fetch_commits(
    repo_url: str,
    username: str | None = None,
    app_password: str | None = None,
    bearer_token: str | None = None,
    limit: int = 20,
) -> str:
    """Bitbucket commit geçmişini çeker."""
    parsed = extract_bb_workspace_repo(repo_url)
    if not parsed:
        return "[Commit bilgisi alinamadi]\n"

    workspace, repo_slug = parsed
    auth, token = _resolve_auth(username, app_password, bearer_token)

    try:
        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/commits",
            auth=auth, bearer_token=token,
            params={"pagelen": limit},
        )
        commits = data.get("values", [])
        if not commits:
            return "No commits found.\n"

        lines = ["### Recent Commits"]
        contributors: dict[str, int] = {}
        for c in commits:
            author_raw = c.get("author", {}).get("raw", "Unknown")
            author = author_raw.split("<")[0].strip() if "<" in author_raw else author_raw
            date = c.get("date", "")[:16]
            msg = c.get("message", "").split("\n")[0][:120]
            sha = c.get("hash", "")[:7]
            lines.append(f"- `{sha}` {msg} — *{author}* ({date})")
            contributors[author] = contributors.get(author, 0) + 1

        lines.append("\n### Contributor Activity")
        for author, count in sorted(contributors.items(), key=lambda x: -x[1]):
            lines.append(f"- {author}: {count} commits")

        return "\n".join(lines)
    except Exception as e:
        return f"[Commit bilgisi alinamadi: {e}]\n"


def fetch_repo_summary(
    repo_url: str,
    username: str | None = None,
    app_password: str | None = None,
    bearer_token: str | None = None,
) -> dict:
    """Bitbucket repo özet bilgisi."""
    parsed = extract_bb_workspace_repo(repo_url)
    if not parsed:
        return {}

    workspace, repo_slug = parsed
    auth, token = _resolve_auth(username, app_password, bearer_token)

    try:
        data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}",
            auth=auth, bearer_token=token,
        )
        lang = data.get("language", "")

        pr_data = _bb_get(
            f"{BB_API}/repositories/{workspace}/{repo_slug}/pullrequests",
            auth=auth, bearer_token=token,
            params={"state": "OPEN", "pagelen": 1},
        )

        return {
            "name": data.get("full_name", ""),
            "description": data.get("description") or "-",
            "stars": 0,
            "forks": data.get("forks_count", 0) if "forks_count" in data else 0,
            "open_issues": 0,
            "open_prs": pr_data.get("size", 0),
            "default_branch": data.get("mainbranch", {}).get("name", "main"),
            "languages": {lang: 1} if lang else {},
        }
    except Exception:
        return {}
