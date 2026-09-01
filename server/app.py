from __future__ import annotations

import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
        "segments",
        "transcript",
        "error",
        "created_at",
        "updated_at",
    }
    return {key: value for key, value in job.items() if key in allowed}


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


def write_results(job: dict[str, Any], segments: list[dict[str, Any]], text: str) -> tuple[Path, Path]:
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
    return txt_path, md_path


def transcribe_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs[job_id]
        source = Path(job["source_path"])
        language = job["language"]
        started = time.monotonic()
    try:
        update_job(job_id, status="running", stage="queued", message="Задача принята", progress=2.0)
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
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        detected = str(getattr(info, "language", "") or language)
        update_job(
            job_id,
            stage="transcription",
            duration=duration,
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
        txt_path, md_path = write_results(snapshot, output_segments, transcript)
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
        )
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
def create_job(file: UploadFile = File(...), language: str = Form("ru")) -> dict[str, Any]:
    original_name = Path(file.filename or "media").name
    extension = Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Поддерживаются только MP4, MP3 и WAV")
    if language not in {"ru", "en", "auto"}:
        raise HTTPException(status_code=400, detail="Неизвестный язык")

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
    if kind not in {"txt", "md"}:
        raise HTTPException(status_code=404, detail="Неизвестный формат")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("status") != "complete":
            raise HTTPException(status_code=404, detail="Результат ещё не готов")
        path = Path(job[f"{kind}_path"])
    if not path.is_file() or path.parent.resolve() != RESULT_DIR.resolve():
        raise HTTPException(status_code=404, detail="Файл результата не найден")
    media_type = "text/plain; charset=utf-8" if kind == "txt" else "text/markdown; charset=utf-8"
    return FileResponse(path, media_type=media_type, filename=path.name)
