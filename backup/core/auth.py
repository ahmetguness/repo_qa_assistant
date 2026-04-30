"""Bitbucket OAuth 2.0 authentication.

Discovers all accessible repos without requiring a workspace slug.
Uses multiple API strategies to find repos the token can access.
"""

import os
import requests

BB_AUTH_URL = "https://bitbucket.org/site/oauth2/authorize"
BB_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token"
BB_API = "https://api.bitbucket.org/2.0"


def get_oauth_config() -> tuple[str, str]:
    client_id = os.getenv("BB_CLIENT_ID", "")
    client_secret = os.getenv("BB_CLIENT_SECRET", "")
    return client_id, client_secret


def build_authorize_url(client_id: str, redirect_uri: str) -> str:
    return (
        f"{BB_AUTH_URL}"
        f"?client_id={client_id}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri}"
    )


def exchange_code_for_token(
    code: str, client_id: str, client_secret: str, redirect_uri: str,
) -> dict:
    resp = requests.post(
        BB_TOKEN_URL, auth=(client_id, client_secret),
        data={"grant_type": "authorization_code", "code": code,
              "redirect_uri": redirect_uri},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_current_user(access_token: str) -> dict:
    resp = requests.get(
        f"{BB_API}/user",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def _bb_get(url: str, token: str, params: dict | None = None) -> requests.Response:
    return requests.get(
        url, headers={"Authorization": f"Bearer {token}"},
        params=params or {}, timeout=15,
    )


def _discover_workspace_slugs(access_token: str) -> list[str]:
    """Finds all workspace slugs the user has access to.

    Tries multiple methods since Bitbucket deprecated cross-workspace APIs.
    """
    slugs = []

    # 1. BB_WORKSPACE env var
    env_ws = os.getenv("BB_WORKSPACE", "")
    if env_ws:
        slugs.append(env_ws)

    # 2. /user/permissions/workspaces (may be deprecated but try)
    try:
        r = _bb_get(f"{BB_API}/user/permissions/workspaces", access_token, {"pagelen": 50})
        if r.status_code == 200:
            for item in r.json().get("values", []):
                s = item.get("workspace", {}).get("slug", "")
                if s and s not in slugs:
                    slugs.append(s)
    except Exception:
        pass

    # 3. /user response — extract from links and try username/nickname
    try:
        user = get_current_user(access_token)

        # links.repositories.href → https://api.bitbucket.org/2.0/repositories/{slug}
        href = user.get("links", {}).get("repositories", {}).get("href", "")
        if href:
            parts = href.rstrip("/").split("/")
            s = parts[-1] if parts else ""
            if s and s not in slugs:
                slugs.append(s)

        for key in ("username", "nickname"):
            s = user.get(key, "")
            if s and s not in slugs:
                slugs.append(s)
    except Exception:
        pass

    return slugs


def _list_workspace_repos(access_token: str, workspace: str, pagelen: int = 50) -> list[dict]:
    """Lists repos in a workspace. Returns empty list on error."""
    try:
        r = _bb_get(
            f"{BB_API}/repositories/{workspace}", access_token,
            {"pagelen": pagelen, "sort": "-updated_on", "role": "member"},
        )
        if r.status_code != 200:
            # Try without role filter
            r = _bb_get(
                f"{BB_API}/repositories/{workspace}", access_token,
                {"pagelen": pagelen, "sort": "-updated_on"},
            )
        if r.status_code != 200:
            return []

        data = r.json()
        repos = []
        for repo in data.get("values", []):
            full_name = repo.get("full_name", "")
            clone_links = repo.get("links", {}).get("clone", [])
            https_url = next(
                (l["href"] for l in clone_links if l.get("name") == "https"),
                f"https://bitbucket.org/{full_name}.git",
            )
            repos.append({
                "full_name": full_name,
                "name": repo.get("name", ""),
                "description": repo.get("description") or "",
                "is_private": repo.get("is_private", False),
                "url": https_url,
                "language": repo.get("language") or "",
                "updated_on": repo.get("updated_on", "")[:10],
            })
        return repos
    except Exception:
        return []


def discover_all_repos(access_token: str) -> tuple[list[str], list[dict]]:
    """Discovers all workspaces and repos accessible to the token.

    Returns:
        (workspace_slugs, repos)
    """
    slugs = _discover_workspace_slugs(access_token)

    all_repos = []
    working_slugs = []
    seen = set()

    for slug in slugs:
        repos = _list_workspace_repos(access_token, slug)
        if repos:
            working_slugs.append(slug)
        for r in repos:
            if r["full_name"] not in seen:
                seen.add(r["full_name"])
                all_repos.append(r)

    return working_slugs, all_repos
