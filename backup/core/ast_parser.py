"""AST-aware code parsing using tree-sitter.

Extracts functions, classes, and methods as semantic chunks
instead of blind character-based splitting.
"""

from pathlib import Path
import tree_sitter as ts

# ── Language registry ──────────────────────────────────────────────────

_LANGUAGES: dict[str, ts.Language] = {}

_EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "cpp",
    ".cs": "c_sharp",
    ".rb": "ruby",
}

# Node types that represent top-level code units per language
_UNIT_TYPES: dict[str, set[str]] = {
    "python": {
        "function_definition", "class_definition",
        "decorated_definition",
    },
    "javascript": {
        "function_declaration", "class_declaration",
        "export_statement", "lexical_declaration",
        "expression_statement",
    },
    "typescript": {
        "function_declaration", "class_declaration",
        "export_statement", "lexical_declaration",
        "interface_declaration", "type_alias_declaration",
        "enum_declaration", "expression_statement",
    },
    "java": {
        "class_declaration", "interface_declaration",
        "enum_declaration", "method_declaration",
    },
    "go": {
        "function_declaration", "method_declaration",
        "type_declaration",
    },
    "rust": {
        "function_item", "impl_item", "struct_item",
        "enum_item", "trait_item", "mod_item",
    },
    "c": {
        "function_definition", "struct_specifier",
        "enum_specifier", "declaration",
    },
    "cpp": {
        "function_definition", "class_specifier",
        "struct_specifier", "namespace_definition",
        "template_declaration",
    },
    "c_sharp": {
        "class_declaration", "interface_declaration",
        "method_declaration", "namespace_declaration",
        "enum_declaration",
    },
    "ruby": {
        "method", "class", "module", "singleton_method",
    },
}


def _get_language(lang_name: str) -> ts.Language | None:
    """Lazily loads and caches a tree-sitter language."""
    if lang_name in _LANGUAGES:
        return _LANGUAGES[lang_name]

    try:
        if lang_name == "python":
            import tree_sitter_python as tsp
            _LANGUAGES[lang_name] = ts.Language(tsp.language())
        elif lang_name == "javascript":
            import tree_sitter_javascript as tsjs
            _LANGUAGES[lang_name] = ts.Language(tsjs.language())
        elif lang_name == "typescript":
            import tree_sitter_typescript as tsts
            _LANGUAGES[lang_name] = ts.Language(tsts.language_typescript())
        elif lang_name == "java":
            import tree_sitter_java as tsj
            _LANGUAGES[lang_name] = ts.Language(tsj.language())
        elif lang_name == "go":
            import tree_sitter_go as tsg
            _LANGUAGES[lang_name] = ts.Language(tsg.language())
        elif lang_name == "rust":
            import tree_sitter_rust as tsr
            _LANGUAGES[lang_name] = ts.Language(tsr.language())
        elif lang_name == "c":
            import tree_sitter_c as tsc
            _LANGUAGES[lang_name] = ts.Language(tsc.language())
        elif lang_name == "cpp":
            import tree_sitter_cpp as tscpp
            _LANGUAGES[lang_name] = ts.Language(tscpp.language())
        elif lang_name == "c_sharp":
            import tree_sitter_c_sharp as tscs
            _LANGUAGES[lang_name] = ts.Language(tscs.language())
        elif lang_name == "ruby":
            import tree_sitter_ruby as tsrb
            _LANGUAGES[lang_name] = ts.Language(tsrb.language())
        else:
            return None
        return _LANGUAGES[lang_name]
    except Exception:
        return None


def detect_language(file_path: str) -> str | None:
    """Detects language from file extension."""
    ext = Path(file_path).suffix.lower()
    return _EXT_TO_LANG.get(ext)


def _extract_name(node, source_bytes: bytes) -> str:
    """Extracts the name of a function/class node."""
    # Look for a 'name' or 'identifier' child
    for child in node.children:
        if child.type in ("identifier", "name", "property_identifier"):
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="ignore")
        # For decorated definitions, look deeper
        if child.type in ("function_definition", "class_definition"):
            return _extract_name(child, source_bytes)
    return ""


def _get_node_text(node, source_bytes: bytes) -> str:
    return source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="ignore")


def _classify_node(node, lang: str) -> str | None:
    """Returns the semantic type if this node is a code unit, else None."""
    unit_types = _UNIT_TYPES.get(lang, set())
    if node.type in unit_types:
        return node.type
    return None


MAX_CHUNK_CHARS = 3000  # Large functions get split further


