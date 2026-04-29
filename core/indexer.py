"""RAG: AST-aware chunking + embedding + ChromaDB vector search."""

import hashlib
import chromadb
from openai import OpenAI
from core.ast_parser import parse_file, detect_language

CHUNK_SIZE = 1500  # fallback for non-parseable files
CHUNK_OVERLAP = 200
TOP_K = 12
EMBEDDING_MODEL = "text-embedding-3-small"


def _chunk_text_fallback(text: str, path: str) -> list[dict]:
    """Fallback: blind character-based chunking for non-code files."""
    chunks = []
    start = 0
    idx = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end]
        chunk_id = hashlib.md5((path + "_fb_" + str(idx) + str(start)).encode()).hexdigest()
        chunks.append({
            "id": chunk_id,
            "text": chunk,
            "metadata": {
                "path": path,
                "chunk_index": idx,
                "name": "",
                "type": "text",
                "language": "",
                "start_line": 0,
                "end_line": 0,
            },
        })
        start += CHUNK_SIZE - CHUNK_OVERLAP
        idx += 1
    return chunks


def _ast_chunks_to_index_chunks(ast_chunks: list[dict]) -> list[dict]:
    """Converts AST parser output to indexer format with rich metadata."""
    results = []
    seen_ids = set()
    for i, c in enumerate(ast_chunks):
        header = f"# {c['path']} — {c['name']} ({c['type']})\n" if c["name"] else f"# {c['path']}\n"
        text = header + c["content"]

        # Unique ID: path + name + start_line + index to avoid collisions
        chunk_id = hashlib.md5(
            (c["path"] + c.get("name", "") + str(c.get("start_line", 0)) + str(i)).encode()
        ).hexdigest()

        # Ensure uniqueness
        while chunk_id in seen_ids:
            chunk_id = hashlib.md5((chunk_id + str(i)).encode()).hexdigest()
        seen_ids.add(chunk_id)

        results.append({
            "id": chunk_id,
            "text": text,
            "metadata": {
                "path": c["path"],
                "chunk_index": i,
                "name": c.get("name", ""),
                "type": c.get("type", ""),
                "language": c.get("language", ""),
                "start_line": c.get("start_line", 0),
                "end_line": c.get("end_line", 0),
            },
        })
    return results


def _chunk_file(path: str, content: str) -> list[dict]:
    """Chunks a file using AST parsing if possible, fallback otherwise."""
    if content.startswith("["):  # skipped file marker
        return []

    lang = detect_language(path)
    if lang:
        ast_chunks = parse_file(path, content)
        if ast_chunks:
            return _ast_chunks_to_index_chunks(ast_chunks)

    # Fallback for non-code or unparseable files
    return _chunk_text_fallback(content, path)


def build_index(
    files: list[dict],
    api_key: str,
    collection_name: str = "repo",
) -> chromadb.Collection:
    """Chunks files (AST-aware when possible), embeds, stores in ChromaDB."""
    client = chromadb.Client()

    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
    collection = client.create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks = []
    global_ids = set()
    for f in files:
        file_chunks = _chunk_file(f["path"], f["content"])
        for chunk in file_chunks:
            if chunk["id"] in global_ids:
                chunk["id"] = hashlib.md5((chunk["id"] + f["path"] + str(len(all_chunks))).encode()).hexdigest()
            global_ids.add(chunk["id"])
            all_chunks.append(chunk)

    if not all_chunks:
        return collection

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
    """Queries the index and returns relevant code chunks with rich context."""
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
    seen = set()
    for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
        path = meta.get("path", "")
        name = meta.get("name", "")
        sem_type = meta.get("type", "")
        lang = meta.get("language", "")
        start = meta.get("start_line", 0)
        end = meta.get("end_line", 0)

        # Deduplicate
        key = f"{path}:{name}:{start}"
        if key in seen:
            continue
        seen.add(key)

        # Build header
        loc = f"L{start}-{end}" if start else ""
        label = f"{name} ({sem_type})" if name else sem_type or "text"
        header = f"--- {path} · {label} {loc} ---"

        context_parts.append(header)
        context_parts.append(doc)
        context_parts.append("")

    return "\n".join(context_parts)
