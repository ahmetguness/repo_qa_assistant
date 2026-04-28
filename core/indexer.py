"""RAG: Dosyaları chunk'lara böl, embedding oluştur, ChromaDB'de sakla."""

import hashlib
import chromadb
from openai import OpenAI

CHUNK_SIZE = 1500  # karakter
CHUNK_OVERLAP = 200
TOP_K = 12  # sorgu başına döndürülecek chunk sayısı
EMBEDDING_MODEL = "text-embedding-3-small"


def _chunk_text(text: str, path: str) -> list[dict]:
    """Metni örtüşen parçalara böler."""
    chunks = []
    start = 0
    idx = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end]
        chunks.append({
            "id": f"{hashlib.md5((path + str(idx)).encode()).hexdigest()}",
            "text": chunk,
            "metadata": {"path": path, "chunk_index": idx},
        })
        start += CHUNK_SIZE - CHUNK_OVERLAP
        idx += 1
    return chunks


def build_index(
    files: list[dict],
    api_key: str,
    collection_name: str = "repo",
) -> chromadb.Collection:
    """Dosyaları chunk'layıp ChromaDB collection'ına yazar."""
    client = chromadb.Client()

    # Mevcut collection varsa sil, yeniden oluştur
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
    collection = client.create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )

    # Tüm chunk'ları topla
    all_chunks = []
    for f in files:
        if f["content"].startswith("["):  # atlanmış dosya
            continue
        all_chunks.extend(_chunk_text(f["content"], f["path"]))

    if not all_chunks:
        return collection

    # Batch embedding (OpenAI max 2048 input per request)
    openai_client = OpenAI(api_key=api_key)
    batch_size = 100
    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        texts = [c["text"] for c in batch]

        response = openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=texts,
        )
        embeddings = [item.embedding for item in response.data]

        collection.add(
            ids=[c["id"] for c in batch],
            documents=texts,
            metadatas=[c["metadata"] for c in batch],
            embeddings=embeddings,
        )

    return collection


def query_index(
    question: str,
    collection: chromadb.Collection,
    api_key: str,
    top_k: int = TOP_K,
) -> str:
    """Soruya en yakın chunk'ları döndürür."""
    if collection.count() == 0:
        return ""

    openai_client = OpenAI(api_key=api_key)
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=[question],
    )
    query_embedding = response.data[0].embedding

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(top_k, collection.count()),
    )

    if not results["documents"] or not results["documents"][0]:
        return ""

    context_parts = []
    seen_paths = set()
    for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
        path = meta["path"]
        header = f"--- {path} (chunk {meta['chunk_index']}) ---" if path not in seen_paths else ""
        if header:
            seen_paths.add(path)
            context_parts.append(header)
        context_parts.append(doc)

    return "\n".join(context_parts)