def parse_file(file_path: str, content: str) -> list[dict]:
    """Parses a source file into semantic chunks.

    Returns:
        [
            {
                "path": "src/main.py",
                "name": "calculate_total",
                "type": "function_definition",
                "content": "def calculate_total(items): ...",
                "start_line": 10,
                "end_line": 25,
                "language": "python",
            },
            ...
        ]
    """
    lang_name = detect_language(file_path)
    if not lang_name:
        return []

    language = _get_language(lang_name)
    if not language:
        return []

    try:
        parser = ts.Parser(language)
        source_bytes = content.encode("utf-8")
        tree = parser.parse(source_bytes)
    except Exception:
        return []

    chunks = []
    covered_ranges: list[tuple[int, int]] = []

    def walk(node, depth=0):
        sem_type = _classify_node(node, lang_name)
        if sem_type:
            text = _get_node_text(node, source_bytes)
            name = _extract_name(node, source_bytes)

            if len(text) > MAX_CHUNK_CHARS:
                # Large node: try to split into child methods/functions
                child_chunks = []
                for child in node.children:
                    child_type = _classify_node(child, lang_name)
                    if child_type:
                        child_text = _get_node_text(child, source_bytes)
                        child_name = _extract_name(child, source_bytes)
                        child_chunks.append({
                            "path": file_path,
                            "name": f"{name}.{child_name}" if name and child_name else child_name or name,
                            "type": child_type,
                            "content": child_text,
                            "start_line": child.start_point.row + 1,
                            "end_line": child.end_point.row + 1,
                            "language": lang_name,
                        })
                        covered_ranges.append((child.start_byte, child.end_byte))

                if child_chunks:
                    # Add the class/struct signature (without method bodies)
                    sig_lines = []
                    for line in text.split("\n")[:5]:
                        sig_lines.append(line)
                    chunks.append({
                        "path": file_path,
                        "name": name,
                        "type": sem_type,
                        "content": "\n".join(sig_lines) + "\n    # ... (methods listed separately)",
                        "start_line": node.start_point.row + 1,
                        "end_line": node.start_point.row + len(sig_lines),
                        "language": lang_name,
                    })
                    chunks.extend(child_chunks)
                else:
                    # No child units, split by lines
                    lines = text.split("\n")
                    for i in range(0, len(lines), 50):
                        part = "\n".join(lines[i:i+50])
                        chunks.append({
                            "path": file_path,
                            "name": f"{name} (part {i//50+1})" if name else f"(part {i//50+1})",
                            "type": sem_type,
                            "content": part,
                            "start_line": node.start_point.row + 1 + i,
                            "end_line": node.start_point.row + 1 + min(i+50, len(lines)),
                            "language": lang_name,
                        })

                covered_ranges.append((node.start_byte, node.end_byte))
                return  # Don't recurse further

            chunks.append({
                "path": file_path,
                "name": name,
                "type": sem_type,
                "content": text,
                "start_line": node.start_point.row + 1,
                "end_line": node.end_point.row + 1,
                "language": lang_name,
            })
            covered_ranges.append((node.start_byte, node.end_byte))
            return  # Don't recurse into children of captured nodes

        for child in node.children:
            walk(child, depth + 1)

    walk(tree.root_node)

    # Capture top-level code not inside any function/class (imports, constants, etc.)
    if chunks:
        all_lines = content.split("\n")
        covered_lines = set()
        for c in chunks:
            for ln in range(c["start_line"], c["end_line"] + 1):
                covered_lines.add(ln)

        uncovered = []
        current_block: list[str] = []
        block_start = 0

        for i, line in enumerate(all_lines, 1):
            if i not in covered_lines:
                if not current_block:
                    block_start = i
                current_block.append(line)
            else:
                if current_block and any(l.strip() for l in current_block):
                    uncovered.append({
                        "path": file_path,
                        "name": "(module-level)",
                        "type": "module",
                        "content": "\n".join(current_block),
                        "start_line": block_start,
                        "end_line": block_start + len(current_block) - 1,
                        "language": lang_name,
                    })
                current_block = []

        if current_block and any(l.strip() for l in current_block):
            uncovered.append({
                "path": file_path,
                "name": "(module-level)",
                "type": "module",
                "content": "\n".join(current_block),
                "start_line": block_start,
                "end_line": block_start + len(current_block) - 1,
                "language": lang_name,
            })

        chunks = uncovered + chunks  # Module-level first

    return chunks
