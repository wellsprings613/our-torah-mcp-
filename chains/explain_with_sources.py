"""ExplainWithSourcesChain: search + fetch + summarize with explicit Hebrew/English quotes.

Usage:
    OPENROUTER_API_KEY=... SEFARIA_MCP_URL=... python3 chains/explain_with_sources.py \
        "What is 'Lo bashamayim hi' about?"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set
import logging

from urllib.parse import quote

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_core.prompts import ChatPromptTemplate


load_dotenv()


HALACHA_TRIGGER = re.compile(
    r"(halach|halakh|psak|permitted|allowed|issur|mutar|אסור|מותר|חובה|שבת|שבת)",
    re.IGNORECASE,
)


def _simplify_query_text(query: str) -> str:
    tokens = re.findall(r"[\w']+", query.lower())
    stopwords = {
        "where",
        "does",
        "the",
        "and",
        "or",
        "a",
        "an",
        "of",
        "to",
        "in",
        "is",
        "about",
        "discuss",
        "discusses",
        "discussing",
        "tell",
        "me",
        "do",
        "it",
        "on",
        "for",
        "with",
        "by",
        "what",
        "which",
        "who",
        "when",
        "how",
        "why",
        "explain",
        "laws",
    }
    filtered = [tok for tok in tokens if tok not in stopwords and len(tok) > 2]
    return " ".join(filtered[:8]).strip()


def _ref_to_url(ref: str) -> str:
    encoded = quote(re.sub(r"\s+", "_", ref.strip()))
    return f"https://www.sefaria.org/{encoded}?lang=bi"


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
            if item.get("type") == "text":
                try:
                    return json.loads(item.get("text", "{}"))
                except json.JSONDecodeError:
                    continue
        return result
    return {}


@dataclass
class SourceQuote:
    ref: str
    url: str
    english: str
    hebrew: str


logger = logging.getLogger(__name__)


class ExplainWithSourcesChain:
    def __init__(self, server_url: str, model: str | None = None) -> None:
        self.client = MultiServerMCPClient(
            {
                "sefaria": {
                    "url": server_url,
                    "transport": "streamable_http",
                }
            }
        )
        self.tools: Dict[str, Any] = {}
        chosen_model = model or os.environ.get("OPENROUTER_MODEL", "gpt-4o-mini")
        self.llm = ChatOpenAI(
            model=chosen_model,
            base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            api_key=os.environ.get("OPENROUTER_API_KEY"),
            temperature=0,
            default_headers={
                "HTTP-Referer": os.environ.get("OPENROUTER_REFERER", "https://factory.ai"),
                "X-Title": os.environ.get("OPENROUTER_TITLE", "Sefaria MCP"),
            },
        )

    async def _ensure_tools(self) -> None:
        if self.tools:
            return
        tool_list = await self.client.get_tools(server_name="sefaria")
        self.tools = {tool.name: tool for tool in tool_list}

    async def explain(
        self,
        question: str,
        *,
        level: str = "beginner",
        max_sources: int = 3,
        seed_refs: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        logger.debug("explain.start", extra={"question": question})
        await self._ensure_tools()
        search_queries: List[str] = []
        base = question.strip()
        search_queries.append(base)
        trimmed = base.rstrip("?.! ")
        if trimmed and trimmed != base:
            search_queries.append(trimmed)
        words = trimmed.split()
        if len(words) > 3:
            search_queries.append(" ".join(words[1:]))
        if len(words) > 4:
            search_queries.append(" ".join(words[2:]))

        hits: List[Dict[str, Any]] = []
        seen_ids: Set[str] = set()

        def add_hit(hit: Dict[str, Any]) -> None:
            fetch_id = hit.get("id")
            if not fetch_id:
                return
            if fetch_id in seen_ids:
                return
            seen_ids.add(fetch_id)
            hits.append(hit)

        if seed_refs:
            for seed in seed_refs:
                if not isinstance(seed, dict):
                    continue
                ref = (seed.get("ref") or "").strip()
                if not ref:
                    continue
                fetch_id = seed.get("id") or f"{ref}|auto|primary"
                title = seed.get("title") or ref
                url = seed.get("url") or _ref_to_url(ref)
                add_hit({"id": fetch_id, "title": title, "url": url, "provenance": "seed"})

        attempted_queries: Set[str] = set()
        for q in search_queries:
            if not q or q in attempted_queries:
                continue
            attempted_queries.add(q)
            search_output = await self.tools["search"].ainvoke({"query": q, "size": 6})
            for item in _structured(search_output).get("results", []) or []:
                if not isinstance(item, dict):
                    continue
                raw_id = item.get("id") or item.get("title")
                ref_part = raw_id.split("|")[0] if isinstance(raw_id, str) else None
                if not ref_part:
                    continue
                url = item.get("url") or _ref_to_url(ref_part)
                add_hit({"id": f"{ref_part}|auto|primary", "title": item.get("title") or ref_part, "url": url})
            if len(hits) >= max_sources:
                break

        simplified = _simplify_query_text(base)
        if len(hits) < max_sources and simplified and simplified not in attempted_queries:
            search_output = await self.tools["search"].ainvoke({"query": simplified, "size": 6})
            attempted_queries.add(simplified)
            for item in _structured(search_output).get("results", []) or []:
                if not isinstance(item, dict):
                    continue
                raw_id = item.get("id") or item.get("title")
                ref_part = raw_id.split("|")[0] if isinstance(raw_id, str) else None
                if not ref_part:
                    continue
                url = item.get("url") or _ref_to_url(ref_part)
                add_hit({"id": f"{ref_part}|auto|primary", "title": item.get("title") or ref_part, "url": url})
            if len(hits) >= max_sources:
                search_queries.append(simplified)

        if not hits and "topics_search" in self.tools:
            topic_queries = [base]
            if trimmed and trimmed not in topic_queries:
                topic_queries.append(trimmed)
            if simplified and simplified not in topic_queries:
                topic_queries.append(simplified)
            for q in search_queries:
                if q not in topic_queries:
                    topic_queries.append(q)

            for topic in topic_queries:
                if not topic:
                    continue
                topic_output = await self.tools["topics_search"].ainvoke({"topic": topic})
                topic_hits = _structured(topic_output).get("results", [])
                for item in topic_hits or []:
                    if not isinstance(item, dict):
                        continue
                    ref_val = item.get("ref")
                    if not ref_val:
                        continue
                    url = item.get("url") or _ref_to_url(ref_val)
                    add_hit(
                        {
                            "id": f"{ref_val}|auto|primary",
                            "title": item.get("title") or ref_val,
                            "url": url,
                            "provenance": "topics",
                        }
                    )
                if hits:
                    break

        if not hits:
            return "No sources found."

        selections = hits[: max_sources * 2]
        quotes: List[SourceQuote] = []
        fallback_quotes: List[SourceQuote] = []
        for hit in selections:
            fetch_id = hit.get("id")
            if not fetch_id:
                ref = hit.get("title") or hit.get("url") or "Unknown"
                fetch_id = f"{ref}|auto|primary"
            try:
                fetched = _structured(
                    await self.tools["fetch"].ainvoke(
                        {"id": fetch_id, "langPref": "bi", "maxChars": 800}
                    )
                )
            except Exception:
                continue
            english = (fetched.get("metadata", {}).get("english_text") or fetched.get("text") or "").strip()
            hebrew = (fetched.get("metadata", {}).get("hebrew_text") or "").strip()
            quote = SourceQuote(
                ref=fetched.get("metadata", {}).get("heRef") or hit.get("title") or "",
                url=fetched.get("url") or hit.get("url") or "",
                english=english,
                hebrew=hebrew,
            )
            if english or hebrew:
                quotes.append(quote)
            else:
                fallback_quotes.append(quote)
            if len(quotes) >= max_sources:
                break

        if len(quotes) < max_sources and fallback_quotes:
            quotes.extend(fallback_quotes[: max_sources - len(quotes)])

        context_lines = []
        for q in quotes:
            context_lines.append(
                f"Ref: {q.ref}\nURL: {q.url}\nEnglish: {q.english}\nHebrew: {q.hebrew}\n"
            )
        context = "\n".join(context_lines)

        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", "You are a Torah educator. Answer succinctly and reference the supplied sources."),
                (
                    "human",
                    """Question: {question}
