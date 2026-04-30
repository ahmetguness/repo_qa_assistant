import os
import re

from dotenv import load_dotenv
from openai import OpenAI
import streamlit as st

from core import github_client as gh
from core import bitbucket_client as bb
from core.repo_loader import (
    build_tree, clone_repo, find_file,
    get_code_health, get_language_stats, read_repo_files,
)
from core.indexer import build_index, query_index
from core.chat import (
    build_system_prompt, detect_complexity, detect_file_reference,
    detect_file_references, detect_error_trace,
    get_model, stream_response, summarize_conversation,
)
from core.storage import (
    delete_session, export_session_markdown,
    list_sessions, load_session, save_session,
)
from core.auth import (
    build_authorize_url, exchange_code_for_token,
    get_current_user, get_oauth_config, discover_all_repos,
    _list_workspace_repos,
)

load_dotenv()

# ── Helpers ────────────────────────────────────────────────────────────

def detect_platform(url: str) -> str:
    return "bitbucket" if "bitbucket.org" in url else "github"

def _kw() -> dict:
    return {
        "token": st.session_state.get("github_token") or os.getenv("GITHUB_TOKEN"),
        "bb_user": st.session_state.get("bb_username"),
        "bb_pass": st.session_state.get("bb_app_password"),
        "bb_token": st.session_state.get("bb_access_token"),
    }

