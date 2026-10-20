"""Request routing, source assembly, and grounded answer generation."""

import asyncio
import re
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

try:
    from .llm import synthesize_answer
    from .storage import append_exchange, get_history, replace_last_exchange_answer
    from .tools import github_repo_analysis, github_repo_target, news_search, weather_info, web_search, youtube_search
except ImportError:
    from llm import synthesize_answer
    from storage import append_exchange, get_history, replace_last_exchange_answer
    from tools import github_repo_analysis, github_repo_target, news_search, weather_info, web_search, youtube_search


def _is_weather_query(query: str) -> bool:
    return bool(re.search(r"\b(weather|forecast|temperature|humidity|wind speed|rainfall)\b", query, re.I))


def _is_news_query(query: str) -> bool:
    explicit_news = bool(re.search(r"\b(news|headlines|breaking|current events)\b", query, re.I))
    if explicit_news:
        return True
    if _is_weather_query(query) or _is_video_query(query):
        return False
    return bool(re.search(r"\b(latest|recent|this week|today|what changed)\b", query, re.I))


def _is_video_query(query: str) -> bool:
    return bool(re.search(r"\b(youtube|videos?|watch|lectures?|tutorials?)\b", query, re.I))


def _weather_city(query: str) -> str:
    cleaned = re.sub(r"\b(?:what(?:'s| is)?|the|current|today|right now|please|weather|forecast|temperature|humidity|wind|rainfall)\b", " ", query, flags=re.I)
    match = re.search(r"\b(?:in|for|at|near)\s+(.+)$", cleaned, re.I)
    if not match:
        return ""
    city = re.sub(r"[?.!,]+$", "", match.group(1)).strip()
    city = re.sub(r"\b(?:right now|today|currently|please)\b", "", city, flags=re.I).strip()
    return city[:100]


def _add_source(sources: List[Dict[str, Any]], seen: set, source: Dict[str, Any]) -> None:
    url = source.get("url")
    if url and url not in seen:
        seen.add(url)
        source["reference"] = f"S{len(sources) + 1:02d}"
        sources.append(source)


def _fallback_answer(query: str, sources: List[Dict[str, Any]], weather: Optional[Dict[str, Any]]) -> str:
    if weather and not weather.get("error"):
        details = [f"Current weather in {weather.get('city') or 'the requested place'}: {weather.get('temperature')}°C, {weather.get('condition') or 'conditions unavailable'}. "]
        if weather.get("humidity") is not None:
            details.append(f"Humidity is {weather['humidity']}%. ")
        if weather.get("wind_speed") is not None:
            details.append(f"Wind speed is {weather['wind_speed']} m/s.")
        return "".join(details).strip()
    if not sources:
        return "I could not retrieve current sources for this question. Check the backend's internet connection or search provider, then try again."

    lines = ["Here are the strongest results I could retrieve for your question:"]
    for source in sources[:5]:
        excerpt = (source.get("description") or "").strip()
        site = source.get("site") or ""
        line = f"• {source.get('title') or 'Untitled result'} [{source.get('reference')}]"
        if site:
            line += f" ({site})"
        if excerpt:
            line += f"\n  {excerpt}"
        lines.append(line)
    lines.append("Open the source links below to review the original material.")
    return "\n\n".join(lines)


