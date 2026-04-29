"""Bitbucket OAuth 2.0 authentication."""

import os
import requests

BB_AUTH_URL = "https://bitbucket.org/site/oauth2/authorize"
BB_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token"
BB_API = "https://api.bitbucket.org/2.0"


def get_oauth_config() -> tuple[str, str]:
    """Returns (client_id, client_secret) from environment."""
    client_id = os.getenv("BB_CLIENT_ID", "")
    client_secret = os.getenv("BB_CLIENT_SECRET", "")
    return client_id, client_secret


def build_authorize_url(client_id: str, redirect_uri: str) -> str:
    """Builds the Bitbucket OAuth authorization URL."""
    return (
        f"{BB_AUTH_URL}"
        f"?client_id={client_id}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri}"
    )


def exchange_code_for_token(
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
) -> dict:
    """Exchanges authorization code for access token.

    Returns:
        {"access_token": "...", "refresh_token": "...", "expires_in": 7200, ...}
    """
    resp = requests.post(
        BB_TOKEN_URL,
        auth=(client_id, client_secret),
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_access_token(
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> dict:
    """Refreshes an expired access token."""
    resp = requests.post(
        BB_TOKEN_URL,
        auth=(client_id, client_secret),
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_current_user(access_token: str) -> dict:
    """Fetches the authenticated user's profile."""
    resp = requests.get(
        f"{BB_API}/user",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def list_user_repos(
    access_token: str,
    workspace: str | None = None,
    page: int = 1,
    pagelen: int = 25,
) -> list[dict]:
    """Lists repositories accessible to the authenticated user.

    If workspace is provided, lists repos in that workspace.
    Otherwise lists all repos the user has access to.
    """
    if workspace:
        url = f"{BB_API}/repositories/{workspace}"
    else:
        url = f"{BB_API}/repositories"
        # User's own repos
        url = f"{BB_API}/user/permissions/repositories"

    params = {"pagelen": pagelen, "page": page}

    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()

    repos = []
    for item in data.get("values", []):
        # permissions endpoint wraps repo in "repository" key
        repo = item.get("repository", item)
        full_name = repo.get("full_name", "")
        clone_links = repo.get("links", {}).get("clone", [])
        https_url = ""
        for link in clone_links:
            if link.get("name") == "https":
                https_url = link.get("href", "")
                break
        if not https_url:
            https_url = f"https://bitbucket.org/{full_name}.git"

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


def list_user_workspaces(access_token: str) -> list[dict]:
    """Lists workspaces the user belongs to."""
    resp = requests.get(
        f"{BB_API}/workspaces",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"pagelen": 50},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()

    return [
        {
            "slug": w.get("slug", ""),
            "name": w.get("name", ""),
        }
        for w in data.get("values", [])
    ]