def _pfetch(fn_gh, fn_bb, url, *args, **kw):
    if detect_platform(url) == "bitbucket":
        return fn_bb(url, *args, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return fn_gh(url, *args, kw.get("token"))

def load_repo(repo_url: str) -> bool:
    """Repoyu klonla, indexle, session state'e yaz. Başarılıysa True döner."""
    kw = _kw()
    try:
        path = clone_repo(repo_url)
        tree = build_tree(path)
        files = read_repo_files(path)

        pr_info = _pfetch(gh.fetch_pull_requests, bb.fetch_pull_requests, repo_url, **kw)
        issue_info = _pfetch(gh.fetch_issues, lambda *a: "N/A", repo_url, **kw)
        branch_info = _pfetch(gh.fetch_branches, bb.fetch_branches, repo_url, **kw)
        commit_info = _pfetch(gh.fetch_commits, bb.fetch_commits, repo_url, **kw)

        st.session_state.repo_url = repo_url
        st.session_state.repo_path = path
        st.session_state.tree = tree
        st.session_state.files = files
        st.session_state.lang_stats = get_language_stats(files)
        st.session_state.code_health = get_code_health(files)
        st.session_state.commit_info = commit_info
        st.session_state.github_info = (
            f"## PRs\n{pr_info}\n\n## Issues\n{issue_info}\n\n## Branches\n{branch_info}"
        )
        st.session_state.collection = build_index(files, api_key)
        return True
    except Exception as e:
        st.error(f"Repo yüklenemedi: {e}")
        return False


def detect_repo_in_question(question: str, repos: list[dict]) -> dict | None:
    """Soruda geçen repo adını bulur."""
    q = question.lower()
    for r in repos:
        name = r["name"].lower()
        full = r["full_name"].lower()
        if name and len(name) > 2 and name in q:
            return r
        if full in q:
            return r
    return None


# ── Page config ────────────────────────────────────────────────────────

st.set_page_config(page_title="Repo QA Assistant", page_icon="🔍", layout="wide")
st.markdown("""<style>
    .block-container{padding-top:2rem}
    [data-testid="stSidebar"]{min-width:300px}
    div[data-testid="stMetric"]{background:rgba(255,255,255,.05);border-radius:8px;padding:10px}
</style>""", unsafe_allow_html=True)

api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    st.error("`.env` dosyasına `OPENAI_API_KEY` ekleyin.")
    st.stop()
client = OpenAI(api_key=api_key)

# ── Session state ──────────────────────────────────────────────────────

defaults = {
    "messages": [], "repo_url": None, "repo_path": None,
    "tree": None, "github_info": None, "commit_info": None,
    "files": None, "collection": None, "repo_summary": {},
    "lang_stats": {}, "code_health": {}, "github_token": None,
    "bb_username": None, "bb_app_password": None,
    "bb_access_token": None, "bb_user_info": None, "bb_repos": [],
    "bb_workspace": None,
    "platform": None, "conversation_summary": "", "active_session_id": None,
}
for k, v in defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ── Sidebar ────────────────────────────────────────────────────────────

with st.sidebar:
    bb_client_id, bb_client_secret = get_oauth_config()
    has_oauth = bool(bb_client_id and bb_client_secret)

    # OAuth callback
    oauth_code = st.query_params.get("code")
    if oauth_code and not st.session_state.bb_access_token and has_oauth:
        try:
            redirect_uri = os.getenv("BB_REDIRECT_URI", "http://localhost:8501")
            token_data = exchange_code_for_token(
                oauth_code, bb_client_id, bb_client_secret, redirect_uri
            )
            st.session_state.bb_access_token = token_data["access_token"]
            user_info = get_current_user(token_data["access_token"])
            st.session_state.bb_user_info = {
                "username": user_info.get("username", ""),
                "display_name": user_info.get("display_name", ""),
                "nickname": user_info.get("nickname", ""),
            }
            # Tüm erişilebilir repoları otomatik bul
            workspaces, repos = discover_all_repos(token_data["access_token"])
            st.session_state.bb_workspace = ", ".join(workspaces) if workspaces else "?"
            st.session_state.bb_repos = repos
            st.query_params.clear()
            st.rerun()
        except Exception as e:
            st.error(f"OAuth hatası: {e}")
            st.query_params.clear()

    logged_in = bool(st.session_state.bb_access_token and st.session_state.bb_user_info)

    # ── User info / login ──
    if logged_in:
        user = st.session_state.bb_user_info
        col_u, col_x = st.columns([4, 1])
        col_u.markdown(f"**{user['display_name']}**")
        if col_x.button("✕", help="Çıkış"):
            for k in ("bb_access_token", "bb_user_info", "bb_repos", "bb_workspace"):
                st.session_state[k] = defaults[k]
            st.rerun()

        # Repolar henüz yüklenmediyse otomatik bul
        if not st.session_state.bb_repos and not st.session_state.bb_workspace:
            workspaces, repos = discover_all_repos(st.session_state.bb_access_token)
            st.session_state.bb_workspace = ", ".join(workspaces) if workspaces else "?"
            st.session_state.bb_repos = repos
            if repos:
                st.rerun()

        # Repo listesi sidebar'da
        if st.session_state.bb_repos:
            st.divider()
            st.markdown(f"##### {st.session_state.bb_workspace}")
            st.caption(f"{len(st.session_state.bb_repos)} repo erişilebilir")
            with st.expander("Repo listesi"):
                for r in st.session_state.bb_repos:
                    icon = "🔒" if r["is_private"] else "🌐"
                    st.caption(f"{icon} {r['full_name']}")
        elif st.session_state.bb_workspace:
            st.divider()
            st.warning("Erişilebilir repo bulunamadı.")
            st.caption("OAuth consumer'da Repositories: Read izni olduğundan emin olun.")

            # Debug bilgisi
            with st.expander("Debug bilgisi"):
                token = st.session_state.bb_access_token
                from core.auth import _discover_workspace_slugs, _bb_get, BB_API
                slugs = _discover_workspace_slugs(token)
                st.write(f"Denenen slug'lar: {slugs}")
                for s in slugs:
                    try:
                        r = _bb_get(f"{BB_API}/repositories/{s}", token, {"pagelen": 3})
                        st.write(f"`{s}`: status={r.status_code}, size={r.json().get('size', '?') if r.status_code == 200 else r.text[:100]}")
                    except Exception as e:
                        st.write(f"`{s}`: error={e}")
                
                # Spesifik repo testi
                st.write("---")
                st.write("Spesifik repo testi:")
                test_repo = "ahmetgunes-ceng/sloncar-rental-platform"
                r = _bb_get(f"{BB_API}/repositories/{test_repo}", token)
                st.write(f"`{test_repo}`: status={r.status_code}")
                if r.status_code == 200:
                    d = r.json()
                    st.write(f"  name={d.get('name')}, private={d.get('is_private')}")
                else:
                    st.write(f"  {r.text[:200]}")
                
                # Token scopes
                st.write("---")
                r2 = _bb_get(f"{BB_API}/user", token)
                st.write(f"/user status: {r2.status_code}")
                if r2.status_code == 200:
                    st.write(f"  username: {r2.json().get('username')}")
                # Check response headers for scopes
                r3 = _bb_get(f"{BB_API}/repositories/ahmetgunes-ceng", token, {"pagelen": 1})
                st.write(f"Scopes header: {r3.headers.get('x-oauth-scopes', 'N/A')}")
                st.write(f"Accepted scopes: {r3.headers.get('x-accepted-oauth-scopes', 'N/A')}")

            if st.button("Tekrar Dene", use_container_width=True):
                workspaces, repos = discover_all_repos(st.session_state.bb_access_token)
                st.session_state.bb_workspace = ", ".join(workspaces) if workspaces else "?"
                st.session_state.bb_repos = repos
                st.rerun()
            st.markdown(f"##### {st.session_state.bb_workspace}")
            st.caption(f"{len(st.session_state.bb_repos)} repo")
    else:
        if has_oauth:
            redirect_uri = os.getenv("BB_REDIRECT_URI", "http://localhost:8501")
            st.link_button("Bitbucket ile Giriş Yap",
                           url=build_authorize_url(bb_client_id, redirect_uri),
                           use_container_width=True)
        else:
            st.button("Bitbucket ile Giriş Yap", disabled=True, use_container_width=True,
                       help="BB_CLIENT_ID ve BB_CLIENT_SECRET .env'de tanımlı değil")

    # ── Aktif repo bilgisi ──
    if st.session_state.repo_url:
        st.divider()
        st.markdown(f"##### Aktif Repo")
        st.caption(st.session_state.repo_url.split("/")[-1])
        if st.session_state.code_health:
            h = st.session_state.code_health
            c1, c2 = st.columns(2)
            c1.metric("Dosya", h["total_files"])
            c2.metric("Satır", f"{h['total_lines']:,}")

    # ── Geçmiş ──
    sessions = list_sessions(5)
    if sessions:
        st.divider()
        st.markdown("##### Geçmiş")
        for s in sessions:
            c1, c2 = st.columns([5, 1])
            c1.caption(s["title"][:35])
            if c2.button("↗", key=f"l_{s['id']}"):
                url, msgs = load_session(s["id"])
                if url and msgs:
                    st.session_state.repo_url = url
                    st.session_state.messages = msgs
                    st.rerun()

# ── Main area ──────────────────────────────────────────────────────────

st.title("Repo QA Assistant")

# Chat her zaman açık — login yeterliyse
if not logged_in:
    st.info("Sol panelden Bitbucket ile giriş yapın.")
    st.stop()

# Repo listesini system context olarak hazırla
repo_list_text = "\n".join(
    f"- {r['full_name']} ({'private' if r['is_private'] else 'public'}) [{r['language']}]"
    for r in st.session_state.bb_repos
) if st.session_state.bb_repos else "Repo listesi yüklenemedi veya boş."

# Chat geçmişi
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# Kullanıcı mesajı
if user_input := st.chat_input("Herhangi bir repo hakkında soru sorun..."):
    st.session_state.messages.append({"role": "user", "content": user_input})
    st.rerun()

# ── Yanıt üretimi ─────────────────────────────────────────────────────

if st.session_state.messages and st.session_state.messages[-1]["role"] == "user":
    question = st.session_state.messages[-1]["content"]
    kw = _kw()

    # Soruda repo adı geçiyorsa otomatik yükle
    if st.session_state.bb_repos:
        target_repo = detect_repo_in_question(question, st.session_state.bb_repos)
        if target_repo and target_repo["url"] != st.session_state.repo_url:
            with st.spinner(f"`{target_repo['name']}` yükleniyor..."):
                load_repo(target_repo["url"])

    has_collection = st.session_state.get("collection") is not None

    # PR diff + reviews
    pr_diff_context = ""
    pr_num = None
    pr_match = re.search(r"#(\d+)", question)
    if pr_match:
        pr_num = int(pr_match.group(1))
    elif re.search(r"(son|last|latest|en son)\s*(pr|pull\s*request)", question, re.IGNORECASE):
        num_match = re.search(r"PR #(\d+)", st.session_state.github_info or "")
        if num_match:
            pr_num = int(num_match.group(1))

    if pr_num and st.session_state.repo_url:
        pr_diff_context = _pfetch(
            gh.fetch_pr_diff, bb.fetch_pr_diff,
            st.session_state.repo_url, pr_num, **kw
        )
        if detect_platform(st.session_state.repo_url) == "github":
            reviews = gh.fetch_pr_reviews(st.session_state.repo_url, pr_num, kw.get("token"))
            if reviews:
                pr_diff_context += "\n\n" + reviews

    # File context
    file_context = ""
    if has_collection and st.session_state.files:
        refs = detect_file_references(question) + detect_error_trace(question)
        found = []
        for ref in dict.fromkeys(refs):
            f = find_file(st.session_state.files, ref)
            if f and not f["content"].startswith("["):
                found.append(f"--- {f['path']} ---\n{f['content']}")
            if len(found) >= 5:
                break
        if found:
            file_context = "\n\n".join(found)

    # Model
    complexity = detect_complexity(question)
    model = get_model(complexity)

    # RAG
    rag_context = ""
    if has_collection:
        rag_context = query_index(question, st.session_state.collection, api_key)
    if pr_diff_context:
        rag_context = pr_diff_context + "\n\n" + rag_context

    # Conversation summary
    if len(st.session_state.messages) > 10 and not st.session_state.conversation_summary:
        st.session_state.conversation_summary = summarize_conversation(
            client, st.session_state.messages
        )

    # System prompt — repo listesi her zaman dahil
    system_parts = [
        "Sen bir Bitbucket repo analiz asistanısın. "
        "Kullanıcının workspace'indeki tüm repolara erişimin var. "
        "Kullanıcı bir repo adı söylediğinde o repoyu analiz et. "
        "Cevaplarını Türkçe ver. Kod gösterirken markdown kullan.\n\n"
        "ÖNEMLİ KURALLAR:\n"
        "- SADECE aşağıdaki repo listesindeki repoları biliyorsun.\n"
        "- Listede olmayan repo adı UYDURMA. Bilmiyorsan 'bu repo listede yok' de.\n"
        "- Repo yüklenmemişse 'önce bir repo adı söyleyin' de.\n\n"
        f"## Workspace: {st.session_state.bb_workspace}\n"
        f"## Erişilebilir Repolar\n{repo_list_text}\n\n"
    ]

    if st.session_state.repo_url:
        system_parts.append(f"## Aktif Repo: {st.session_state.repo_url}\n")
    if st.session_state.tree:
        system_parts.append(f"## Dizin Yapısı\n```\n{st.session_state.tree}\n```\n\n")
    if st.session_state.github_info:
        system_parts.append(f"## GitHub/Bitbucket Bilgileri\n{st.session_state.github_info}\n\n")
    if st.session_state.commit_info:
        system_parts.append(f"## Commit Geçmişi\n{st.session_state.commit_info}\n\n")
    if st.session_state.conversation_summary:
        system_parts.append(f"## Önceki Konuşma Özeti\n{st.session_state.conversation_summary}\n\n")
    if file_context:
        system_parts.append(f"## Dosya İçerikleri\n{file_context}\n\n")
    if rag_context:
        system_parts.append(f"## İlgili Kod Parçaları\n{rag_context}\n")

    api_messages = [{"role": "system", "content": "".join(system_parts)}]
    recent = 6 if st.session_state.conversation_summary else 10
    api_messages += [
        {"role": m["role"], "content": m["content"]}
        for m in st.session_state.messages[-recent:]
    ]

    with st.chat_message("assistant"):
        st.caption(f"Model: `{model}` · {complexity}"
                   + (f" · Repo: `{st.session_state.repo_url.split('/')[-1]}`" if st.session_state.repo_url else ""))
        stream = stream_response(client, api_messages, model)
        response = st.write_stream(stream)

    st.session_state.messages.append({"role": "assistant", "content": response})
    st.rerun()