class AuralytixAgent:
    """Run all query types through retrieval, optional specialist APIs, and synthesis."""

    def __init__(self) -> None:
        self._answer_results: Dict[str, Dict[str, Any]] = {}
        self._answer_tasks: Dict[str, asyncio.Task] = {}

    def get_answer_update(self, task_id: str) -> Optional[Dict[str, str]]:
        now = time.time()
        for old_id, state in list(self._answer_results.items()):
            if now - state["created_at"] > 900:
                self._answer_results.pop(old_id, None)
                self._answer_tasks.pop(old_id, None)
        state = self._answer_results.get(task_id)
        if state is None:
            return None
        return {"status": state["status"], "answer": state["answer"], "reasoning": state["reasoning"]}

    async def _finish_synthesis(
        self,
        task_id: str,
        query: str,
        session_id: str,
        sources: List[Dict[str, Any]],
        history: List[Dict[str, str]],
    ) -> None:
        state = self._answer_results.get(task_id)
        if state is None:
            return
        answer = None
        try:
            answer = await asyncio.to_thread(synthesize_answer, query, sources, history)
        except Exception:
            answer = None
        if answer:
            try:
                await asyncio.to_thread(replace_last_exchange_answer, session_id, query, answer)
            except Exception:
                pass
        state["answer"] = answer or state["answer"]
        state["reasoning"] = "AI synthesis" if answer else "source-based response"
        state["status"] = "complete"

    async def run(
        self,
        query: str,
        session_id: str,
        modality: str = "text",
        defer_synthesis: bool = False,
    ) -> Dict[str, Any]:
        repository_target = github_repo_target(query)
        repository_query = repository_target is not None
        weather_query = _is_weather_query(query) and not repository_query
        news_query = _is_news_query(query) and not repository_query
        video_query = True

        jobs = []
        job_names = []
        if repository_query:
            jobs.append(asyncio.to_thread(github_repo_analysis, query))
            job_names.append("repository")
        else:
            jobs.append(asyncio.to_thread(web_search, query))
            job_names.append("web")
        if weather_query:
            jobs.append(asyncio.to_thread(weather_info, _weather_city(query)))
            job_names.append("weather")
        if news_query:
            jobs.append(asyncio.to_thread(news_search, query))
            job_names.append("news")
        if video_query:
            jobs.append(asyncio.to_thread(youtube_search, query))
            job_names.append("videos")

        job_tasks = [asyncio.create_task(job) for job in jobs]
        _, pending = await asyncio.wait(job_tasks, timeout=6.5) if job_tasks else (set(), set())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        retrieval_deadline_hit = bool(pending)
        retrieved: Dict[str, Any] = {}
        for name, task in zip(job_names, job_tasks):
            if task in pending:
                retrieved[name] = None
                continue
            try:
                retrieved[name] = task.result()
            except Exception:
                retrieved[name] = None

        web_results = retrieved.get("web") if isinstance(retrieved.get("web"), list) else []
        articles = retrieved.get("news") if isinstance(retrieved.get("news"), list) else []
        videos = retrieved.get("videos") if isinstance(retrieved.get("videos"), list) else []
        weather = retrieved.get("weather") if isinstance(retrieved.get("weather"), dict) else None
        repository = retrieved.get("repository") if isinstance(retrieved.get("repository"), dict) else None
        sources: List[Dict[str, Any]] = []
        seen_urls = set()

        for item in (repository or {}).get("sources", []):
            _add_source(sources, seen_urls, {
                "type": item.get("type") or "Repository",
                "title": item.get("title") or "GitHub repository evidence",
                "url": item.get("url"),
                "site": item.get("site") or "GitHub",
                "description": item.get("description") or "",
            })

        for item in web_results:
            _add_source(sources, seen_urls, {
                "type": item.get("type") or "Web",
                "title": item.get("title") or "Untitled result",
                "url": item.get("url"),
                "site": item.get("site") or (urlparse(item.get("url", "")).hostname or ""),
                "description": item.get("snippet") or "",
            })
        for item in articles:
            _add_source(sources, seen_urls, {
                "type": "News",
                "title": item.get("title") or "Untitled article",
                "url": item.get("url"),
                "site": item.get("source") or "",
                "publishedAt": item.get("publishedAt"),
                "description": item.get("description") or "",
            })
        for video in videos:
            _add_source(sources, seen_urls, {
                "type": "Video",
                "title": video.get("title") or "Untitled video",
                "url": video.get("url"),
                "site": video.get("channel") or "YouTube",
            })
        if weather and not weather.get("error"):
            _add_source(sources, seen_urls, {
                "type": "Weather",
                "title": "Current conditions for " + str(weather.get("city") or "requested location"),
                "url": "https://open-meteo.com/en/docs" if weather.get("provider") == "Open-Meteo" else "https://openweathermap.org/current",
                "site": weather.get("provider") or "Weather provider",
                "description": "Observed at " + str(weather.get("observed_at") or "the latest provider update"),
            })

        history = await asyncio.to_thread(get_history, session_id, 10)
        answer_pending = False
        answer_task_id = None
        if repository_query and repository and repository.get("error") and not sources:
            answer = str(repository["error"])
            reasoning_state = "repository unavailable"
        elif weather_query and (not weather or weather.get("error")):
            weather_error = (weather or {}).get("error") or "Weather data could not be retrieved right now."
            answer = str(weather_error)
            if web_results:
                answer += " I found related pages below, but they do not confirm current conditions."
            reasoning_state = "specialist data unavailable"
        elif not sources or not any(source.get("type") != "Video" for source in sources):
            answer = _fallback_answer(query, sources, weather)
            reasoning_state = "source-based response"
        elif defer_synthesis:
            answer = _fallback_answer(query, sources, weather)
            reasoning_state = "AI synthesis pending"
            answer_pending = True
            answer_task_id = str(uuid.uuid4())
        else:
            synthesis_task = asyncio.create_task(asyncio.to_thread(synthesize_answer, query, sources, history))
            try:
                answer = await asyncio.wait_for(synthesis_task, timeout=14.0)
            except asyncio.TimeoutError:
                answer = None
            if not answer:
                answer = _fallback_answer(query, sources, weather)
                reasoning_state = "source-based response"
            else:
                reasoning_state = "AI synthesis"
        await asyncio.to_thread(append_exchange, session_id, query, answer)
        if answer_pending and answer_task_id:
            self._answer_results[answer_task_id] = {
                "created_at": time.time(),
                "status": "pending",
                "answer": answer,
                "reasoning": "AI synthesis pending",
            }
            self._answer_tasks[answer_task_id] = asyncio.create_task(
                self._finish_synthesis(answer_task_id, query, session_id, list(sources), list(history))
            )

        dashboard_data: Dict[str, Any] = {}
        if repository_query and repository:
            dashboard_data["repository"] = {
                "owner": repository.get("owner"),
                "name": repository.get("name"),
                "url": repository.get("url"),
                "branch": repository.get("branch"),
                "language": repository.get("language"),
                "summary": repository.get("summary"),
                "files_analyzed": repository.get("files_analyzed", 0),
                "tree_truncated": repository.get("tree_truncated", False),
                "error": repository.get("error"),
            }
        if articles:
            dashboard_data["articles"] = articles
        if videos:
            dashboard_data["videos"] = videos
        if weather and not weather.get("error"):
            dashboard_data["weather"] = weather
            latitude = weather.get("lat")
            longitude = weather.get("lon")
            try:
                if latitude is not None and longitude is not None:
                    dashboard_data["map_center"] = [float(latitude), float(longitude)]
            except (TypeError, ValueError):
                pass
            if weather.get("chart"):
                dashboard_data["chart"] = weather["chart"]

        dashboard_data["retrieval"] = {
            "deadline_reached": retrieval_deadline_hit,
            "web": "available" if web_results else ("not requested" if repository_query else "no results"),
            "news": "available" if articles else ("not requested" if not news_query else "no results"),
            "weather": "available" if weather and not weather.get("error") else ("not requested" if not weather_query else "unavailable"),
            "videos": "available" if videos else ("not requested" if not video_query else "no results"),
            "repository": (
                "available" if repository_query and repository and repository.get("files_analyzed")
                else "metadata only" if repository_query and repository and repository.get("url")
                else "unavailable" if repository_query
                else "not requested"
            ),
            "reasoning": reasoning_state,
        }
        return {
            "answer": answer,
            "answer_pending": answer_pending,
            "task_id": answer_task_id,
            "query": query,
            "transcript": query if modality == "voice" else None,
            "modality": modality,
            "session_id": session_id,
            "sources": sources,
            "dashboard_data": dashboard_data,
        }


def clear_session(session_id: str) -> None:
    try:
        from .storage import clear_history
    except ImportError:
        from storage import clear_history
    clear_history(session_id)
