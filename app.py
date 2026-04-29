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
    get_current_user, get_oauth_config, list_user_repos,
)

load_dotenv()

# ── Platform helpers ───────────────────────────────────────────────────

def detect_platform(url: str) -> str:
    if "bitbucket.org" in url:
        return "bitbucket"
    return "github"

def _api_kwargs() -> dict:
    return {
        "token": st.session_state.get("github_token") or os.getenv("GITHUB_TOKEN"),
        "bb_user": st.session_state.get("bb_username"),
        "bb_pass": st.session_state.get("bb_app_password"),
        "bb_token": st.session_state.get("bb_access_token"),
    }

def platform_fetch_prs(url, **kw):
    if detect_platform(url) == "bitbucket":
        return bb.fetch_pull_requests(url, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return gh.fetch_pull_requests(url, kw.get("token"))

def platform_fetch_pr_diff(url, pr_number, **kw):
    if detect_platform(url) == "bitbucket":
        return bb.fetch_pr_diff(url, pr_number, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return gh.fetch_pr_diff(url, pr_number, kw.get("token"))

def platform_fetch_issues(url, **kw):
    if detect_platform(url) == "bitbucket":
        return "Bitbucket issue tracker is not enabled by default.\n"
    return gh.fetch_issues(url, kw.get("token"))

def platform_fetch_branches(url, **kw):
    if detect_platform(url) == "bitbucket":
        return bb.fetch_branches(url, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return gh.fetch_branches(url, kw.get("token"))

def platform_fetch_commits(url, **kw):
    if detect_platform(url) == "bitbucket":
        return bb.fetch_commits(url, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return gh.fetch_commits(url, kw.get("token"))

def platform_fetch_summary(url, **kw):
    if detect_platform(url) == "bitbucket":
        return bb.fetch_repo_summary(url, kw.get("bb_user"), kw.get("bb_pass"), kw.get("bb_token"))
    return gh.fetch_repo_summary(url, kw.get("token"))

# ── Page config ────────────────────────────────────────────────────────

st.set_page_config(page_title="Repo QA Assistant", page_icon="🔍", layout="wide")

# Custom CSS
st.markdown("""
<style>
    .block-container { padding-top: 2rem; }
    [data-testid="stSidebar"] { min-width: 320px; }
    .stButton > button { border-radius: 8px; }
    div[data-testid="stMetric"] { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 12px; }
    .welcome-box { text-align: center; padding: 60px 20px; }
    .welcome-box h2 { margin-bottom: 8px; }
    .welcome-box p { color: #888; font-size: 1.1rem; }
</style>
""", unsafe_allow_html=True)

api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    st.error("API anahtarı bulunamadı. `.env` dosyasına `OPENAI_API_KEY` ekleyin.")
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
    "platform": None, "conversation_summary": "", "active_session_id": None,
}
for k, v in defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ── Sidebar ────────────────────────────────────────────────────────────

with st.sidebar:

    # ── Bitbucket OAuth callback ──
    bb_client_id, bb_client_secret = get_oauth_config()
    has_oauth = bool(bb_client_id and bb_client_secret)
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
            }
            st.session_state.bb_repos = list_user_repos(token_data["access_token"])
            st.query_params.clear()
            st.rerun()
        except Exception as e:
            st.error(f"OAuth hatası: {e}")
            st.query_params.clear()

    # ── Auth section ──
    logged_in = bool(st.session_state.bb_access_token and st.session_state.bb_user_info)

    if logged_in:
        user = st.session_state.bb_user_info
        col_user, col_logout = st.columns([3, 1])
        col_user.markdown(f"**{user['display_name']}**  \n`@{user['username']}`")
        if col_logout.button("✕", help="Çıkış yap"):
            for k in ("bb_access_token", "bb_user_info", "bb_repos"):
                st.session_state[k] = defaults[k]
            st.rerun()
    else:
        if has_oauth:
            redirect_uri = os.getenv("BB_REDIRECT_URI", "http://localhost:8501")
            auth_url = build_authorize_url(bb_client_id, redirect_uri)
            st.link_button("Bitbucket ile Giriş Yap", url=auth_url, use_container_width=True)
        else:
            st.button("Bitbucket ile Giriş Yap", use_container_width=True, disabled=True,
                       help="BB_CLIENT_ID ve BB_CLIENT_SECRET .env'de tanımlı değil")

    st.divider()

    # ── Repo selection ──
    repo_url = ""

    if logged_in and st.session_state.bb_repos:
        st.markdown("##### Repolarım")
        repos = st.session_state.bb_repos
        repo_options = {f"{r['full_name']}  {'🔒' if r['is_private'] else ''}" : r["url"] for r in repos}
        selected = st.selectbox(
            "Repo seç", options=[""] + list(repo_options.keys()),
            format_func=lambda x: x if x else "Repo seçin...",
            label_visibility="collapsed",
        )
        if selected and selected in repo_options:
            repo_url = repo_options[selected]

    st.markdown("##### Repo URL")
    manual_url = st.text_input(
        "URL", placeholder="https://github.com/user/repo",
        label_visibility="collapsed",
    )
    if manual_url:
        repo_url = manual_url

    # ── Platform credentials (only when needed) ──
    detected_platform = detect_platform(repo_url) if repo_url else None
    github_token = None
    bb_username = None
    bb_app_password = None

    if repo_url and detected_platform == "bitbucket" and not logged_in:
        with st.expander("Bitbucket kimlik bilgileri", expanded=False):
            bb_username = st.text_input("Username", placeholder="username", key="bb_user_input")
            bb_app_password = st.text_input("App Password", type="password", key="bb_pass_input")
    elif repo_url and detected_platform == "github":
        with st.expander("GitHub token", expanded=False):
            github_token = st.text_input("Token", type="password", placeholder="ghp_...", key="gh_token_input")

    # ── Load button ──
    load_btn = st.button(
        "Repoyu Yükle", type="primary", use_container_width=True,
        disabled=not bool(repo_url),
    )

    if load_btn and repo_url:
        if st.session_state.messages and st.session_state.repo_url:
            save_session(st.session_state.repo_url, st.session_state.messages)

        for k, v in defaults.items():
            st.session_state[k] = v
        st.session_state.github_token = github_token or os.getenv("GITHUB_TOKEN")
        st.session_state.bb_username = bb_username or os.getenv("BB_USERNAME")
        st.session_state.bb_app_password = bb_app_password or os.getenv("BB_APP_PASSWORD")
        st.session_state.platform = detected_platform

        kw = _api_kwargs()
        progress = st.progress(0, text="Klonlanıyor...")

        try:
            path = clone_repo(repo_url)
            st.session_state.repo_path = path
            st.session_state.repo_url = repo_url
            progress.progress(15, text="Dosyalar okunuyor...")

            tree = build_tree(path)
            files = read_repo_files(path)
            st.session_state.tree = tree
            st.session_state.files = files
            st.session_state.lang_stats = get_language_stats(files)
            st.session_state.code_health = get_code_health(files)
            progress.progress(30, text="API bilgileri çekiliyor...")

            pr_info = platform_fetch_prs(repo_url, **kw)
            issue_info = platform_fetch_issues(repo_url, **kw)
            branch_info = platform_fetch_branches(repo_url, **kw)
            summary = platform_fetch_summary(repo_url, **kw)
            st.session_state.repo_summary = summary
            progress.progress(50, text="Commit geçmişi...")

            commit_info = platform_fetch_commits(repo_url, **kw)
            st.session_state.commit_info = commit_info
            st.session_state.github_info = (
                f"## Pull Request'ler\n{pr_info}\n\n"
                f"## Issue'lar\n{issue_info}\n\n"
                f"## Branch'ler\n{branch_info}"
            )
            progress.progress(70, text="RAG indeksi...")

            st.session_state.collection = build_index(files, api_key)
            progress.progress(100, text="Tamamlandı!")
            st.toast("Repo yüklendi!")

        except Exception as e:
            st.error(f"Hata: {e}")

    # ── Sidebar info panels (only when repo loaded) ──
    if st.session_state.repo_summary:
        s = st.session_state.repo_summary
        st.divider()
        st.markdown("##### Repo")
        st.caption(s.get("description", "-"))
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Stars", s.get("stars", 0))
        c2.metric("Forks", s.get("forks", 0))
        c3.metric("Issues", s.get("open_issues", 0))
        c4.metric("PRs", s.get("open_prs", 0))

    if st.session_state.code_health:
        h = st.session_state.code_health
        st.divider()
        st.markdown("##### Kod Sağlığı")
        c1, c2 = st.columns(2)
        c1.metric("Dosya", h["total_files"])
        c2.metric("Satır", f"{h['total_lines']:,}")
        c1.metric("Test", f"{h['test_files']} ({h['test_ratio']}%)")
        c2.metric("Bağımlılık", h["dep_count"])

    if st.session_state.lang_stats:
        st.divider()
        st.markdown("##### Diller")
        for lang, count in list(st.session_state.lang_stats.items())[:6]:
            st.progress(min(count / max(sum(st.session_state.lang_stats.values()), 1), 1.0),
                        text=f"{lang} ({count})")

    # ── Session history ──
    sessions = list_sessions(5)
    if sessions:
        st.divider()
        st.markdown("##### Geçmiş")
        for sess in sessions:
            col_t, col_l, col_d = st.columns([4, 1, 1])
            col_t.caption(sess["title"][:35])
            if col_l.button("↗", key=f"l_{sess['id']}", help="Yükle"):
                url, msgs = load_session(sess["id"])
                if url and msgs:
                    st.session_state.repo_url = url
                    st.session_state.messages = msgs
                    st.rerun()
            if col_d.button("×", key=f"d_{sess['id']}", help="Sil"):
                delete_session(sess["id"])
                st.rerun()

    if st.session_state.repo_url:
        st.divider()
        st.caption(f"Aktif: `{st.session_state.repo_url.split('/')[-1]}`")

# ── Main area ──────────────────────────────────────────────────────────

if not st.session_state.get("collection") and not st.session_state.get("messages"):
    # Welcome screen
    st.markdown("""
    <div class="welcome-box">
        <h2>Repo QA Assistant</h2>
        <p>GitHub veya Bitbucket reponuzu yükleyin, kodunuz hakkında sorular sorun.</p>
    </div>
    """, unsafe_allow_html=True)

    st.markdown("---")
    col1, col2, col3 = st.columns(3)
    with col1:
        st.markdown("**Kod Analizi**  \nRepo yapısını, mimarisini ve kullanılan teknolojileri anlayın.")
    with col2:
        st.markdown("**PR İnceleme**  \nPull request'lerin ne yaptığını, diff'lerini ve etkisini öğrenin.")
    with col3:
        st.markdown("**Commit Takibi**  \nSon değişiklikleri, contributor aktivitesini ve geçmişi görün.")

    st.stop()

# ── Suggested questions ──
if st.session_state.get("collection") and not st.session_state.messages:
    st.markdown("#### Nereden başlamalı?")
    suggested = [
        ("Bu repo ne yapıyor?", "Genel bakış"),
        ("Açık PR'ları özetle", "PR durumu"),
        ("Proje mimarisini açıkla", "Mimari"),
        ("Son commit'leri göster", "Geçmiş"),
        ("Hangi teknolojiler kullanılmış?", "Tech stack"),
        ("Kod kalitesini değerlendir", "Kalite"),
    ]
    cols = st.columns(3)
    for i, (q, label) in enumerate(suggested):
        if cols[i % 3].button(label, key=f"s_{i}", use_container_width=True, help=q):
            st.session_state.messages.append({"role": "user", "content": q})
            st.rerun()
    st.markdown("---")

# ── Action bar ──
if st.session_state.messages:
    col1, col2, col3 = st.columns([1, 1, 1])
    with col1:
        if st.button("💾 Kaydet", use_container_width=True):
            save_session(st.session_state.repo_url or "unknown", st.session_state.messages)
            st.toast("Kaydedildi!")
    with col2:
        sid = save_session(st.session_state.repo_url or "unknown", st.session_state.messages)
        md = export_session_markdown(sid)
        st.download_button("📥 Export", data=md, file_name="chat_export.md",
                           mime="text/markdown", use_container_width=True)
    with col3:
        if st.button("🗑 Temizle", use_container_width=True):
            st.session_state.messages = []
            st.session_state.conversation_summary = ""
            st.rerun()

# ── Chat history ──
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# ── User input ──
if user_input := st.chat_input("Repo hakkında bir soru sorun..."):
    st.session_state.messages.append({"role": "user", "content": user_input})
    st.rerun()

# ── Response generation ────────────────────────────────────────────────

if st.session_state.messages and st.session_state.messages[-1]["role"] == "user":
    question = st.session_state.messages[-1]["content"]
    has_collection = st.session_state.get("collection") is not None
    kw = _api_kwargs()

    # PR diff + review comments
    pr_diff_context = ""
    pr_num = None

    # Explicit PR number: #10, PR #5, etc.
    pr_match = re.search(r"#(\d+)", question)
    if pr_match:
        pr_num = int(pr_match.group(1))

    # Implicit: "son PR", "last PR", "en son PR", "son pull request"
    if not pr_num and re.search(r"(son|last|latest|en son)\s*(pr|pull\s*request|çekme)", question, re.IGNORECASE):
        # Son PR numarasını github_info'dan çek
        num_match = re.search(r"PR #(\d+)", st.session_state.github_info or "")
        if num_match:
            pr_num = int(num_match.group(1))

    # PR hakkında genel soru (dosya, değişiklik, diff, review, test)
    if not pr_num and re.search(r"\bpr\b.*?(dosya|file|değişik|change|diff|review|test|içeri)", question, re.IGNORECASE):
        num_match = re.search(r"PR #(\d+)", st.session_state.github_info or "")
        if num_match:
            pr_num = int(num_match.group(1))

    if pr_num and st.session_state.repo_url:
        pr_diff_context = platform_fetch_pr_diff(
            st.session_state.repo_url, pr_num, **kw
        )
        if detect_platform(st.session_state.repo_url) == "github":
            token = kw.get("token")
            reviews = gh.fetch_pr_reviews(st.session_state.repo_url, pr_num, token)
            if reviews:
                pr_diff_context += "\n\n" + reviews

    # Multi-file context
    file_context = ""
    if has_collection and st.session_state.files:
        # Çoklu dosya referansı
        file_refs = detect_file_references(question)
        # Hata mesajından dosya yolları
        error_paths = detect_error_trace(question)
        all_refs = file_refs + [p for p in error_paths if p not in file_refs]

        found_files = []
        for ref in all_refs[:5]:  # max 5 dosya
            found = find_file(st.session_state.files, ref)
            if found and not found["content"].startswith("["):
                found_files.append(f"--- {found['path']} ---\n{found['content']}")
        if found_files:
            file_context = "\n\n".join(found_files) + "\n"

    # Model selection
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

    # Build prompt
    system_content = build_system_prompt(
        repo_url=st.session_state.repo_url or "",
        tree=st.session_state.tree or "",
        github_info=st.session_state.github_info or "",
        rag_context=rag_context,
        commit_info=st.session_state.commit_info or "",
        conversation_summary=st.session_state.conversation_summary,
        file_context=file_context,
    )

    api_messages = [{"role": "system", "content": system_content}]
    recent_count = 6 if st.session_state.conversation_summary else 10
    api_messages += [
        {"role": m["role"], "content": m["content"]}
        for m in st.session_state.messages[-recent_count:]
    ]

    with st.chat_message("assistant"):
        st.caption(f"Model: `{model}` · {complexity}")
        stream = stream_response(client, api_messages, model)
        response = st.write_stream(stream)

    st.session_state.messages.append({"role": "assistant", "content": response})
    st.rerun()
