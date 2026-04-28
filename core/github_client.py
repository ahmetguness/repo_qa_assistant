"""GitHub API entegrasyonu: PR, issue, branch bilgilerini çeker."""

import re
from github import Github, GithubException


def extract_owner_repo(repo_url: str) -> str | None:
    """GitHub URL'sinden 'owner/repo' bilgisini çıkarır."""
    match = re.match(r"https?://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$", repo_url)
    return match.group(1) if match else None


def _get_gh(token: str | None = None) -> Github:
    return Github(token) if token else Github()


def fetch_pull_requests(repo_url: str, token: str | None = None) -> str:
    """Tüm PR'ları (açık, kapalı, merge edilmiş) çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return "[PR bilgisi alınamadı: Geçersiz GitHub URL'si]\n"

    try:
        repo = _get_gh(token).get_repo(slug)
        all_prs = list(repo.get_pulls(state="all", sort="updated", direction="desc")[:25])

        if not all_prs:
            return "PR bulunamadı.\n"

        open_prs = [pr for pr in all_prs if pr.state == "open"]
        closed_prs = [pr for pr in all_prs if pr.state == "closed"]
        lines = []

        if open_prs:
            lines.append("### Açık Pull Request'ler")
            for pr in open_prs:
                labels = ", ".join(l.name for l in pr.labels) if pr.labels else "-"
                lines.append(
                    f"- **PR #{pr.number}**: {pr.title}\n"
                    f"  Yazar: {pr.user.login} | Branch: `{pr.head.ref}` → `{pr.base.ref}` | "
                    f"Etiketler: {labels} | Güncelleme: {pr.updated_at.strftime('%Y-%m-%d')}\n"
                    f"  Açıklama: {(pr.body or 'Yok')[:300]}"
                )

        if closed_prs:
            lines.append("\n### Kapatılan / Merge Edilen PR'lar")
            for pr in closed_prs:
                status = "✅ Merged" if pr.merged else "❌ Closed"
                lines.append(
                    f"- **PR #{pr.number}**: {pr.title} [{status}]\n"
                    f"  Yazar: {pr.user.login} | Branch: `{pr.head.ref}` → `{pr.base.ref}` | "
                    f"Tarih: {pr.closed_at.strftime('%Y-%m-%d') if pr.closed_at else '-'}\n"
                    f"  Açıklama: {(pr.body or 'Yok')[:200]}"
                )

        return "\n".join(lines)
    except GithubException as e:
        msg = e.data.get("message", str(e)) if hasattr(e, "data") and isinstance(e.data, dict) else str(e)
        return f"[PR bilgisi alınamadı: {msg}]\n"
    except Exception as e:
        return f"[PR bilgisi alınamadı: {e}]\n"


def fetch_pr_diff(repo_url: str, pr_number: int, token: str | None = None) -> str:
    """Belirli bir PR'ın diff bilgisini çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return ""

    try:
        repo = _get_gh(token).get_repo(slug)
        pr = repo.get_pull(pr_number)
        files = list(pr.get_files())

        lines = [f"### PR #{pr_number} Diff: {pr.title}"]
        lines.append(f"Değişen dosya sayısı: {len(files)}, +{pr.additions} -{pr.deletions}\n")

        for f in files[:20]:  # max 20 dosya
            lines.append(f"**{f.filename}** (+{f.additions} -{f.deletions})")
            if f.patch and len(f.patch) < 3000:
                lines.append(f"```diff\n{f.patch}\n```")
            elif f.patch:
                lines.append(f"```diff\n{f.patch[:3000]}\n[...kırpıldı]\n```")
            lines.append("")

        return "\n".join(lines)
    except Exception as e:
        return f"[PR diff alınamadı: {e}]\n"


def fetch_issues(repo_url: str, token: str | None = None) -> str:
    """Açık issue'ları çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return "[Issue bilgisi alınamadı]\n"

    try:
        repo = _get_gh(token).get_repo(slug)
        issues = list(repo.get_issues(state="open", sort="updated", direction="desc")[:15])
        issues = [i for i in issues if not i.pull_request]

        if not issues:
            return "Açık issue bulunamadı.\n"

        lines = ["### Açık Issue'lar"]
        for issue in issues:
            labels = ", ".join(l.name for l in issue.labels) if issue.labels else "-"
            lines.append(
                f"- **#{issue.number}**: {issue.title}\n"
                f"  Yazar: {issue.user.login} | Etiketler: {labels} | "
                f"Tarih: {issue.created_at.strftime('%Y-%m-%d')}\n"
                f"  Açıklama: {(issue.body or 'Yok')[:200]}"
            )
        return "\n".join(lines)
    except Exception as e:
        return f"[Issue bilgisi alınamadı: {e}]\n"


def fetch_branches(repo_url: str, token: str | None = None) -> str:
    """Repo branch'lerini çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return "[Branch bilgisi alınamadı]\n"

    try:
        repo = _get_gh(token).get_repo(slug)
        branches = list(repo.get_branches()[:30])

        if not branches:
            return "Branch bulunamadı.\n"

        default = repo.default_branch
        lines = [f"### Branch'ler (varsayılan: `{default}`)"]
        for b in branches:
            marker = " ⭐" if b.name == default else ""
            lines.append(f"- `{b.name}`{marker}")
        return "\n".join(lines)
    except Exception as e:
        return f"[Branch bilgisi alınamadı: {e}]\n"


def fetch_commits(repo_url: str, token: str | None = None, limit: int = 20) -> str:
    """Son commit'leri çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return "[Commit bilgisi alınamadı]\n"

    try:
        repo = _get_gh(token).get_repo(slug)
        commits = list(repo.get_commits()[:limit])

        if not commits:
            return "Commit bulunamadı.\n"

        lines = ["### Son Commit'ler"]
        contributors: dict[str, int] = {}
        for c in commits:
            author = c.commit.author.name if c.commit.author else "Bilinmiyor"
            date = c.commit.author.date.strftime("%Y-%m-%d %H:%M") if c.commit.author else "-"
            msg = c.commit.message.split("\n")[0][:120]
            sha = c.sha[:7]
            lines.append(f"- `{sha}` {msg} — *{author}* ({date})")
            contributors[author] = contributors.get(author, 0) + 1

        lines.append("\n### Contributor Aktivitesi (son commit'lere göre)")
        for author, count in sorted(contributors.items(), key=lambda x: -x[1]):
            lines.append(f"- {author}: {count} commit")

        return "\n".join(lines)
    except Exception as e:
        return f"[Commit bilgisi alınamadı: {e}]\n"


def fetch_repo_summary(repo_url: str, token: str | None = None) -> dict:
    """Sidebar için repo özet bilgisi döndürür."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return {}

    try:
        repo = _get_gh(token).get_repo(slug)
        languages = repo.get_languages()
        return {
            "name": repo.full_name,
            "description": repo.description or "-",
            "stars": repo.stargazers_count,
            "forks": repo.forks_count,
            "open_issues": repo.open_issues_count,
            "open_prs": repo.get_pulls(state="open").totalCount,
            "default_branch": repo.default_branch,
            "languages": languages,
        }
    except Exception:
        return {}
