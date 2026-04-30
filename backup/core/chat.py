"""OpenAI chat entegrasyonu: model seçimi, mesaj oluşturma, konuşma özeti."""

import re
from openai import OpenAI


def detect_complexity(question: str) -> str:
    """Sorunun karmaşıklığına göre model seçer.

    Returns:
        "direct" — API çağrısı gerekmez, doğrudan veriyle cevaplanır
        "light"  — gpt-4o-mini
        "deep"   — gpt-4o
    """
    q = question.lower().strip()

    direct_patterns = [
        r"^(kaç|kaçtane|kaç tane).*(dosya|branch|pr|issue)",
        r"^(listele|göster).*(branch|dosya|pr|issue)",
        r"^hangi (diller|branch)",
    ]
    for pat in direct_patterns:
        if re.search(pat, q):
            return "direct"

    deep_keywords = [
        "mimari", "architecture", "refactor", "güvenlik", "security",
        "performans optimizasyonu", "tasarım deseni", "design pattern",
        "code review", "kapsamlı analiz", "tüm kodu incele",
        "commit geçmişi", "contributor", "katkıda bulunan",
    ]
    for kw in deep_keywords:
        if kw in q:
            return "deep"

    return "light"


def get_model(complexity: str) -> str:
    if complexity == "deep":
        return "gpt-4o"
    return "gpt-4o-mini"


def detect_file_reference(question: str) -> str | None:
    """Soruda dosya referansı varsa dosya yolunu döndürür.

    Handles:
    - Quoted: 'test.py', "app.js", `main.go`
    - With extension: test-results.md dosyası, app.py file
    - Path-like: src/main.py, core/utils.ts
    - Natural language: "test results dosyasına bak" → test-results
    """
    q = question.strip()

    # 1. Quoted file names
    m = re.search(r"['\"`]([^'\"` ]+\.\w{1,5})['\"`]", q)
    if m:
        return m.group(1)

    # 2. Explicit file with extension
    m = re.search(r"(\S+\.\w{1,5})\s+(dosya|file|içeriğ|açıkla)", q, re.IGNORECASE)
    if m and not m.group(1).startswith("http"):
        return m.group(1)

    m = re.search(r"(dosya|file)\s+(\S+\.\w{1,5})", q, re.IGNORECASE)
    if m and not m.group(2).startswith("http"):
        return m.group(2)

    # 3. Path-like references
    m = re.search(r"(\S+/\S+\.\w{1,5})", q)
    if m and not m.group(1).startswith("http"):
        return m.group(1)

    # 4. Natural language: "test results dosyasına bak" → search for "test-results" or "test_results"
    nl_patterns = [
        r"(\w[\w\s-]{1,30})\s+dosya(?:sın|ların|ya|sı|lar)?",
        r"(\w[\w\s-]{1,30})\s+file",
        r"(?:bak|aç|göster|oku|incele)\s+(\w[\w\s-]{1,30}?)(?:\s|$)",
    ]
    for pat in nl_patterns:
        m = re.search(pat, q, re.IGNORECASE)
        if m:
            name = (m.group(1) if m.group(1) else m.group(2) if m.lastindex and m.lastindex >= 2 else "").strip()
            if name and len(name) > 2:
                # Convert "test results" → "test-results" for matching
                return name.replace(" ", "-")

    return None


def detect_file_references(question: str) -> list[str]:
    """Soruda birden fazla dosya referansı varsa hepsini döndürür."""
    refs = []
    q = question.strip()

    # Quoted file names (all of them)
    for m in re.finditer(r"['\"`]([^'\"` ]+\.\w{1,5})['\"`]", q):
        refs.append(m.group(1))

    # Files with extension
    for m in re.finditer(r"(?<!\w)(\S+\.\w{1,5})(?:\s|$|,|;)", q):
        candidate = m.group(1)
        if not candidate.startswith("http") and candidate not in refs:
            refs.append(candidate)

    # Path-like
    for m in re.finditer(r"(\S+/\S+\.\w{1,5})", q):
        candidate = m.group(1)
        if not candidate.startswith("http") and candidate not in refs:
            refs.append(candidate)

    # Natural language fallback (only if nothing found yet)
    if not refs:
        ref = detect_file_reference(question)
        if ref:
            refs.append(ref)

    return refs


