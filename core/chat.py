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
    """Soruda dosya referansı varsa dosya yolunu döndürür."""
    patterns = [
        r"['\"`]([^'\"` ]+\.\w{1,5})['\"`]",
        r"(\S+\.\w{1,5})\s+(dosya|file)",
        r"(dosya|file)\s+(\S+\.\w{1,5})",
        r"(\S+/\S+\.\w{1,5})",
    ]
    for pat in patterns:
        match = re.search(pat, question)
        if match:
            # En uzun grubu al (dosya yolu olma ihtimali yüksek)
            groups = [g for g in match.groups() if g and "." in g and "/" in g or g.count(".") == 1]
            if groups:
                candidate = max(groups, key=len)
                if not candidate.startswith("http"):
                    return candidate
    return None


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