Level: {level}
Sources (Heb/Eng quotations):
{sources}

Return a markdown response with:
1. 3-5 sentence answer
2. Bulleted list "Quoted sources" with each bullet including ref, English snippet, Hebrew snippet, and link.
3. Add a Halacha disclaimer if the question is practical halacha.
""",
                ),
            ]
        )

        halacha_flag = bool(HALACHA_TRIGGER.search(question))
        try:
            response = await self.llm.ainvoke(
                prompt.invoke(
                    {
                        "question": question,
                        "level": level,
                        "sources": context,
                    }
                )
            )
            output = response.content if isinstance(response.content, str) else str(response.content)
            if halacha_flag and "disclaimer" not in output.lower():
                output += "\n\n_Disclaimer: For practical halacha, consult your rav._"
            logger.debug("explain.done", extra={"question": question})
            return output
        except Exception as err:
            lines = ["LLM unavailable; presenting sources directly."]
            lines.append(f"Error: {err}")
            if quotes:
                lines.append("\nQuoted sources:")
                for q in quotes:
                    snippet_en = (q.english or "").split(". ")[0]
                    snippet_he = (q.hebrew or "").split(". ")[0]
                    lines.append(
                        f"- {q.ref} — {snippet_en.strip()} | {snippet_he.strip()} ({q.url})"
                    )
            if halacha_flag:
                lines.append("\n_Disclaimer: For practical halacha, consult your rav._")
            return "\n".join(lines)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Explain Torah topics with sourced quotes")
    parser.add_argument("question", nargs="?", help="Question to answer")
    parser.add_argument("--level", default="beginner", help="Audience level (beginner/intermediate/lamdan)")
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY environment variable is required.")

    server_url = os.environ.get("SEFARIA_MCP_URL", "http://localhost:3000/mcp")
    chain = ExplainWithSourcesChain(server_url)

    questions = [
        args.question,
    ] if args.question else [
        "Explain 'Lo bashamayim hi' with sources.",
        "Is saving a life on Shabbat allowed? Summarize the sources." 
    ]

    for q in questions:
        print("==============================")
        print(f"Q: {q}")
        result = await chain.explain(q, level=args.level)
        print(result)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