def detect_error_trace(question: str) -> list[str]:
    """Soruda hata mesajı / stack trace varsa ilgili dosya yollarını çıkarır."""
    paths = []
    # Python traceback: File "src/main.py", line 42
    for m in re.finditer(r'File "([^"]+)"', question):
        paths.append(m.group(1))
    # Generic: at src/main.py:42 or src/main.py line 42
    for m in re.finditer(r"(?:at |in )(\S+\.\w{1,5})(?::\d+| line \d+)", question):
        paths.append(m.group(1))
    # Java/JS: at com.example.Main(Main.java:42)
    for m in re.finditer(r"\((\S+\.\w{1,5}):\d+\)", question):
        paths.append(m.group(1))
    # Node: /src/index.js:15:3
    for m in re.finditer(r"(/?\S+\.\w{1,5}):\d+:\d+", question):
        paths.append(m.group(1))
    return list(dict.fromkeys(paths))  # deduplicate, preserve order


def summarize_conversation(client: OpenAI, messages: list[dict]) -> str:
    """Uzun konuşma geçmişini özetler."""
    if len(messages) < 6:
        return ""

    conversation_text = "\n".join(
        f"{'Kullanıcı' if m['role'] == 'user' else 'Asistan'}: {m['content'][:300]}"
        for m in messages[:-4]  # son 4 mesaj hariç, onlar tam gönderilecek
    )

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "Aşağıdaki konuşmayı 3-5 cümleyle Türkçe özetle. "
                           "Önemli teknik detayları ve kararları koru.",
            },
            {"role": "user", "content": conversation_text},
        ],
        max_tokens=300,
    )
    return response.choices[0].message.content or ""


def build_system_prompt(
    repo_url: str,
    tree: str,
    github_info: str,
    rag_context: str,
    commit_info: str = "",
    conversation_summary: str = "",
    file_context: str = "",
) -> str:
    """System prompt'u oluşturur."""
    parts = [
        "Sen bir GitHub repo analiz asistanısın. "
        "Kullanıcı sana bir reponun yapısını, GitHub bilgilerini ve "
        "ilgili kod parçalarını verdi. Bunlara dayanarak soruları yanıtla.\n\n"
        "Kurallar:\n"
        "- Cevaplarını Türkçe ver.\n"
        "- Kod örnekleri gösterirken markdown kullan.\n"
        "- Emin olmadığın konularda bunu belirt.\n"
        "- PR diff'leri hakkında sorulduğunda değişiklikleri detaylı açıkla.\n"
        "- Commit geçmişi sorulduğunda tarih ve yazar bilgilerini dahil et.\n"
        "- Kısa ve net cevaplar ver, gereksiz uzatma.\n\n",
        f"## Repo: {repo_url}\n\n",
        f"## Dizin Yapısı\n```\n{tree}\n```\n\n",
        f"## GitHub Bilgileri\n{github_info}\n\n",
    ]

    if commit_info:
        parts.append(f"## Commit Geçmişi\n{commit_info}\n\n")

    if conversation_summary:
        parts.append(f"## Önceki Konuşma Özeti\n{conversation_summary}\n\n")

    if file_context:
        parts.append(f"## İstenen Dosya İçeriği\n{file_context}\n\n")

    parts.append(f"## İlgili Kod Parçaları (RAG)\n{rag_context}\n")

    return "".join(parts)


def stream_response(client: OpenAI, messages: list[dict], model: str):
    """Streaming chat completion döndürür."""
    return client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
    )
