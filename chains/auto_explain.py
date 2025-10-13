"""Auto Explain chain: plan MCP tool usage and synthesize answer with sources."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

from urllib.parse import quote


from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from chains.explain_with_sources import ExplainWithSourcesChain, HALACHA_TRIGGER
from chains.ref_resolver import HEBREW_REF_PATTERN, REF_PATTERN, RefResolverChain


DEFAULT_PLAN_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            """You are a planning assistant for a Torah research agent. Given a user question, decide which Sefaria MCP tools to call (search, fetch, sugya_explorer, compare_versions, etc.).
Return JSON with fields:
- plan: short explanation of your approach (1-2 sentences).
- steps: array where each item is an object {{\"tool\": string, \"arguments\": object}}. Use only valid tool names.
Guidelines:
- Start with search for general topics unless the prompt already looks like an exact ref (e.g., contains chapter:verse).
- Fetch specific refs (via fetch) when you already know the ref.
- Use sugya_explorer for broad questions about a passage.
- Use compare_versions if the question mentions comparison between translations.
- Use parsha_pack for weekly Torah portion questions.
- Use find_refs if text quotes are supplied.
Keep steps under 4 items.""",
        ),
        ("human", "Question: {question}\nAnswer in JSON only."),
    ]
)


@dataclass
class PlanStep:
    tool: str
    arguments: Dict[str, Any]


def _normalize_ref(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _ref_to_url(ref: str) -> str:
    encoded = quote(_normalize_ref(ref).replace(" ", "_"))
    return f"https://www.sefaria.org/{encoded}?lang=bi"


def _structured_content(result: Any) -> Dict[str, Any]:
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    if isinstance(result, dict):
        if "structuredContent" in result and isinstance(result["structuredContent"], dict):
            return result["structuredContent"]  # type: ignore[return-value]
        for item in result.get("content", []):
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    parsed = json.loads(item.get("text", "{}"))
                    if isinstance(parsed, dict):
                        return parsed
                except json.JSONDecodeError:
                    continue
        if isinstance(result, dict):
            return result
    return {}


def _extract_refs(tool: str, structured: Dict[str, Any]) -> List[Dict[str, str]]:
    refs: List[Dict[str, str]] = []

    def add(ref: Optional[str], title: Optional[str] = None, url: Optional[str] = None) -> None:
        if not ref:
            return
        norm = _normalize_ref(ref)
        if not norm:
            return
        resolved_url = url if isinstance(url, str) and url.startswith("http") else _ref_to_url(norm)
        entry = {
            "ref": norm,
            "title": title or norm,
            "url": resolved_url,
        }
        refs.append(entry)

    if not structured or not isinstance(structured, dict):
        return refs

    # Generic ref/url fields
    if structured.get("ref"):
        add(structured.get("ref"), structured.get("title"), structured.get("url"))
    if structured.get("metadata", {}).get("heRef"):
        add(structured.get("metadata", {}).get("heRef"), structured.get("title"), structured.get("url"))

    if tool == "search":
        for item in structured.get("results", []) or []:
            if not isinstance(item, dict):
                continue
            raw_id = item.get("id") or item.get("title")
            ref_part = raw_id.split("|")[0] if isinstance(raw_id, str) else None
            add(ref_part, item.get("title"), item.get("url"))

    if tool == "topics_search":
        for item in structured.get("results", []) or []:
            if not isinstance(item, dict):
                continue
            add(item.get("ref"), item.get("title"), item.get("url"))

    if tool == "find_refs":
        for item in structured.get("matches", []) or []:
            if not isinstance(item, dict):
                continue
            add(item.get("ref"), item.get("ref"), item.get("url"))

    if tool == "sugya_explorer":
        categories = structured.get("categories", []) or []
        for cat in categories:
            for item in cat.get("items", []) or []:
                if isinstance(item, dict):
                    add(item.get("ref"), item.get("title"), item.get("url"))

    if tool in {"compare_versions", "fetch"}:
        if structured.get("ref"):
            add(structured.get("ref"), structured.get("title"), structured.get("url"))

    if tool == "get_daily_learnings":
        schedule = structured.get("schedule", structured)
        items = []
        if isinstance(schedule, dict):
            items = schedule.get("calendar_items", []) or []
        for item in items:
            if not isinstance(item, dict):
                continue
            display = item.get("displayValue")
            if isinstance(display, dict):
                display_en = display.get("en")
            else:
                display_en = display if isinstance(display, str) else None
            title_obj = item.get("title") if isinstance(item.get("title"), dict) else {}
            calendar_title = title_obj.get("en") if isinstance(title_obj, dict) else None
            composed_title = calendar_title
            if calendar_title and display_en:
                composed_title = f"{calendar_title}: {display_en}"
            elif display_en:
                composed_title = display_en
            add(item.get("ref"), composed_title, item.get("url"))

    if tool == "parsha_pack":
        parsha = structured.get("parsha") or {}
        if isinstance(parsha, dict):
            add(parsha.get("ref"), parsha.get("nameEn"), parsha.get("url"))
        for item in structured.get("learningTracks", []) or []:
            if isinstance(item, dict):
                add(item.get("ref"), item.get("title"), item.get("url"))

    return refs


class AutoExplain:
    def __init__(self, server_url: str, model: str | None = None) -> None:
        self.server_url = server_url
        chosen_model = model or os.environ.get("OPENROUTER_MODEL", "x-ai/grok-4-fast")
        self.llm = ChatOpenAI(
            model=chosen_model,
            base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            api_key=os.environ.get("OPENROUTER_API_KEY"),
            temperature=0,
            default_headers={
                "HTTP-Referer": os.environ.get("OPENROUTER_REFERER", os.environ.get("HTTP_REFERER", "https://factory.ai")),
                "X-Title": os.environ.get("OPENROUTER_TITLE", os.environ.get("X_TITLE", "Torah MCP Auto Explain")),
            },
        )
        self.explainer = ExplainWithSourcesChain(server_url, model=chosen_model)
        self.resolver = RefResolverChain(server_url)
        self._last_plan_error: Optional[str] = None

    async def plan(self, question: str) -> List[PlanStep]:
        self._last_plan_error = None
        parsed: Dict[str, Any] = {}
        try:
            response = await self.llm.ainvoke(
                DEFAULT_PLAN_PROMPT.invoke({"question": question})
            )
            content = response.content if isinstance(response.content, str) else str(response.content)
            parsed = json.loads(content)
        except Exception as err:
            self._last_plan_error = str(err)
        if not isinstance(parsed, dict):
            parsed = {}
        steps: List[PlanStep] = []
        for step in parsed.get("steps", []):
            tool = step.get("tool")
            arguments = step.get("arguments")
            if isinstance(tool, str) and isinstance(arguments, dict):
                steps.append(PlanStep(tool=tool, arguments=arguments))
        return self._apply_heuristics(question, steps)

    def _apply_heuristics(self, question: str, steps: List[PlanStep]) -> List[PlanStep]:
        lowered = question.lower()

        def ensure(tool: str, arguments: Dict[str, Any]) -> None:
            if any(existing.tool == tool for existing in steps):
                return
            steps.append(PlanStep(tool=tool, arguments=arguments))

        if "daf yomi" in lowered:
            ensure("get_daily_learnings", {"diaspora": True})

        if HALACHA_TRIGGER.search(question):
            ensure("find_refs", {"text": question})

        if not any(step.tool == "search" for step in steps):
            ensure("search", {"query": question, "size": 6})

        if HALACHA_TRIGGER.search(question) and not any(step.tool == "sugya_explorer" for step in steps):
            ensure("sugya_explorer", {"ref": question, "includeText": False, "maxPerCategory": 6})

        if any(name in lowered for name in ["rashi", "ibn ezra", "ramban", "commentary", "explain", "interpret"]):
            ensure("compare_versions", {"ref": question, "versions": []})

        return steps

    async def run(self, question: str) -> str:
        steps = await self.plan(question)
        if not steps:
            steps = [PlanStep("search", {"query": question, "size": 8})]

        gathered_notes: List[str] = []
        if self._last_plan_error:
            gathered_notes.append(f"Planner fallback: {self._last_plan_error}")
        candidate_map: Dict[str, Dict[str, str]] = {}
        executed_tools: Set[str] = set()
        await self.resolver._ensure_tools()

        primary_ref, resolved_detail, resolve_error = await self._resolve_question(question)
        if resolved_detail and not resolved_detail.get("error"):
            resolver_dump = json.dumps(resolved_detail, default=str, indent=2)
            if len(resolver_dump) > 1500:
                resolver_dump = resolver_dump[:1500] + "..."
            gathered_notes.append("Resolver\n" + resolver_dump)
            resolved_ref = resolved_detail.get("metadata", {}).get("heRef") or resolved_detail.get("title")
            if resolved_ref:
                norm_ref = _normalize_ref(resolved_ref)
                candidate_map.setdefault(
                    norm_ref,
                    {
                        "ref": norm_ref,
                        "title": resolved_detail.get("title") or norm_ref,
                        "url": resolved_detail.get("url") or self.resolver._ref_to_url(norm_ref),
                    },
                )
        elif resolve_error:
            gathered_notes.append(f"Resolver failed: {resolve_error}")

        if primary_ref:
            self._patch_steps_with_ref(primary_ref, steps)

        if HALACHA_TRIGGER.search(question) and primary_ref and not any(step.tool == "get_commentaries" for step in steps):
            steps.append(PlanStep("get_commentaries", {"ref": primary_ref}))

        for idx, step in enumerate(steps, start=1):
            try:
                if step.tool in self.resolver.tools:
                    result = await self.resolver.tools[step.tool].ainvoke(step.arguments)
                else:
                    result = await self.resolver.client.call_tool("sefaria", step.tool, step.arguments)
            except Exception as err:
                gathered_notes.append(f"Step {idx} ({step.tool}) failed: {err}")
                continue
            executed_tools.add(step.tool)
            structured_json = json.loads(json.dumps(result, default=str))
            step_dump = json.dumps(structured_json, indent=2)
            if len(step_dump) > 1500:
                step_dump = step_dump[:1500] + "..."
            gathered_notes.append(f"Step {idx}: {step.tool}\n{step_dump}")

            structured = _structured_content(result)
            for ref_entry in _extract_refs(step.tool, structured):
                candidate_map.setdefault(ref_entry["ref"], ref_entry)

        if primary_ref:
            await self._enrich_commentaries(question, primary_ref, candidate_map, gathered_notes)
            await self._enrich_topics(question, primary_ref, candidate_map, gathered_notes)

        if HALACHA_TRIGGER.search(question) and "sugya_explorer" not in executed_tools and candidate_map:
            target_ref = next(iter(candidate_map.values()))["ref"]
            try:
                if "sugya_explorer" in self.resolver.tools:
                    explorer_result = await self.resolver.tools["sugya_explorer"].ainvoke(
                        {"ref": target_ref, "includeText": False, "maxPerCategory": 6, "maxSheets": 4, "maxTopics": 4}
                    )
                else:
                    raise RuntimeError("sugya_explorer tool not available")
                structured_json = json.loads(json.dumps(explorer_result, default=str))
                gathered_notes.append(f"Extra: sugya_explorer\n{json.dumps(structured_json, indent=2)}")
                structured = _structured_content(explorer_result)
                for ref_entry in _extract_refs("sugya_explorer", structured):
                    candidate_map.setdefault(ref_entry["ref"], ref_entry)
            except Exception as err:
                gathered_notes.append(f"Extra: sugya_explorer failed: {err}")

        if "daf yomi" in question.lower():
            daf_refs = [entry for entry in candidate_map.values() if "Daf Yomi" in entry.get("title", "")]
            if not daf_refs:
                daf_refs = [entry for entry in candidate_map.values() if entry["ref"].lower().startswith("daf yomi")]
            if daf_refs:
                daf_ref = daf_refs[0]["ref"]
                try:
                    if "sugya_explorer" in self.resolver.tools:
                        explorer_result = await self.resolver.tools["sugya_explorer"].ainvoke(
                            {"ref": daf_ref, "includeText": False, "maxPerCategory": 6, "maxSheets": 4, "maxTopics": 4}
                        )
                    else:
                        raise RuntimeError("sugya_explorer tool not available")
                    structured_json = json.loads(json.dumps(explorer_result, default=str))
                    gathered_notes.append(f"Extra: daf sugya_explorer\n{json.dumps(structured_json, indent=2)}")
                    structured = _structured_content(explorer_result)
                    for ref_entry in _extract_refs("sugya_explorer", structured):
                        candidate_map.setdefault(ref_entry["ref"], ref_entry)
                except Exception as err:
                    gathered_notes.append(f"Extra: daf sugya_explorer failed: {err}")

        notes_text = "\n\n".join(gathered_notes[:8])
        seed_refs = list(candidate_map.values())
        response = await self.explainer.explain(question, seed_refs=seed_refs)
        return f"{response}\n\n---\n_Planning notes:_\n{notes_text or 'No tool output available.'}"

    async def _resolve_question(self, question: str) -> Tuple[Optional[str], Optional[Dict[str, Any]], Optional[str]]:
        candidate_refs: List[str] = []
        match = REF_PATTERN.search(question)
        if match:
            candidate_refs.append(match.group(0))
        heb_match = HEBREW_REF_PATTERN.search(question)
        if heb_match:
            candidate_refs.append(heb_match.group(0))

        tokens = re.findall(r"[A-Za-z\u0590-\u05FF]+|\d+[:.]\d+|\S", question)
        for idx, token in enumerate(tokens):
            verse_token = token.strip(".,;?!")
            if ":" not in verse_token or not any(ch.isdigit() for ch in verse_token):
                continue
            window = [t.strip(".,;?!") for t in tokens[max(0, idx - 6): idx] if t.strip(".,;?!")]
            for n in range(len(window), 0, -1):
                candidate = " ".join(window[-n:]).strip()
                if candidate:
                    candidate_refs.append(f"{candidate} {verse_token}")

        normalized_candidates: List[str] = []
        seen_candidates: Set[str] = set()
        for cand in candidate_refs:
            norm = _normalize_ref(cand)
            if norm and norm not in seen_candidates:
                normalized_candidates.append(norm)
                seen_candidates.add(norm)

        best_detail: Optional[Dict[str, Any]] = None
        best_ref: Optional[str] = None
        best_score = -1

        for ref_candidate in normalized_candidates:
            try:
                detail = await self.resolver.resolve(ref_candidate)
            except Exception:
                continue
            if detail.get("error"):
                continue
            metadata = detail.get("metadata") or {}
            resolved_ref = metadata.get("heRef") or detail.get("ref") or ref_candidate
            title = (detail.get("title") or "").lower()
            he_ref_lower = (resolved_ref or "").lower()
            candidate_words = [tok.lower() for tok in ref_candidate.split() if tok.isalpha()]
            candidate_numbers = [tok for tok in ref_candidate.split() if ":" in tok]
            score = 0
            resolution_path = detail.get("resolution_path") or []
            if "direct" in resolution_path:
                score += 5
            if "search" in resolution_path:
                score += 1
            for word in candidate_words:
                if word and word in title:
                    score += 2
                if word and word in he_ref_lower:
                    score += 1
            for number in candidate_numbers:
                if number in title:
                    score += 1
                if number in he_ref_lower:
                    score += 1
            if score > best_score:
                best_score = score
                best_detail = detail
                best_ref = resolved_ref

        if best_detail and best_ref:
            primary_ref = _normalize_ref(best_ref)
            return primary_ref, best_detail, None

        try:
            detail = await self.resolver.resolve(question)
        except Exception as err:
            return None, None, str(err)
        fallback_error = detail.get("error")
        if not fallback_error:
            metadata = detail.get("metadata") or {}
            primary_ref = metadata.get("heRef") or detail.get("ref") or detail.get("title")
            if primary_ref:
                primary_ref = _normalize_ref(primary_ref)
                return primary_ref, detail, None
        else:
            detail = None

        lowered = question.lower()
        book_match = re.search(r"book of ([a-zA-Z\s]+)", lowered)
        if book_match:
            book = " ".join(w.capitalize() for w in book_match.group(1).split())
            candidate = f"{book} 1:1"
            try:
                book_detail = await self.resolver.resolve(candidate)
            except Exception as err:
                return None, None, str(err)
            if not book_detail.get("error"):
                metadata = book_detail.get("metadata") or {}
                primary_ref = metadata.get("heRef") or book_detail.get("ref") or candidate
                if primary_ref:
                    primary_ref = _normalize_ref(primary_ref)
                return primary_ref, book_detail, None

        return None, detail or {"query": question, "error": fallback_error}, fallback_error

    def _patch_steps_with_ref(self, primary_ref: str, steps: List[PlanStep]) -> None:
        prefixed_id = f"{primary_ref}|auto|primary"
        for step in steps:
            args = step.arguments
            if step.tool == "fetch" and not args.get("id"):
                args["id"] = prefixed_id
            if step.tool in {"sugya_explorer", "compare_versions", "get_commentaries"}:
                ref_val = args.get("ref")
                if not ref_val or "?" in ref_val or not self.resolver._query_is_pure_ref(ref_val):
                    args["ref"] = primary_ref
            if step.tool == "find_refs" and not args.get("text"):
                args["text"] = primary_ref

    async def _enrich_commentaries(
        self,
        question: str,
        primary_ref: str,
        candidate_map: Dict[str, Dict[str, str]],
        gathered_notes: List[str],
    ) -> None:
        commentary_targets = [
            name
            for name in ["rashi", "ibn ezra", "ramban", "sforno", "malbim", "radak"]
            if name in question.lower()
        ]
        if not commentary_targets or "get_commentaries" not in self.resolver.tools:
            return
        try:
            comment_result = await self.resolver.tools["get_commentaries"].ainvoke({"ref": primary_ref})
        except Exception as err:
            gathered_notes.append(f"Commentary enrichment failed: {err}")
            return
        structured = _structured_content(comment_result)
        gathered_notes.append(
            "Commentaries\n" + json.dumps(structured, default=str, indent=2)[:2000]
        )
        def matches(name: str, lowered: str) -> bool:
            return lowered.startswith(name) or f"{name} on" in lowered or f" {name} " in lowered

        for item in structured.get("items", []) or []:
            title = item.get("title", "")
            lowered = title.lower()
            if any(matches(name, lowered) for name in commentary_targets):
                ref = item.get("ref")
                if not ref:
                    continue
                try:
                    fetched = await self.resolver.tools["fetch"].ainvoke(
                        {"id": ref, "langPref": "bi", "maxChars": 800}
                    )
                except Exception as err:
                    gathered_notes.append(f"Fetch commentary {ref} failed: {err}")
                    continue
                structured_fetch = _structured_content(fetched)
                candidate_map.setdefault(
                    ref,
                    {
                        "ref": ref,
                        "title": structured_fetch.get("title") or title or ref,
                        "url": structured_fetch.get("url") or item.get("url") or _ref_to_url(ref),
                    },
                )

    async def _enrich_topics(
        self,
        question: str,
        primary_ref: str,
        candidate_map: Dict[str, Dict[str, str]],
        gathered_notes: List[str],
    ) -> None:
        lowered = question.lower()
        if "overview" not in lowered and "summary" not in lowered:
            return
        if "topics_search" not in self.resolver.tools:
            return
        try:
            topic_result = await self.resolver.tools["topics_search"].ainvoke({"topic": primary_ref})
        except Exception as err:
            gathered_notes.append(f"Topic enrichment failed: {err}")
            return
        structured = _structured_content(topic_result)
        for ref_entry in _extract_refs("topics_search", structured):
            candidate_map.setdefault(ref_entry["ref"], ref_entry)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Auto explain a Torah question with tool planning")
    parser.add_argument("question", help="Question to ask")
    parser.add_argument("--model", help="OpenRouter model override", default=None)
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY environment variable is required")

    server_url = os.environ.get("SEFARIA_MCP_URL", "http://localhost:3000/mcp")
    auto = AutoExplain(server_url, model=args.model)
    result = await auto.run(args.question)
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
