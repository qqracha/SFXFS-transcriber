from __future__ import annotations

import os
import csv
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse


os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


APP_DIR = Path(os.environ.get("TRANSCRIBER_APP_DIR", Path(__file__).resolve().parents[1])).resolve()
UPLOAD_DIR = APP_DIR / "work" / "uploads"
RESULT_DIR = APP_DIR / "results"
MODEL_DIR = Path(os.environ.get("TRANSCRIBER_MODEL_DIR", APP_DIR / "models")).resolve()
ALLOWED_EXTENSIONS = {".mp4", ".mp3", ".wav"}
MODEL_NAME = "small"
CHUNK_SECONDS = 25 * 60
OVERLAP_SECONDS = 5 * 60
PROMPT_VERSION = "2026-09-21"

for directory in (UPLOAD_DIR, RESULT_DIR, MODEL_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="SFXFS Transcriber", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
    ],
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.RLock()
model_lock = threading.Lock()
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="transcriber")
whisper_model: Any | None = None


def clean_name(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[^\w\-. ()а-яА-ЯёЁ]+", "_", stem, flags=re.UNICODE).strip(" ._")
    return (stem or "transcript")[:100]


def format_timestamp(seconds: float) -> str:
    total_ms = max(0, round(seconds * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"
    return f"{minutes:02d}:{secs:02d}.{milliseconds:03d}"


def format_hhmmss(seconds: float) -> str:
    """Human-readable source timestamp, always anchored to the original VOD."""
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"


def parse_frame_rate(value: Any) -> tuple[float | None, str]:
    if value in (None, "", "0/0"):
        return None, "unknown"
    try:
        rate = float(Fraction(str(value)))
    except (ValueError, ZeroDivisionError):
        return None, str(value)
    return rate, str(value)


def should_drop_frame(fps: float | None) -> bool:
    return fps is not None and (abs(fps - 29.97) < 0.02 or abs(fps - 59.94) < 0.02)


def probe_media(source: Path) -> dict[str, Any]:
    """Read duration/FPS. ffprobe is preferred; PyAV is the portable fallback."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "format=duration:stream=r_frame_rate,avg_frame_rate",
                "-of", "json", str(source),
            ],
            capture_output=True, text=True, check=True,
        )
        payload = json.loads(result.stdout or "{}")
        stream = (payload.get("streams") or [{}])[0]
        duration = float((payload.get("format") or {}).get("duration") or 0)
        rate_value = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
        fps, fps_label = parse_frame_rate(rate_value)
        return {"duration": duration, "fps": fps, "fps_label": fps_label, "fps_source": "ffprobe"}
    except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        import av

        with av.open(str(source)) as media:
            duration = float(media.duration or 0) / 1_000_000 if media.duration else 0.0
            video = media.streams.video[0] if media.streams.video else None
            rate = (video.average_rate or video.base_rate) if video else None
            fps = float(rate) if rate else None
            return {
                "duration": duration,
                "fps": fps,
                "fps_label": str(rate or "unknown"),
                "fps_source": "pyav",
            }


def timecode_from_seconds(seconds: float, fps: float | None, drop_frame: bool | None = None) -> str:
    """Convert absolute seconds to Resolve-compatible HH:MM:SS:FF."""
    rate = fps or 30.0
    nominal = max(1, round(rate))
    frames = max(0, round(float(seconds) * rate))
    use_drop = should_drop_frame(rate) if drop_frame is None else drop_frame
    if use_drop:
        drop = round(nominal * 0.066666)
        frames_per_minute = nominal * 60 - drop
        frames_per_10_minutes = nominal * 600 - drop * 9
        ten_minutes, remainder = divmod(frames, frames_per_10_minutes)
        adjusted = frames + drop * 9 * ten_minutes
        if remainder >= drop:
            adjusted += drop * ((remainder - drop) // frames_per_minute)
        whole_seconds, frame = divmod(adjusted, nominal)
    else:
        whole_seconds, frame = divmod(frames, nominal)
    hours, remainder = divmod(whole_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    delimiter = ";" if use_drop else ":"
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{delimiter}{frame:02d}"


def chunk_transcript(segments: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    """Build LOGGER windows while preserving original VOD timestamps."""
    if duration <= 0:
        return []
    chunks: list[dict[str, Any]] = []
    start = 0.0
    while start < duration:
        end = min(duration, start + CHUNK_SECONDS)
        selected = [
            segment for segment in segments
            if float(segment["end"]) > start and float(segment["start"]) < end
        ]
        chunks.append({
            "chunk_number": len(chunks) + 1,
            "chunk_start": round(start, 3),
            "chunk_end": round(end, 3),
            "chunk_start_time": format_hhmmss(start),
            "chunk_end_time": format_hhmmss(end),
            "stream_duration": round(duration, 3),
            "stream_duration_time": format_hhmmss(duration),
            "transcript": selected,
        })
        if end >= duration:
            break
        start += CHUNK_SECONDS - OVERLAP_SECONDS
    total = len(chunks)
    for chunk in chunks:
        chunk["total_chunks"] = total
    return chunks


def update_job(job_id: str, **values: Any) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(values)
            jobs[job_id]["updated_at"] = time.time()


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "id",
        "filename",
        "size",
        "status",
        "stage",
        "message",
        "progress",
        "duration",
        "processed_seconds",
        "elapsed_seconds",
        "eta_seconds",
        "language",
        "detected_language",
        "duration_time",
        "fps",
        "fps_label",
        "fps_source",
        "drop_frame",
        "fps_override",
        "chunk_seconds",
        "overlap_seconds",
        "chunks",
        "ai_mode",
        "ai_model",
        "pipeline_status",
        "pipeline_files",
        "edl_files",
        "csv_files",
        "segments",
        "transcript",
        "error",
        "created_at",
        "updated_at",
    }
    return {key: value for key, value in job.items() if key in allowed}


def write_csv_markers(path: Path, markers: list[dict[str, Any]], fps: float | None, drop_frame: bool | None = None) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Timecode In", "Timecode Out", "Name", "Comment", "Color", "Start seconds", "End seconds"])
        for marker in markers:
            writer.writerow([
                timecode_from_seconds(marker["start"], fps, drop_frame),
                timecode_from_seconds(marker["end"], fps, drop_frame),
                marker.get("name", "SFXFS marker"),
                marker.get("comment", ""),
                marker.get("color", "Blue"),
                f"{float(marker['start']):.3f}",
                f"{float(marker['end']):.3f}",
            ])


def write_edl_markers(path: Path, markers: list[dict[str, Any]], fps: float | None, title: str, drop_frame: bool | None = None) -> None:
    """Write Resolve marker-only EDL with marker duration and Resolve color metadata."""
    rate = fps or 30.0
    use_drop = should_drop_frame(rate) if drop_frame is None else drop_frame
    lines = [f"TITLE: {title}", f"FCM: {'DROP FRAME' if use_drop else 'NON-DROP FRAME'}", ""]
    for index, marker in enumerate(markers, start=1):
        start = float(marker["start"])
        end = max(start + 1.0 / rate, float(marker.get("end", start)))
        start_tc = timecode_from_seconds(start, rate, use_drop)
        end_tc = timecode_from_seconds(end, rate, use_drop)
        duration_frames = max(1, round((end - start) * rate))
        name = str(marker.get("name") or f"SFXFS {index:03d}").replace("\n", " ")
        comment = str(marker.get("comment") or "").replace("\n", " ")
        color = str(marker.get("color") or "Blue")
        lines.append(f"{index:03d}  SFXFS    V     C        {start_tc} {end_tc} {start_tc} {end_tc}")
        lines.append(f"* LOC: {start_tc}")
        lines.append(f"* C:ResolveColor{color}")
        lines.append(f"* M:{name}")
        lines.append(f"* D:{duration_frames}")
        if comment:
            lines.append(f"* COMMENT:{comment}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def marker_list(job: dict[str, Any], level: str) -> list[dict[str, Any]]:
    pipeline = job.get("pipeline") or {}
    markers: list[dict[str, Any]] = []
    colors = {"logger": "Blue", "editor": "Yellow", "cutter": "Green"}
    if level == "logger":
        episodes = pipeline.get("logger_episodes") or []
        for index, item in enumerate(episodes, start=1):
            if "start" not in item or "end" not in item:
                continue
            markers.append({
                "start": float(item["start"]), "end": float(item["end"]),
                "name": item.get("title") or item.get("name") or f"LOGGER {index:03d}",
                "comment": item.get("summary") or item.get("hook") or "",
                "color": colors[level],
            })
    elif level == "editor":
        for index, item in enumerate(pipeline.get("editor_ideas") or [], start=1):
            sources = item.get("source_episodes") or item.get("source_segments") or []
            if sources and isinstance(sources[0], dict):
                for source in sources:
                    if "start" in source and "end" in source:
                        markers.append({
                            "start": float(source["start"]), "end": float(source["end"]),
                            "name": item.get("title_concept") or item.get("title") or f"EDITOR {index:03d}",
                            "comment": item.get("reasoning") or item.get("summary") or "",
                            "color": colors[level],
                        })
            elif "start" in item and "end" in item:
                markers.append({
                    "start": float(item["start"]), "end": float(item["end"]),
                    "name": item.get("title_concept") or item.get("title") or f"EDITOR {index:03d}",
                    "comment": item.get("reasoning") or item.get("summary") or "",
                    "color": colors[level],
                })
    else:
        for index, item in enumerate(pipeline.get("cutter_segments") or [], start=1):
            if "start" not in item or "end" not in item:
                continue
            markers.append({
                "start": float(item["start"]), "end": float(item["end"]),
                "name": item.get("name") or item.get("role") or f"CUTTER {index:03d}",
                "comment": item.get("comment") or item.get("purpose") or item.get("summary") or "",
                "color": colors[level],
            })
    return sorted(markers, key=lambda marker: marker["start"])


def write_pipeline_files(job: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, str]:
    output_dir = RESULT_DIR / job["id"]
    output_dir.mkdir(parents=True, exist_ok=True)
    stream = {
        "stream_id": job["id"],
        "filename": job["filename"],
        "stream_duration": round(float(job.get("duration") or 0), 3),
        "stream_duration_time": job.get("duration_time"),
        "fps": job.get("fps"),
        "fps_label": job.get("fps_label"),
        "drop_frame": job.get("drop_frame"),
        "segments": job.get("segments") or [],
        "chunks": chunks,
        "chunk_policy": {"window_seconds": CHUNK_SECONDS, "overlap_seconds": OVERLAP_SECONDS},
        "prompt_version": PROMPT_VERSION,
    }
    paths: dict[str, str] = {}
    stream_path = output_dir / "stream_transcript.json"
    stream_path.write_text(json.dumps(stream, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["stream_transcript_json"] = str(stream_path)
    for chunk in chunks:
        number = int(chunk["chunk_number"])
        path = output_dir / f"chunk_{number:03d}_logger_input.json"
        path.write_text(json.dumps(chunk, ensure_ascii=False, indent=2), encoding="utf-8")
        paths[f"chunk_{number:03d}"] = str(path)
    editor_input = output_dir / "editor_input.json"
    editor_input.write_text(json.dumps({"stream_id": job["id"], "episodes": []}, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["editor_input_json"] = str(editor_input)
    cutter_input = output_dir / "cutter_input.json"
    cutter_input.write_text(json.dumps({"stream_id": job["id"], "video_idea": None, "transcript_context": []}, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["cutter_input_json"] = str(cutter_input)
    readme = output_dir / "MANUAL_PIPELINE.md"
    readme.write_text(
        "# SFXFS manual pipeline\n\n"
        "1. Send each `chunk_*_logger_input.json` to LOGGER and save JSON responses.\n"
        "2. Upload or paste merged LOGGER JSON via the pipeline result endpoint.\n"
        "3. Use `editor_input.json` for EDITOR, then CUTTER for each selected idea.\n"
        "4. Download `markers_cutter.edl` for Resolve.\n",
        encoding="utf-8",
    )
    paths["manual_readme"] = str(readme)
    return paths


def resolve_model_source() -> str:
    snapshots = MODEL_DIR / f"models--Systran--faster-whisper-{MODEL_NAME}" / "snapshots"
    if snapshots.exists():
        candidates = sorted((path for path in snapshots.iterdir() if path.is_dir()), reverse=True)
        for candidate in candidates:
            if (candidate / "model.bin").exists():
                return str(candidate)
    return MODEL_NAME


def load_model(job_id: str):
    global whisper_model
    if whisper_model is not None:
        return whisper_model
    with model_lock:
        if whisper_model is not None:
            return whisper_model
        update_job(
            job_id,
            status="running",
            stage="model",
            progress=4.0,
            message="Загружаю локальную модель Whisper…",
        )
        from faster_whisper import WhisperModel

        source = resolve_model_source()
        whisper_model = WhisperModel(
            source,
            device="cpu",
            compute_type="int8",
            cpu_threads=max(1, os.cpu_count() or 2),
            num_workers=1,
            download_root=str(MODEL_DIR),
        )
    return whisper_model


def write_results(job: dict[str, Any], segments: list[dict[str, Any]], text: str) -> tuple[Path, Path, Path, dict[str, str]]:
    base = f"{clean_name(job['filename'])}__transcript"
    txt_path = RESULT_DIR / f"{base}.txt"
    md_path = RESULT_DIR / f"{base}.md"
    if txt_path.exists() or md_path.exists():
        base = f"{base}__{job['id']}"
        txt_path = RESULT_DIR / f"{base}.txt"
        md_path = RESULT_DIR / f"{base}.md"
    txt_path.write_text(text.strip() + "\n", encoding="utf-8-sig")

    lines = [
        f"# Транскрипция: {job['filename']}",
        "",
        f"- Создано: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"- Движок: faster-whisper `{MODEL_NAME}`",
        f"- Язык: {job.get('detected_language') or job['language']}",
        f"- Длительность: {format_timestamp(float(job.get('duration') or 0))}",
        "",
        "## Текст",
        "",
        text.strip(),
        "",
        "## Таймкоды",
        "",
    ]
    for segment in segments:
        lines.append(
            f"**[{format_timestamp(segment['start'])} → {format_timestamp(segment['end'])}]**  \n{segment['text']}"
        )
        lines.append("")
    md_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8-sig")
    json_path = RESULT_DIR / f"{base}.json"
    json_path.write_text(
        json.dumps(
            {
                "stream_id": job["id"],
                "filename": job["filename"],
                "duration": job.get("duration"),
                "duration_time": job.get("duration_time"),
                "fps": job.get("fps"),
                "fps_label": job.get("fps_label"),
                "drop_frame": job.get("drop_frame"),
                "language": job.get("detected_language") or job.get("language"),
                "segments": segments,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    chunks = chunk_transcript(segments, float(job.get("duration") or 0))
    pipeline_files = write_pipeline_files(job, chunks)
    return txt_path, md_path, json_path, pipeline_files


def extract_json(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = min([position for position in (cleaned.find("{"), cleaned.find("[")) if position >= 0], default=-1)
        if start < 0:
            raise
        end = max(cleaned.rfind("}"), cleaned.rfind("]"))
        return json.loads(cleaned[start : end + 1])


def openai_response(prompt: str, model: str) -> Any:
    """Small stdlib-only Responses API client; API key never leaves the server logs."""
    import urllib.request

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY не задан; переключите AI mode на Manual или добавьте ключ в .env")
    body = json.dumps({"model": model, "input": prompt, "text": {"format": {"type": "text"}}}).encode()
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        payload = json.loads(response.read().decode("utf-8"))
    output_text = payload.get("output_text")
    if output_text:
        return extract_json(output_text)
    parts: list[str] = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"}:
                parts.append(content.get("text", ""))
    return extract_json("\n".join(parts))


def prompt_for(stage: str, payload: Any) -> str:
    common = (
        "Return valid JSON only. Do not invent facts or timestamps. "
        "All start/end values are absolute seconds from the original VOD.\n\n"
    )
    if stage == "LOGGER":
        instruction = (
            "You are LOGGER. Build a liberal semantic map of this transcript chunk, not video ideas. "
            "Return {episodes:[{start,end,title,summary,type,hook,development,payoff,standalone_score,"
            "editorial_potential,starts_before_chunk,ends_after_chunk,missing_context,related_topics}]} ."
        )
    elif stage == "EDITOR":
        instruction = (
            "You are EDITOR. Review the complete stream index and return {video_ideas:[...]}. "
            "Each idea must cite source episode ids and never invent missing setup or payoff."
        )
    else:
        instruction = (
            "You are CUTTER. For the supplied video idea and transcript context return {source_segments:["
            "{start,end,name,role,comment,purpose}]} with exact continuous source ranges."
        )
    return common + instruction + "\n\nINPUT:\n" + json.dumps(payload, ensure_ascii=False, indent=2)


def normalize_list(value: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in keys:
            if isinstance(value.get(key), list):
                return [item for item in value[key] if isinstance(item, dict)]
    return []


def merge_logger_results(results: list[Any]) -> list[dict[str, Any]]:
    episodes = []
    for result in results:
        episodes.extend(normalize_list(result, ("episodes", "items", "log")))
    clean = [item for item in episodes if item.get("start") is not None and item.get("end") is not None]
    clean.sort(key=lambda item: (float(item["start"]), float(item["end"])))
    merged: list[dict[str, Any]] = []
    for episode in clean:
        start, end = float(episode["start"]), float(episode["end"])
        if merged and start <= float(merged[-1]["end"]) and min(end, float(merged[-1]["end"])) - start >= 30:
            previous = merged[-1]
            previous["end"] = max(float(previous["end"]), end)
            if len(str(episode.get("summary", ""))) > len(str(previous.get("summary", ""))):
                previous["summary"] = episode.get("summary", "")
            previous["related_topics"] = sorted(set((previous.get("related_topics") or []) + (episode.get("related_topics") or [])))
        else:
            copied = dict(episode)
            copied["start"], copied["end"] = start, end
            merged.append(copied)
    for index, episode in enumerate(merged, start=1):
        episode.setdefault("episode_id", index)
    return merged


def run_ai_pipeline(job_id: str, chunks: list[dict[str, Any]]) -> None:
    with jobs_lock:
        job = jobs[job_id]
        mode = job.get("ai_mode", "manual")
        ai_model = job.get("ai_model", "gpt-5-mini")
    if mode != "api":
        update_job(job_id, pipeline_status="manual_ready", message="Транскрипция готова; JSON-входы для Manual Mode сохранены")
        return
    try:
        logger_results: list[Any] = []
        for index, chunk in enumerate(chunks, start=1):
            update_job(job_id, stage="logger", progress=98.0 + min(0.5, index / max(1, len(chunks)) * 0.5), message=f"LOGGER: чанк {index}/{len(chunks)}")
            logger_results.append(openai_response(prompt_for("LOGGER", chunk), ai_model))
        episodes = merge_logger_results(logger_results)
        editor_result = openai_response(prompt_for("EDITOR", {"stream_id": job_id, "episodes": episodes}), ai_model)
        ideas = normalize_list(editor_result, ("video_ideas", "ideas", "items"))
        cutter_segments: list[dict[str, Any]] = []
        for idea in ideas:
            cutter_result = openai_response(prompt_for("CUTTER", {"video_idea": idea, "episodes": episodes}), ai_model)
            cutter_segments.extend(normalize_list(cutter_result, ("source_segments", "segments", "items")))
        update_job(job_id, pipeline={"logger_episodes": episodes, "editor_ideas": ideas, "cutter_segments": cutter_segments}, pipeline_status="api_complete", message="LOGGER / EDITOR / CUTTER завершены")
        finalize_pipeline_outputs(job_id)
    except Exception as exc:
        update_job(job_id, pipeline_status="api_error", message="Транскрипция готова, но AI-анализ завершился ошибкой", error=str(exc))


def finalize_pipeline_outputs(job_id: str) -> None:
    with jobs_lock:
        job = dict(jobs[job_id])
    output_dir = RESULT_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    pipeline = job.get("pipeline") or {}
    pipeline_path = output_dir / "pipeline_results.json"
    pipeline_path.write_text(json.dumps(pipeline, ensure_ascii=False, indent=2), encoding="utf-8")
    editor_input = output_dir / "editor_input.json"
    editor_input.write_text(json.dumps({"stream_id": job_id, "episodes": pipeline.get("logger_episodes") or []}, ensure_ascii=False, indent=2), encoding="utf-8")
    cutter_input = output_dir / "cutter_input.json"
    cutter_input.write_text(json.dumps({"stream_id": job_id, "video_ideas": pipeline.get("editor_ideas") or [], "episodes": pipeline.get("logger_episodes") or []}, ensure_ascii=False, indent=2), encoding="utf-8")
    edl_files: dict[str, str] = {}
    csv_files: dict[str, str] = {}
    for level in ("logger", "editor", "cutter"):
        markers = marker_list(job, level)
        edl_path = output_dir / f"markers_{level}.edl"
        csv_path = output_dir / f"markers_{level}.csv"
        write_edl_markers(edl_path, markers, job.get("fps"), f"SFXFS {level.upper()} markers", job.get("drop_frame"))
        write_csv_markers(csv_path, markers, job.get("fps"), job.get("drop_frame"))
        edl_files[level] = str(edl_path)
        csv_files[level] = str(csv_path)
    update_job(
        job_id,
        edl_files=edl_files,
        csv_files=csv_files,
        pipeline_files={
            **(job.get("pipeline_files") or {}),
            "pipeline_results_json": str(pipeline_path),
            "editor_input_json": str(editor_input),
            "cutter_input_json": str(cutter_input),
        },
    )


def transcribe_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs[job_id]
        source = Path(job["source_path"])
        language = job["language"]
        started = time.monotonic()
    try:
        update_job(job_id, status="running", stage="queued", message="Задача принята", progress=2.0)
        metadata = probe_media(source)
        with jobs_lock:
            fps_override = str(jobs[job_id].get("fps_override") or "").strip()
        if fps_override:
            try:
                override_fps = float(Fraction(fps_override))
                metadata["fps"] = override_fps
                metadata["fps_label"] = fps_override
                metadata["fps_source"] = "manual override"
            except (ValueError, ZeroDivisionError):
                raise ValueError(f"Некорректный FPS override: {fps_override}")
        metadata["drop_frame"] = should_drop_frame(metadata["fps"])
        update_job(
            job_id,
            duration=metadata["duration"],
            duration_time=format_hhmmss(metadata["duration"]),
            fps=metadata["fps"],
            fps_label=metadata["fps_label"],
            fps_source=metadata["fps_source"],
            drop_frame=metadata["drop_frame"],
            chunk_seconds=CHUNK_SECONDS,
            overlap_seconds=OVERLAP_SECONDS,
            stage="analysis",
            progress=5.0,
            message=f"Медиа: {format_hhmmss(metadata['duration'])} · FPS {metadata['fps_label']}",
        )
        model = load_model(job_id)
        with jobs_lock:
            if jobs[job_id].get("cancel_requested"):
                raise InterruptedError("Транскрибация отменена")

        update_job(job_id, stage="analysis", progress=7.0, message="Анализирую звуковую дорожку…")
        import av

        with av.open(str(source)) as media:
            if not media.streams.audio:
                raise ValueError("В этом файле нет звуковой дорожки.")
        language_code = None if language == "auto" else language
        segment_stream, info = model.transcribe(
            str(source),
            language=language_code,
            task="transcribe",
            beam_size=3,
            temperature=0.0,
            condition_on_previous_text=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        duration = float(getattr(info, "duration", 0.0) or metadata["duration"] or 0.0)
        detected = str(getattr(info, "language", "") or language)
        update_job(
            job_id,
            stage="transcription",
            duration=duration,
            duration_time=format_hhmmss(duration),
            detected_language=detected,
            progress=8.0,
            message="Распознаю речь…",
        )

        output_segments: list[dict[str, Any]] = []
        text_parts: list[str] = []
        for index, segment in enumerate(segment_stream, start=1):
            with jobs_lock:
                if jobs[job_id].get("cancel_requested"):
                    raise InterruptedError("Транскрибация отменена")
            segment_text = re.sub(r"\s+", " ", segment.text).strip()
            if not segment_text:
                continue
            item = {
                "id": index,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment_text,
            }
            output_segments.append(item)
            text_parts.append(segment_text)
            elapsed = time.monotonic() - started
            processed = float(segment.end)
            fraction = min(1.0, processed / duration) if duration > 0 else 0.0
            eta = (elapsed / fraction - elapsed) if fraction > 0.015 else None
            update_job(
                job_id,
                processed_seconds=processed,
                elapsed_seconds=elapsed,
                eta_seconds=eta,
                progress=8.0 + fraction * 89.0,
                segments=output_segments.copy(),
                transcript=" ".join(text_parts),
                message=f"Распознано фрагментов: {len(output_segments)}",
            )

        transcript = " ".join(text_parts).strip()
        update_job(job_id, stage="export", progress=98.5, message="Сохраняю TXT и Markdown…")
        with jobs_lock:
            snapshot = dict(jobs[job_id])
        txt_path, md_path, json_path, pipeline_files = write_results(snapshot, output_segments, transcript)
        chunks = chunk_transcript(output_segments, duration)
        elapsed = time.monotonic() - started
        update_job(
            job_id,
            status="complete",
            stage="complete",
            progress=100.0,
            message="Транскрибация готова",
            transcript=transcript,
            segments=output_segments,
            elapsed_seconds=elapsed,
            eta_seconds=0,
            txt_path=str(txt_path),
            md_path=str(md_path),
            json_path=str(json_path),
            chunks=chunks,
            pipeline_files=pipeline_files,
            pipeline_status="manual_ready" if snapshot.get("ai_mode", "manual") == "manual" else "queued",
        )
        if snapshot.get("ai_mode", "manual") == "api":
            run_ai_pipeline(job_id, chunks)
    except InterruptedError as exc:
        update_job(
            job_id,
            status="cancelled",
            stage="cancelled",
            message=str(exc),
            error="",
            eta_seconds=0,
        )
    except Exception as exc:  # surfaced in the local UI
        update_job(
            job_id,
            status="error",
            stage="error",
            message="Не удалось обработать файл",
            error=str(exc) or type(exc).__name__,
            eta_seconds=0,
        )
    finally:
        try:
            source.unlink(missing_ok=True)
        except OSError:
            pass


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "engine": "faster-whisper",
        "model": MODEL_NAME,
        "model_loaded": whisper_model is not None,
    }


@app.post("/api/jobs")
def create_job(
    file: UploadFile = File(...),
    language: str = Form("ru"),
    ai_mode: str = Form("manual"),
    ai_model: str = Form("gpt-5-mini"),
    fps_override: str = Form(""),
) -> dict[str, Any]:
    original_name = Path(file.filename or "media").name
    extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Поддерживаются только MP4, MP3 и WAV")
    if language not in {"ru", "en", "auto"}:
        raise HTTPException(status_code=400, detail="Неизвестный язык")
    if ai_mode not in {"manual", "api"}:
        raise HTTPException(status_code=400, detail="Неизвестный AI mode")

    job_id = uuid.uuid4().hex[:12]
    source_path = UPLOAD_DIR / f"{job_id}{extension}"
    try:
        with source_path.open("wb") as target:
            shutil.copyfileobj(file.file, target, length=1024 * 1024)
    finally:
        file.file.close()
    size = source_path.stat().st_size
    now = time.time()
    job = {
        "id": job_id,
        "filename": original_name,
        "source_path": str(source_path),
        "size": size,
        "status": "queued",
        "stage": "queued",
        "message": "Ожидает запуска",
        "progress": 0.0,
        "duration": 0.0,
        "duration_time": "",
        "fps": None,
        "fps_label": "Auto",
        "fps_source": "",
        "drop_frame": None,
        "fps_override": fps_override.strip(),
        "chunk_seconds": CHUNK_SECONDS,
        "overlap_seconds": OVERLAP_SECONDS,
        "chunks": [],
        "ai_mode": ai_mode,
        "ai_model": ai_model,
        "pipeline_status": "queued",
        "pipeline": {},
        "pipeline_files": {},
        "edl_files": {},
        "csv_files": {},
        "processed_seconds": 0.0,
        "elapsed_seconds": 0.0,
        "eta_seconds": None,
        "language": language,
        "detected_language": "",
        "segments": [],
        "transcript": "",
        "error": "",
        "cancel_requested": False,
        "created_at": now,
        "updated_at": now,
    }
    with jobs_lock:
        jobs[job_id] = job
    worker.submit(transcribe_job, job_id)
    return public_job(job)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Задача не найдена")
        return public_job(dict(job))


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Задача не найдена")
        if job["status"] in {"complete", "error", "cancelled"}:
            return public_job(dict(job))
        job["cancel_requested"] = True
        job["message"] = "Останавливаю после текущего фрагмента…"
        return public_job(dict(job))


@app.get("/api/jobs/{job_id}/download/{kind}")
def download_result(job_id: str, kind: str) -> FileResponse:
    if kind not in {"txt", "md", "json", "logger_edl", "editor_edl", "cutter_edl", "logger_csv", "editor_csv", "cutter_csv", "stream_json", "editor_input", "cutter_input", "manual_readme"}:
        raise HTTPException(status_code=404, detail="Неизвестный формат")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("status") != "complete":
            raise HTTPException(status_code=404, detail="Результат ещё не готов")
        if kind in {"txt", "md", "json"}:
            path = Path(job[f"{kind}_path"])
        elif kind.endswith("_edl"):
            path = Path((job.get("edl_files") or {}).get(kind.removesuffix("_edl"), ""))
        elif kind.endswith("_csv"):
            path = Path((job.get("csv_files") or {}).get(kind.removesuffix("_csv"), ""))
        else:
            file_key = {"stream_json": "stream_transcript_json", "editor_input": "editor_input_json", "cutter_input": "cutter_input_json", "manual_readme": "manual_readme"}[kind]
            path = Path((job.get("pipeline_files") or {}).get(file_key, ""))
    try:
        path = path.resolve()
        allowed_roots = [RESULT_DIR.resolve(), (RESULT_DIR / job_id).resolve()]
    except OSError:
        raise HTTPException(status_code=404, detail="Файл результата не найден")
    if not path.is_file() or not any(path == root or root in path.parents for root in allowed_roots):
        raise HTTPException(status_code=404, detail="Файл результата не найден")
    media_type = "text/plain; charset=utf-8"
    if kind == "md" or kind == "manual_readme":
        media_type = "text/markdown; charset=utf-8"
    elif kind.endswith("_edl"):
        media_type = "text/plain; charset=utf-8"
    elif kind.endswith("_csv"):
        media_type = "text/csv; charset=utf-8"
    elif kind.endswith("json"):
        media_type = "application/json"
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.post("/api/jobs/{job_id}/pipeline/{stage}/result")
def save_pipeline_result(job_id: str, stage: str, payload: Any = Body(...)) -> dict[str, Any]:
    """Manual Mode bridge: paste LOGGER/EDITOR/CUTTER JSON back into the local job."""
    if stage not in {"logger", "editor", "cutter"}:
        raise HTTPException(status_code=400, detail="Этап должен быть logger, editor или cutter")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Задача не найдена")
        pipeline = dict(job.get("pipeline") or {})
    if isinstance(payload, str):
        try:
            payload = extract_json(payload)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Некорректный JSON: {exc}")
    if stage == "logger":
        pipeline["logger_episodes"] = merge_logger_results([payload])
    elif stage == "editor":
        pipeline["editor_ideas"] = normalize_list(payload, ("video_ideas", "ideas", "items"))
    else:
        pipeline["cutter_segments"] = normalize_list(payload, ("source_segments", "segments", "items"))
    update_job(job_id, pipeline=pipeline, pipeline_status=f"manual_{stage}_saved", message=f"Manual Mode: результат {stage.upper()} сохранён")
    finalize_pipeline_outputs(job_id)
    with jobs_lock:
        return public_job(dict(jobs[job_id]))
