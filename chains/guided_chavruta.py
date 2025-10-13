"""Guided Chavruta Chain: structured learning flow resilient to LLM outages.

Usage:
    python3 -m chains.guided_chavruta "Help me learn about Shabbat candles"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from typing import Any, Dict, List, Optional

from langchain_mcp_adapters.client import MultiServerMCPClient

from .ref_resolver import RefResolverChain
from .explain_with_sources import ExplainWithSourcesChain


def _structured(result: Dict[str, Any] | str) -> Dict[str, Any]:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return {}
    if isinstance(result, dict):
        structured = result.get("structuredContent")
        if structured:
            return structured
        for item in result.get("content", []):
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    return json.loads(item.get("text", "{}"))
                except json.JSONDecodeError:
                    continue
        return result
    return {}


class GuidedChavrutaChain:
    def __init__(self, server_url: str) -> None:
        self.server_url = server_url
        self.client = MultiServerMCPClient({"sefaria": {"url": server_url, "transport": "streamable_http"}})
        self.tools: Dict[str, Any] = {}
        self.explainer: Optional[ExplainWithSourcesChain] = None
        if os.environ.get("OPENROUTER_API_KEY"):
            # Optional; chain must work without it
            self.explainer = ExplainWithSourcesChain(server_url)
        self.resolver = RefResolverChain(server_url)

    async def _ensure_tools(self) -> None:
        if self.tools:
            return
        tool_list = await self.client.get_tools(server_name="sefaria")
        self.tools = {tool.name: tool for tool in tool_list}

    async def run(self, question: str) -> Dict[str, Any]:
        await self._ensure_tools()

        # Step 1: resolve primary ref
        ref_detail = await self.resolver.resolve(question, max_chars=800)
        primary_ref = (
            (ref_detail.get("metadata") or {}).get("heRef")
            or ref_detail.get("ref")
            or ref_detail.get("title")
        )
        if primary_ref:
            primary_ref = str(primary_ref).strip()

        # Step 2: exploration via sugya_explorer → fallback to fetch
        sugya: Dict[str, Any] = {}
        if primary_ref and "sugya_explorer" in self.tools:
            try:
                sugya = _structured(
                    await self.tools["sugya_explorer"].ainvoke(
                        {"ref": primary_ref, "includeText": True, "maxTextChars": 1000, "maxPerCategory": 6}
                    )
                )
            except Exception:
                sugya = {}

        fetch_doc: Dict[str, Any] = {}
        if not sugya.get("text") and primary_ref and "fetch" in self.tools:
            try:
                fetch_doc = _structured(
                    await self.tools["fetch"].ainvoke({"id": f"{primary_ref}|auto|primary", "langPref": "bi", "maxChars": 900})
                )
            except Exception:
                fetch_doc = {}

        # Step 3: optional insight layers (commentary comparison)
        layers: Dict[str, Any] = {"items": []}
        if primary_ref and "insight_layers" in self.tools:
            try:
                layers = _structured(
                    await self.tools["insight_layers"].ainvoke({"ref": primary_ref})
                )
            except Exception:
                layers = {"items": []}

        # Build sources list
        sources: List[Dict[str, str]] = []
        if sugya.get("categories"):
            for cat in sugya["categories"]:
                for item in cat.get("items", [])[:2]:
                    if not isinstance(item, dict):
                        continue
                    ref = item.get("ref")
                    url = item.get("url")
                    if ref and url:
                        sources.append({"ref": ref, "url": url, "title": item.get("title", ref)})
                    if len(sources) >= 6:
                        break
                if len(sources) >= 6:
                    break
        if not sources and fetch_doc.get("url"):
            sources.append({"ref": primary_ref or (fetch_doc.get("title") or ""), "url": fetch_doc.get("url"), "title": fetch_doc.get("title") or (primary_ref or "")})

        # Step 4: synthesis — prefer LLM if available; else heuristic summary
        summary: str = ""
        if self.explainer is not None:
            try:
                seed_refs = [{"ref": s.get("ref", ""), "title": s.get("title", ""), "url": s.get("url", ""), "id": f"{s.get('ref','')}|auto|primary"} for s in sources if s.get("ref")]
                summary = await self.explainer.explain(question, max_sources=3, seed_refs=seed_refs)
            except Exception as err:
                summary = f"LLM unavailable; using tool-based summary. Error: {err}"
        if not summary:
            # Build concise summary from available English snippets
            parts: List[str] = []
            en = (fetch_doc.get("metadata", {}) or {}).get("english_text") or fetch_doc.get("text") or (sugya.get("metadata", {}) or {}).get("englishSnippet")
            if isinstance(en, str) and en.strip():
                parts.append(en.strip().split(". ")[0][:260])
            names = [it.get("name") for it in (layers.get("items") or []) if it.get("available")]
            if names:
                parts.append("Commentators considered: " + ", ".join([str(n) for n in names if n])[:200])
            if not parts:
                parts.append("Primary sources assembled for chavruta.")
            summary = "\n".join(parts)

        # Step 5: reflection questions
        reflection_questions: List[str] = []
        reflection_questions.append("What problem or theme is this source addressing?")
        if layers.get("items"):
            available = [it for it in layers["items"] if it.get("available")]
            if len(available) >= 2:
                reflection_questions.append("How do two commentators agree or differ on the key point?")
        reflection_questions.append("What in the text supports each interpretation?")
        reflection_questions.append("How does context before/after the passage change the meaning?")

        plan = "Resolve → Explore primary text → Compare insights → Reflect"
        steps = [
            "Identify the exact reference and retrieve the core text (bilingual)",
            "Explore related sources and sheets for context (sugya_explorer)",
            "Compare commentators' insights and revisit the text",
        ]
        if layers.get("items") and any(it.get("available") for it in layers["items"]):
            steps.append("Optional: focus on a commentator whose view you want to understand deeply")

        result = {
            "plan": plan,
            "steps": steps,
            "sources": sources,
            "reflection_questions": reflection_questions,
            "summary": summary,
        }
        return result


async def main() -> None:
    parser = argparse.ArgumentParser(description="Guided chavruta flow for a Torah question")
    parser.add_argument("question", help="Question to learn about")
    args = parser.parse_args()

    server_url = os.environ.get("SEFARIA_MCP_URL", "http://localhost:3000/mcp")
    chain = GuidedChavrutaChain(server_url)
    out = await chain.run(args.question)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
