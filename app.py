import os
import re

from dotenv import load_dotenv
from openai import OpenAI
import streamlit as st

from core.github_client import (
    fetch_branches,
    fetch_commits,
    fetch_issues,
    fetch_pr_diff,
    fetch_pull_requests,
    fetch_repo_summary,
)
from core.repo_loader import (
    build_tree,
    clone_repo,
    find_file,
    get_code_health,
    get_language_stats,
    read_repo_files,
)
from core.indexer import build_index, query_index
from core.chat import (
    build_system_prompt,
    detect_complexity,
    detect_file_reference,
    get_model,
    stream_response,
    summarize_conversation,
)
from core.storage import (
    delete_session,
    export_session_markdown,
    list_sessions,
    load_session,
    save_session,
)

load_dotenv()

# ── Sayfa ayarları ─────────────────────────────────────────────────────

st.set_page_config(page_title="Repo QA Assistant", page_icon="🔍", layout="wide")

api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    st.error("API anahtarı bulunamadı. .env dosyasına OPENAI_API_KEY ekleyin.")
    st.stop()

client = OpenAI(api_key=api_key)

# ── Session state başlat ──────────────────────────────────────────────

defaults = {
    "messages": [],
    "repo_url": None,
    "repo_path": None,
    "tree": None,
    "github_info": None,
    "commit_info": None,
    "files": None,
    "collection": None,
    "repo_summary": {},
    "lang_stats": {},
    "code_health": {},
    "github_token": None,
    "conversation_summary": "",
    "active_session_id": None,
}
for key, default in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = default

# ── Sidebar ────────────────────────────────────────────────────────────

with st.sidebar:
    st.header("📦 GitHub Repo")
    repo_url = st.text_input("Repo URL", placeholder="https://github.com/user/repo")
    github_token = st.text_input(
        "GitHub Token (opsiyonel)", type="password", placeholder="ghp_...",
        help="Private repolar ve yüksek API limiti için.",
    )
    load_btn = st.button("🚀 Repoyu Yükle", type="primary", use_container_width=True)

    if load_btn and repo_url:
        # Mevcut oturumu kaydet
        if st.session_state.messages and st.session_state.repo_url:
            save_session(st.session_state.repo_url, st.session_state.messages)

        # Sıfırla
        for key, default in defaults.items():
            st.session_state[key] = default
        token = github_token or os.getenv("GITHUB_TOKEN")
        st.session_state.github_token = token

        progress = st.progress(0, text="Repo klonlanıyor...")

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
            progress.progress(30, text="GitHub bilgileri çekiliyor...")

            pr_info = fetch_pull_requests(repo_url, token)
            issue_info = fetch_issues(repo_url, token)
            branch_info = fetch_branches(repo_url, token)
            summary = fetch_repo_summary(repo_url, token)
            st.session_state.repo_summary = summary
            progress.progress(50, text="Commit geçmişi çekiliyor...")

            commit_info = fetch_commits(repo_url, token)
            st.session_state.commit_info = commit_info

            github_info = (
                f"## Pull Request'ler\n{pr_info}\n\n"
                f"## Issue'lar\n{issue_info}\n\n"
                f"## Branch'ler\n{branch_info}"
            )
            st.session_state.github_info = github_info
            progress.progress(70, text="RAG indeksi oluşturuluyor...")

            collection = build_index(files, api_key)
            st.session_state.collection = collection
            progress.progress(100, text="Tamamlandı!")

            st.success(f"✅ Repo yüklendi!")

        except Exception as e:
            st.error(f"Hata: {e}")

    # ── Repo Özeti ──
    if st.session_state.repo_summary:
        s = st.session_state.repo_summary
        st.divider()
        st.subheader("📊 Repo Özeti")
        col1, col2 = st.columns(2)
        col1.metric("⭐ Stars", s.get("stars", 0))
        col2.metric("🍴 Forks", s.get("forks", 0))
        col1.metric("🐛 Issues", s.get("open_issues", 0))
        col2.metric("🔀 Açık PR", s.get("open_prs", 0))
        if s.get("description"):
            st.caption(s["description"])

    # ── Kod Sağlık Kartı ──
    if st.session_state.code_health:
        h = st.session_state.code_health
        st.divider()
        st.subheader("🏥 Kod Sağlığı")
        col1, col2 = st.columns(2)
        col1.metric("📄 Dosya", h["total_files"])
        col2.metric("📝 Satır", f"{h['total_lines']:,}")
        col1.metric("🧪 Test", f"{h['test_files']} (%{h['test_ratio']})")
        col2.metric("📦 Bağımlılık", h["dep_count"])
        if h["large_files"]:
            st.caption(f"⚠️ {h['large_files']} dosya çok büyük (>50KB)")

    # ── Dil Dağılımı ──
    if st.session_state.lang_stats:
        st.divider()
        st.subheader("💻 Diller")
        for lang, count in st.session_state.lang_stats.items():
            st.text(f"  {lang}: {count} dosya")

    # ── Geçmiş Oturumlar ──
    st.divider()
    st.subheader("📜 Geçmiş Oturumlar")
    sessions = list_sessions(10)
    if sessions:
        for sess in sessions:
            col_title, col_load, col_del = st.columns([3, 1, 1])
            col_title.caption(f"{sess['title'][:40]}")
            if col_load.button("📂", key=f"load_{sess['id']}", help="Yükle"):
                url, msgs = load_session(sess["id"])
                if url and msgs:
                    st.session_state.repo_url = url
                    st.session_state.messages = msgs
                    st.session_state.active_session_id = sess["id"]
                    st.rerun()
            if col_del.button("🗑️", key=f"del_{sess['id']}", help="Sil"):
                delete_session(sess["id"])
                st.rerun()
    else:
        st.caption("Henüz kayıtlı oturum yok.")

    if st.session_state.repo_url:
        st.divider()
        st.caption(f"Aktif: {st.session_state.repo_url}")

