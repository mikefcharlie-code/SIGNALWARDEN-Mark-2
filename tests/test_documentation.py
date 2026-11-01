import re
import unittest
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", ".venv", "__pycache__", ".pytest_cache", "node_modules", "dist", "build"}
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


def markdown_files():
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not any(part in SKIP_PARTS for part in path.parts)
    )


def local_link_targets(path: Path):
    text = path.read_text(encoding="utf-8")
    for raw_target in LINK_RE.findall(text):
        target = raw_target.strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        if not target or target.startswith(("#", "/", "http://", "https://", "mailto:", "tel:")):
            continue
        target = unquote(target.split("#", 1)[0].split("?", 1)[0])
        if target:
            yield (path.parent / target).resolve(), raw_target


class DocumentationTests(unittest.TestCase):
    def test_local_markdown_links_resolve(self):
        missing = []
        for document in markdown_files():
            for target, raw_target in local_link_targets(document):
                if not target.exists():
                    missing.append(f"{document.relative_to(ROOT)} -> {raw_target}")
        self.assertEqual([], missing, "broken local documentation links:\n" + "\n".join(missing))

    def test_docs_hub_exposes_core_review_paths(self):
        hub = (ROOT / "docs/README.md").read_text(encoding="utf-8")
        for required in (
            "project-brief.md",
            "architecture.md",
            "api-overview.md",
            "simulation-training-console.md",
            "tracegate-guide.md",
            "safety-security.md",
            "validation-and-testing.md",
            "operations-runbook.md",
            "release-checklist.md",
            "glossary.md",
        ):
            with self.subTest(document=required):
                self.assertIn(required, hub)


if __name__ == "__main__":
    unittest.main()
