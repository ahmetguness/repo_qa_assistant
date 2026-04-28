"""Repo klonlama, dosya okuma ve dizin ağacı oluşturma."""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

CACHE_DIR = Path(os.environ.get("REPO_CACHE_DIR", ".repo_cache"))

IGNORED_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "target", "bin", "obj",
    ".idea", ".vscode", ".kiro", ".tox", "egg-info",
}

TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h",
    ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".scala",
    ".html", ".css", ".scss", ".less", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg", ".conf",
    ".md", ".txt", ".rst", ".sh", ".bash", ".zsh", ".bat", ".ps1",
    ".sql", ".graphql", ".proto", ".dockerfile", ".env.example",
    ".gitignore", ".editorconfig", ".eslintrc", ".prettierrc",
}

ALWAYS_INCLUDE = {
    "Dockerfile", "Makefile", "Procfile", "Gemfile",
    "requirements.txt", "setup.py", "setup.cfg", "pyproject.toml",
    "package.json", "tsconfig.json", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "CMakeLists.txt",
}

PRIORITY_FILES = {
    "README.md", "README.rst", "README.txt", "README",
    "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "setup.py", "setup.cfg",
}

MAX_FILE_SIZE = 50_000
MAX_TOTAL_CHARS = 300_000


def _cache_key(repo_url: str) -> str:
    return hashlib.md5(repo_url.encode()).hexdigest()


def clone_repo(repo_url: str, use_cache: bool = True) -> str:
    """Repoyu klonlar veya cache'ten döndürür."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / _cache_key(repo_url)

    if use_cache and cache_path.exists():
        # Mevcut cache'i güncelle
        try:
            subprocess.run(
                ["git", "pull", "--ff-only"],
                capture_output=True, text=True, check=True,
                timeout=60, cwd=str(cache_path),
            )
            return str(cache_path)
        except Exception:
            # Pull başarısız olursa yeniden klonla
            shutil.rmtree(cache_path, ignore_errors=True)

    subprocess.run(
        ["git", "clone", "--depth", "1", repo_url, str(cache_path)],
        capture_output=True, text=True, check=True, timeout=120,
    )
    return str(cache_path)


def should_include(file_path: Path) -> bool:
    if file_path.name in ALWAYS_INCLUDE:
        return True
    return file_path.suffix.lower() in TEXT_EXTENSIONS


def _is_ignored(parts: tuple) -> bool:
    return any(p in IGNORED_DIRS for p in parts)


def build_tree(repo_path: str) -> str:
    """Repo dizin ağacını string olarak oluşturur."""
    lines = []
    root = Path(repo_path)
    for item in sorted(root.rglob("*")):
        rel = item.relative_to(root)
        if _is_ignored(rel.parts):
            continue
        indent = "  " * (len(rel.parts) - 1)
        name = item.name + ("/" if item.is_dir() else "")
        lines.append(f"{indent}{name}")
    return "\n".join(lines[:500])


def read_repo_files(repo_path: str) -> list[dict]:
    """Repo dosyalarını okuyup liste olarak döndürür.

    Returns:
        [{"path": "src/main.py", "content": "...", "priority": True}, ...]
    """
    root = Path(repo_path)
    files = []

    for file_path in sorted(root.rglob("*")):
        if not file_path.is_file():
            continue
        rel = file_path.relative_to(root)
        if _is_ignored(rel.parts):
            continue
        if not should_include(file_path):
            continue

        size = file_path.stat().st_size
        if size > MAX_FILE_SIZE:
            files.append({
                "path": str(rel),
                "content": f"[Dosya çok büyük, atlandı ({size} bytes)]",
                "priority": False,
            })
            continue

        try:
            text = file_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        files.append({
            "path": str(rel),
            "content": text,
            "priority": file_path.name in PRIORITY_FILES,
        })

    # Öncelikli dosyaları başa al
    files.sort(key=lambda f: (not f["priority"], f["path"]))
    return files


def files_to_context_string(files: list[dict]) -> str:
    """Dosya listesini tek bir context string'e çevirir."""
    parts = []
    total = 0
    for f in files:
        entry = f"--- {f['path']} ---\n{f['content']}\n"
        if total + len(entry) > MAX_TOTAL_CHARS:
            parts.append("\n[Toplam context limiti aşıldı, kalan dosyalar atlandı.]\n")
            break
        parts.append(entry)
        total += len(entry)
    return "\n".join(parts)


def get_language_stats(files: list[dict]) -> dict[str, int]:
    """Dosya uzantılarına göre dil dağılımı hesaplar."""
    ext_map = {
        ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
        ".tsx": "TypeScript", ".jsx": "JavaScript", ".java": "Java",
        ".c": "C", ".cpp": "C++", ".h": "C/C++", ".cs": "C#",
        ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
        ".swift": "Swift", ".kt": "Kotlin", ".scala": "Scala",
        ".html": "HTML", ".css": "CSS", ".scss": "SCSS",
        ".vue": "Vue", ".svelte": "Svelte",
    }
    stats: dict[str, int] = {}
    for f in files:
        ext = Path(f["path"]).suffix.lower()
        lang = ext_map.get(ext)
        if lang:
            stats[lang] = stats.get(lang, 0) + 1
    return dict(sorted(stats.items(), key=lambda x: -x[1]))


def find_file(files: list[dict], query: str) -> dict | None:
    """Dosya adına göre arama yapar. Tam eşleşme veya kısmi eşleşme."""
    query_lower = query.lower().replace("\\", "/")

    # Tam eşleşme
    for f in files:
        if f["path"].lower().replace("\\", "/") == query_lower:
            return f

    # Dosya adı eşleşmesi
    for f in files:
        if Path(f["path"]).name.lower() == Path(query_lower).name.lower():
            return f

    # Kısmi eşleşme
    for f in files:
        if query_lower in f["path"].lower().replace("\\", "/"):
            return f

    return None


def get_code_health(files: list[dict]) -> dict:
    """Basit kod kalite metrikleri hesaplar."""
    total_files = len(files)
    total_lines = 0
    test_files = 0
    large_files = 0
    sizes = []

    for f in files:
        content = f["content"]
        if content.startswith("["):
            large_files += 1
            continue

        lines = content.count("\n") + 1
        total_lines += lines
        sizes.append(lines)

        path_lower = f["path"].lower()
        if "test" in path_lower or "spec" in path_lower:
            test_files += 1

    avg_lines = round(total_lines / max(len(sizes), 1))
    max_lines = max(sizes) if sizes else 0

    # Bağımlılık sayısı
    dep_count = 0
    for f in files:
        name = Path(f["path"]).name
        if name == "package.json" and not f["content"].startswith("["):
            try:
                import json
                pkg = json.loads(f["content"])
                dep_count += len(pkg.get("dependencies", {}))
                dep_count += len(pkg.get("devDependencies", {}))
            except Exception:
                pass
        elif name == "requirements.txt" and not f["content"].startswith("["):
            dep_count += len([
                l for l in f["content"].splitlines()
                if l.strip() and not l.strip().startswith("#")
            ])
        elif name == "pyproject.toml" and not f["content"].startswith("["):
            dep_count += f["content"].count(">=") + f["content"].count("==")

    return {
        "total_files": total_files,
        "total_lines": total_lines,
        "avg_lines": avg_lines,
        "max_lines": max_lines,
        "test_files": test_files,
        "test_ratio": round(test_files / max(total_files, 1) * 100, 1),
        "large_files": large_files,
        "dep_count": dep_count,
    }