# ── Ana Alan ───────────────────────────────────────────────────────────

st.title("🔍 Repo QA Assistant")

if not st.session_state.get("collection") and not st.session_state.get("messages"):
    st.info("Başlamak için sol panelden bir GitHub repo URL'si girin ve 'Repoyu Yükle' butonuna tıklayın.")
    st.stop()

# ── Önerilen Sorular ──
if st.session_state.get("collection"):
    suggested = [
        "Bu repo ne yapıyor?",
        "Açık PR'ları özetle",
        "Proje mimarisini açıkla",
        "Son commit'leri göster",
        "Hangi teknolojiler kullanılmış?",
        "Kod kalitesini değerlendir",
    ]
    cols = st.columns(3)
    for i, q in enumerate(suggested):
        if cols[i % 3].button(q, key=f"suggest_{i}", use_container_width=True):
            st.session_state.messages.append({"role": "user", "content": q})
            st.rerun()

st.divider()

# ── Export Butonu ──
if st.session_state.messages:
    col_export, col_save, col_clear = st.columns([1, 1, 1])
    with col_export:
        # Mevcut oturumu kaydet ve markdown oluştur
        if st.button("📥 Markdown Export", use_container_width=True):
            sid = save_session(
                st.session_state.repo_url or "unknown",
                st.session_state.messages,
            )
            md = export_session_markdown(sid)
            st.download_button(
                "⬇️ İndir",
                data=md,
                file_name="chat_export.md",
                mime="text/markdown",
                use_container_width=True,
            )
    with col_save:
        if st.button("💾 Oturumu Kaydet", use_container_width=True):
            save_session(
                st.session_state.repo_url or "unknown",
                st.session_state.messages,
            )
            st.toast("Oturum kaydedildi!")
    with col_clear:
        if st.button("🗑️ Sohbeti Temizle", use_container_width=True):
            st.session_state.messages = []
            st.session_state.conversation_summary = ""
            st.rerun()

# ── Chat Geçmişi ──
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# ── Kullanıcı Mesajı ──
if user_input := st.chat_input("Repo hakkında bir soru sorun..."):
    st.session_state.messages.append({"role": "user", "content": user_input})
    st.rerun()

# ── Yanıt Üretimi ─────────────────────────────────────────────────────

if st.session_state.messages and st.session_state.messages[-1]["role"] == "user":
    question = st.session_state.messages[-1]["content"]

    # Koleksiyon yoksa (eski oturum yüklendi) sadece geçmişle cevapla
    has_collection = st.session_state.get("collection") is not None

    # PR diff tespiti
    pr_match = re.search(r"#(\d+)", question)
    pr_diff_context = ""
    if pr_match and st.session_state.repo_url:
        pr_number = int(pr_match.group(1))
        token = st.session_state.get("github_token") or os.getenv("GITHUB_TOKEN")
        pr_diff_context = fetch_pr_diff(st.session_state.repo_url, pr_number, token)

    # Dosya bazlı sorgulama
    file_context = ""
    if has_collection and st.session_state.files:
        file_ref = detect_file_reference(question)
        if file_ref:
            found = find_file(st.session_state.files, file_ref)
            if found and not found["content"].startswith("["):
                file_context = f"--- {found['path']} ---\n{found['content']}\n"

    # Karmaşıklık ve model
    complexity = detect_complexity(question)
    model = get_model(complexity)

    # RAG context
    rag_context = ""
    if has_collection:
        rag_context = query_index(question, st.session_state.collection, api_key)

    if pr_diff_context:
        rag_context = pr_diff_context + "\n\n" + rag_context

    # Konuşma özeti (10+ mesajda)
    if len(st.session_state.messages) > 10 and not st.session_state.conversation_summary:
        st.session_state.conversation_summary = summarize_conversation(
            client, st.session_state.messages
        )

    # System prompt
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

    # Son mesajlar (özet varsa son 6, yoksa son 10)
    recent_count = 6 if st.session_state.conversation_summary else 10
    api_messages += [
        {"role": m["role"], "content": m["content"]}
        for m in st.session_state.messages[-recent_count:]
    ]

    with st.chat_message("assistant"):
        st.caption(f"🤖 Model: `{model}` | Mod: `{complexity}`")
        stream = stream_response(client, api_messages, model)
        response = st.write_stream(stream)

    st.session_state.messages.append({"role": "assistant", "content": response})
    st.rerun()
