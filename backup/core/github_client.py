"""GitHub API entegrasyonu: PR, issue, branch bilgilerini çeker."""

import re
import time
from functools import lru_cache
from github import Github, GithubException


def extract_owner_repo(repo_url: str) -> str | None:
    """GitHub URL'sinden 'owner/repo' bilgisini çıkarır."""
    match = re.match(r"https?://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$", repo_url)
    return match.group(1) if match else None


# GitHub client'ı cache'le — aynı token için tekrar oluşturma
_gh_cache: dict[str, Github] = {}


def _get_gh(token: str | None = None) -> Github:
    key = token or "__no_token__"
    if key not in _gh_cache:
        _gh_cache[key] = Github(token, retry=0) if token else Github(retry=0)
    return _gh_cache[key]


def _handle_rate_limit(e: Exception) -> str:
    """Rate limit hatasını kullanıcı dostu mesaja çevirir."""
    msg = str(e)
    if "rate limit" in msg.lower() or "403" in msg:
        return (
            "[GitHub API rate limit aşıldı. "
            "Token olmadan saatte 60 istek yapılabilir. "
            ".env dosyasına GITHUB_TOKEN ekleyerek limiti 5000'e çıkarabilirsiniz.]\n"
        )
    return f"[Hata: {msg}]\n"


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
        return _handle_rate_limit(e)
    except Exception as e:
        return _handle_rate_limit(e)


def fetch_pr_diff(repo_url: str, pr_number: int, token: str | None = None) -> str:
    """Belirli bir PR'ın diff bilgisini ve dosya içeriklerini çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return ""

    try:
        repo = _get_gh(token).get_repo(slug)
        pr = repo.get_pull(pr_number)
        files = list(pr.get_files())

        lines = [f"### PR #{pr_number} Diff: {pr.title}"]
        lines.append(f"Branch: `{pr.head.ref}` → `{pr.base.ref}`")
        lines.append(f"Değişen dosya sayısı: {len(files)}, +{pr.additions} -{pr.deletions}")
        lines.append(f"Dosyalar: {', '.join(f.filename for f in files)}\n")

        for f in files[:20]:
            lines.append(f"**{f.filename}** ({f.status}) +{f.additions} -{f.deletions}")

            # Dosyanın tam içeriğini PR branch'inden çek
            try:
                if f.status != "removed":
                    content_file = repo.get_contents(f.filename, ref=pr.head.sha)
                    if hasattr(content_file, "decoded_content"):
                        content = content_file.decoded_content.decode("utf-8", errors="ignore")
                        if len(content) < 8000:
                            lines.append(f"\nTam dosya içeriği ({f.filename}):")
                            lines.append(f"```\n{content}\n```")
                        else:
                            lines.append(f"\n[Dosya çok büyük ({len(content)} karakter), sadece diff gösteriliyor]")
            except Exception:
                pass

            # Diff/patch
            if f.patch and len(f.patch) < 3000:
                lines.append(f"\nDiff:")
                lines.append(f"```diff\n{f.patch}\n```")
            elif f.patch:
                lines.append(f"\nDiff (kırpılmış):")
                lines.append(f"```diff\n{f.patch[:3000]}\n[...]\n```")

            lines.append("")

        return "\n".join(lines)
    except Exception as e:
        return _handle_rate_limit(e)


def fetch_pr_reviews(repo_url: str, pr_number: int, token: str | None = None) -> str:
    """PR review yorumlarını ve tartışmalarını çeker."""
    slug = extract_owner_repo(repo_url)
    if not slug:
        return ""

    try:
        repo = _get_gh(token).get_repo(slug)
        pr = repo.get_pull(pr_number)

        lines = []

        # Review'lar (approve, request changes, comment)
        reviews = list(pr.get_reviews()[:20])
        if reviews:
            lines.append(f"### PR #{pr_number} Reviews")
            for r in reviews:
                state = r.state.replace("_", " ").title()
                user = r.user.login if r.user else "?"
                body = (r.body or "").strip()
                if body:
                    lines.append(f"- **{user}** [{state}]: {body[:300]}")
                else:
                    lines.append(f"- **{user}** [{state}]")

        # Review comment'leri (satır bazlı yorumlar)
        comments = list(pr.get_review_comments()[:30])
        if comments:
            lines.append(f"\n### Satır Bazlı Yorumlar")
            for c in comments:
                user = c.user.login if c.user else "?"
                path = c.path or "?"
                line = c.original_line or c.line or "?"
                body = (c.body or "").strip()[:200]
                lines.append(f"- **{user}** `{path}:{line}`: {body}")

        # Issue comment'leri (genel tartışma)
        issue_comments = list(pr.get_issue_comments()[:15])
        if issue_comments:
            lines.append(f"\n### Genel Tartışma")
            for c in issue_comments:
                user = c.user.login if c.user else "?"
                body = (c.body or "").strip()[:300]
                lines.append(f"- **{user}**: {body}")

        return "\n".join(lines) if lines else ""
    except Exception:
        return ""


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
        return _handle_rate_limit(e)


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
        return _handle_rate_limit(e)


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
        return _handle_rate_limit(e)


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
        return {}  # Rate limit veya hata durumunda boş döndür, retry yapma
