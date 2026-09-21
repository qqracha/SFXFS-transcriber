'use client';

import {
  ArrowRight,
  Check,
  Copy,
  Download,
  FileAudio,
  LoaderCircle,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';

const API = 'http://127.0.0.1:8765';
const ACCEPTED = ['mp4', 'mp3', 'wav'];
const TRANSCRIPT_ACCEPTED = ['json', 'md', 'txt'];

type Segment = { id: number; start: number | null; end: number | null; text: string; [key: string]: unknown };
type VideoIdea = Record<string, unknown>;
type TranscriptPreview = {
  filename: string;
  source_format: string;
  duration: number;
  duration_time: string;
  segments: number;
  timestamped: boolean;
  first_timestamp: number | null;
  last_timestamp: number | null;
  chunks_total: number;
  warning: string;
};
type ProjectSummary = {
  id: string;
  filename: string;
  updated_at: number;
  duration_time: string;
  source_format: string;
  timestamped: boolean;
};
type Job = {
  id: string;
  filename: string;
  size: number;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  stage: string;
  message: string;
  progress: number;
  duration: number;
  processed_seconds: number;
  elapsed_seconds: number;
  eta_seconds: number | null;
  language: string;
  detected_language: string;
  segments: Segment[];
  transcript: string;
  error: string;
  duration_time: string;
  fps: number | null;
  fps_label: string;
  fps_source: string;
  chunk_seconds: number;
  overlap_seconds: number;
  chunks: Array<{ chunk_number: number; chunk_start_time: string; chunk_end_time: string }>;
  chunks_total: number;
  chunks_ready: number;
  chunk_manifest: Array<{ chunk_number: number; chunk_start_time: string; chunk_end_time: string; status: 'pending' | 'ready' }>;
  ai_mode: 'manual' | 'api';
  ai_model: string;
  pipeline_status: string;
  pipeline_error: string;
  editor_status: string;
  editor_ideas_count: number;
  editor_ideas: VideoIdea[];
  cutter_input_files: Record<string, string>;
  imported?: boolean;
  source_format?: string;
  timestamped?: boolean;
  timestamp_warning?: string;
  first_timestamp?: number | null;
  last_timestamp?: number | null;
};

function bytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`;
  return `${(value / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function clock(value?: number | null) {
  if (!value || !Number.isFinite(value)) return '—';
  const rounded = Math.max(0, Math.round(value));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stamp(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ideaTitle(idea: VideoIdea, index: number) {
  for (const key of ['title_concept', 'title', 'name']) {
    if (typeof idea[key] === 'string' && idea[key]) return idea[key] as string;
  }
  return `Video idea ${String(index + 1).padStart(2, '0')}`;
}

function stageName(job: Job | null, uploading: boolean) {
  if (uploading) return 'Передаю файл приложению';
  if (!job) return 'Ожидает запуска';
  const names: Record<string, string> = {
    queued: 'В очереди',
    model: 'Подготавливаю модель',
    analysis: 'Читаю звуковую дорожку',
    transcription: 'Распознаю речь',
    export: 'Собираю документы',
    logger: 'LOGGER анализирует чанки',
    editor: 'EDITOR собирает идеи',
    cutter: 'CUTTER уточняет сегменты',
    complete: 'Транскрипция готова',
    cancelled: 'Остановлено',
    error: 'Произошла ошибка',
  };
  return names[job.stage] || job.message;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'media' | 'transcript'>('media');
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [transcriptPreview, setTranscriptPreview] = useState<TranscriptPreview | null>(null);
  const [transcriptUploading, setTranscriptUploading] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [language, setLanguage] = useState('ru');
  const [aiMode, setAiMode] = useState<'manual' | 'api'>('manual');
  const [aiModel, setAiModel] = useState('gpt-5-mini');
  const [fpsOverride, setFpsOverride] = useState('');
  const [dragging, setDragging] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [manualStage, setManualStage] = useState<'logger' | 'stream_index' | 'editor' | 'cutter'>('logger');
  const [manualJson, setManualJson] = useState('');
  const [manualSending, setManualSending] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState(1);

  const mediaUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);

  useEffect(() => {
    fetch(`${API}/api/health`)
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(() => setOnline(true))
      .catch(() => setOnline(false));
  }, []);

  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then((response) => response.ok ? response.json() : [])
      .then((items) => setProjects(items as ProjectSummary[]))
      .catch(() => setProjects([]));
  }, [job?.id]);

  useEffect(() => {
    const currentJobId = job?.id;
    const currentStatus = job?.status;
    const currentPipelineStatus = job?.pipeline_status;
    if (!currentJobId || (!['queued', 'running'].includes(currentStatus ?? '') && currentPipelineStatus !== 'queued')) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${API}/api/jobs/${currentJobId}`);
        if (!response.ok) throw new Error('Сервер не вернул статус задачи');
        setJob(await response.json());
      } catch {
        setError('Потеряно соединение с локальным движком. Перезапустите приложение.');
      }
    }, 650);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, job?.pipeline_status]);

  const selectFile = useCallback((candidate?: File) => {
    if (!candidate) return;
    const extension = candidate.name.split('.').pop()?.toLowerCase() || '';
    if (!ACCEPTED.includes(extension)) {
      setError('Нужен файл MP4, MP3 или WAV.');
      return;
    }
    setError('');
    setJob(null);
    setMode('media');
    setTranscriptFile(null);
    setTranscriptPreview(null);
    setFile(candidate);
  }, []);

  const selectTranscript = useCallback(async (candidate?: File) => {
    if (!candidate) return;
    const extension = candidate.name.split('.').pop()?.toLowerCase() || '';
    if (!TRANSCRIPT_ACCEPTED.includes(extension)) {
      setError('Нужен JSON, Markdown или TXT файл.');
      return;
    }
    setError('');
    setFile(null);
    setJob(null);
    setMode('transcript');
    setTranscriptFile(candidate);
    setTranscriptPreview(null);
    const form = new FormData();
    form.append('file', candidate);
    try {
      const response = await fetch(`${API}/api/transcripts/preview`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({})) as { detail?: string } & Partial<TranscriptPreview>;
      if (!response.ok) throw new Error(payload.detail || 'Не удалось прочитать транскрипцию.');
      setTranscriptPreview(payload as TranscriptPreview);
    } catch (previewError) {
      setTranscriptFile(null);
      setError(previewError instanceof Error ? previewError.message : 'Не удалось прочитать транскрипцию.');
    }
  }, []);

  const importTranscript = async () => {
    if (!transcriptFile || transcriptUploading) return;
    setTranscriptUploading(true);
    setError('');
    const form = new FormData();
    form.append('file', transcriptFile);
    form.append('ai_mode', aiMode);
    form.append('ai_model', aiModel);
    try {
      const response = await fetch(`${API}/api/transcripts/import`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail || 'Не удалось импортировать транскрипцию.');
      setJob(payload as Job);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Не удалось импортировать транскрипцию.');
    } finally {
      setTranscriptUploading(false);
    }
  };

  const openProject = async (projectId: string) => {
    try {
      const response = await fetch(`${API}/api/projects/${projectId}/open`);
      if (!response.ok) throw new Error('Проект не найден.');
      const restored = await response.json() as Job;
      setFile(null);
      setTranscriptFile(null);
      setTranscriptPreview(null);
      setMode('transcript');
      setJob(restored);
      setError('');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Не удалось открыть проект.');
    }
  };

  const start = () => {
    if (!file || uploading) return;
    setError('');
    setUploading(true);
    setUploadProgress(0);
    const form = new FormData();
    form.append('file', file);
    form.append('language', language);
    form.append('ai_mode', aiMode);
    form.append('ai_model', aiModel);
    form.append('fps_override', fpsOverride);
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/api/jobs`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setUploadProgress((event.loaded / event.total) * 100);
    };
    request.onerror = () => {
      setUploading(false);
      setError('Локальный движок недоступен. Запустите приложение через START_APP.cmd.');
    };
    request.onload = () => {
      setUploading(false);
      if (request.status < 200 || request.status >= 300) {
        try { setError(JSON.parse(request.responseText).detail || 'Не удалось принять файл.'); }
        catch { setError('Не удалось принять файл.'); }
        return;
      }
      setJob(JSON.parse(request.responseText));
    };
    request.send(form);
  };

  const cancel = async () => {
    if (!job) return;
    await fetch(`${API}/api/jobs/${job.id}/cancel`, { method: 'POST' });
  };

  const reset = () => {
    setFile(null);
    setJob(null);
    setTranscriptFile(null);
    setTranscriptPreview(null);
    setMode('media');
    setError('');
    setCopied(false);
    setUploadProgress(0);
    setFpsOverride('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const copyTranscript = async () => {
    if (!job?.transcript) return;
    await navigator.clipboard.writeText(job.transcript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const submitManualResult = async () => {
    if (!job || !manualJson.trim() || manualSending) return;
    setManualSending(true);
    setError('');
    try {
      const response = await fetch(`${API}/api/jobs/${job.id}/pipeline/${manualStage}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: manualJson,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail || 'Не удалось сохранить JSON');
      }
      setJob(await response.json());
      setManualJson('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось сохранить JSON');
    } finally {
      setManualSending(false);
    }
  };

  const importPipelineFile = async (stage: 'stream_index' | 'editor', candidate?: File) => {
    if (!job || !candidate) return;
    setManualSending(true);
    setError('');
    try {
      const response = await fetch(`${API}/api/jobs/${job.id}/pipeline/${stage}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: await candidate.text(),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail || `Не удалось импортировать ${stage}.json`);
      }
      const nextJob = await response.json() as Job;
      setJob(nextJob);
      if (stage === 'editor') setSelectedIdea(1);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Не удалось импортировать JSON');
    } finally {
      setManualSending(false);
    }
  };

  const active = uploading || !!job;
  const pipelineRunning = job?.pipeline_status === 'queued';
  const complete = job?.status === 'complete' && !pipelineRunning;
  const running = job?.status === 'queued' || job?.status === 'running' || pipelineRunning;
  const visibleProgress = uploading ? uploadProgress * 0.08 : (job?.progress || 0);

  return (
    <main className="page-frame">
      <header className="site-header">
        <button className="brand" onClick={reset} aria-label="На главную">
          SFXFS<br />TRANS<br />CRIBER<span>.</span>
        </button>
        <div className="header-status">
          <span className={online ? 'status-dot is-online' : 'status-dot'} />
          {online === null ? 'ПРОВЕРКА ДВИЖКА' : online ? 'LOCAL ENGINE / READY' : 'LOCAL ENGINE / OFFLINE'}
        </div>
      </header>

      {!file && !job ? (
        <section className="intro-view">
          <div className="mode-tabs" role="tablist" aria-label="Режим работы">
            <button className={mode === 'media' ? 'is-active' : ''} onClick={() => { setMode('media'); setError(''); }}>Обработать медиа</button>
            <button className={mode === 'transcript' ? 'is-active' : ''} onClick={() => { setMode('transcript'); setError(''); }}>Импорт транскрипции</button>
          </div>
          <p className="eyebrow">New transcript</p>
          <h1>
            {mode === 'media' ? <>Запись —<br /><em>в текст, который</em><br />легко читать<span className="accent-dot">.</span></> : <>Готовый текст —<br /><em>снова в рабочий</em><br />проект<span className="accent-dot">.</span></>}
          </h1>
          <p className="intro-copy">
            {mode === 'media'
              ? 'MP4, MP3 или WAV обрабатываются на этом компьютере. Видно каждый этап: загрузку, текущую позицию в записи и оставшееся время.'
              : 'Импортируйте JSON, Markdown или TXT с готовой транскрипцией. Таймкоды сохранятся, а проект продолжит общий LOGGER → EDITOR → CUTTER pipeline без повторного распознавания.'}
          </p>

          {mode === 'media' ? <div
            className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              selectFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              accept=".mp4,.mp3,.wav,audio/mpeg,audio/wav,video/mp4"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <div>
              <p className="eyebrow">Drop area / 01</p>
              <strong>Перетащите медиафайл</strong>
              <p>или выберите его через Проводник</p>
            </div>
            <span className="drop-action">Выбрать файл <ArrowRight /></span>
          </div> : <div
            className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => transcriptInputRef.current?.click()}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') transcriptInputRef.current?.click(); }}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void selectTranscript(event.dataTransfer.files[0]); }}
          >
            <input ref={transcriptInputRef} type="file" className="sr-only" accept=".json,.md,.txt,application/json,text/markdown,text/plain" onChange={(event) => void selectTranscript(event.target.files?.[0])} />
            <div>
              <p className="eyebrow">Import / 01</p>
              <strong>{transcriptFile ? transcriptFile.name : 'Перетащите готовую транскрипцию'}</strong>
              <p>JSON предпочтителен; также поддерживаются Markdown и TXT с таймкодами.</p>
            </div>
            <span className="drop-action">Выбрать файл <ArrowRight /></span>
          </div>}
          {mode === 'transcript' && transcriptPreview && (
            <div className="transcript-preview-panel">
              <div><span>Формат</span><strong>{transcriptPreview.source_format}</strong></div>
              <div><span>Реплики</span><strong>{transcriptPreview.segments}</strong></div>
              <div><span>Таймкоды</span><strong>{transcriptPreview.timestamped ? 'найдены' : 'нет'}</strong></div>
              <div><span>LOGGER</span><strong>{transcriptPreview.chunks_total} чанка</strong></div>
              {transcriptPreview.warning && <p className="warning-line">{transcriptPreview.warning}</p>}
              <Button className="start-button" onClick={importTranscript} disabled={transcriptUploading}>
                {transcriptUploading ? 'Импортирую…' : 'Импортировать в проект'} <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          )}
          {error && <p className="error-line">{error}</p>}
          <div className="intro-footnote">
            <span>01&nbsp;&nbsp; {mode === 'media' ? 'тот же faster-whisper' : 'без повторного распознавания'}</span>
            <span>02&nbsp;&nbsp; {mode === 'media' ? 'модель small' : 'JSON / MD / TXT'}</span>
            <span>03&nbsp;&nbsp; Manual / OpenAI API</span>
          </div>
          {!!projects.length && <div className="recent-projects"><p className="eyebrow">Recent projects</p>{projects.slice(0, 6).map((project) => <button key={project.id} onClick={() => void openProject(project.id)}><span>{project.filename}</span><small>{project.source_format} · {project.duration_time || 'без длительности'} · {project.timestamped ? 'таймкоды' : 'без таймкодов'}</small><ArrowRight /></button>)}</div>}
        </section>
      ) : (
        <section className="workspace-view">
          <div className="file-head">
            <div className="file-title">
              <p className="eyebrow">{job?.imported ? 'Imported transcript' : 'Current file'}</p>
              <h1>{file?.name || job?.filename}<span className="accent-dot">.</span></h1>
              <p>{file ? `${bytes(file.size)} · ${file.type || 'медиафайл'}` : `${job?.source_format || 'JSON'} · ${job?.timestamped ? 'таймкоды сохранены' : 'без таймкодов'}`}</p>
            </div>
            <div className="file-actions">
              {!job?.imported && <label htmlFor="language-select">
                <span>Язык</span>
                <NativeSelect
                  value={language}
                  id="language-select"
                  disabled={active}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="language-select"
                >
                  <NativeSelectOption value="ru">Русский</NativeSelectOption>
                  <NativeSelectOption value="auto">Определить автоматически</NativeSelectOption>
                  <NativeSelectOption value="en">English</NativeSelectOption>
                </NativeSelect>
              </label>}
              {!job?.imported && <label htmlFor="ai-mode-select">
                <span>AI mode</span>
                <NativeSelect id="ai-mode-select" value={aiMode} disabled={active} onChange={(event) => setAiMode(event.target.value as 'manual' | 'api')} className="language-select">
                  <NativeSelectOption value="manual">Manual / JSON</NativeSelectOption>
                  <NativeSelectOption value="api">OpenAI API</NativeSelectOption>
                </NativeSelect>
              </label>}
              {!job?.imported && aiMode === 'api' && <label><span>Модель</span><input className="model-input" value={aiModel} disabled={active} onChange={(event) => setAiModel(event.target.value)} /></label>}
              {!job?.imported && <label><span>FPS</span><input className="model-input" value={fpsOverride} disabled={active} placeholder="Auto (из файла)" onChange={(event) => setFpsOverride(event.target.value)} /></label>}
              {!active && (
                <button className="text-button" onClick={reset}>Выбрать другой</button>
              )}
            </div>
          </div>

          {!active && file && (
            <div className="ready-panel">
              <div className="media-preview">
                {file.name.toLowerCase().endsWith('.mp4') ? (
                  <video src={mediaUrl} controls preload="metadata" />
                ) : (
                  <div className="audio-preview">
                    <FileAudio />
                    <audio src={mediaUrl} controls preload="metadata" />
                  </div>
                )}
              </div>
              <div className="ready-copy">
                <p className="eyebrow">Ready / 02</p>
                <strong>Всё готово к запуску.</strong>
                <p>Во время первого запуска модель может подготавливаться дольше обычного. Следующие файлы пойдут быстрее.</p>
                <Button className="start-button" onClick={start} disabled={online === false}>
                  Начать транскрибацию <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
            </div>
          )}

          {active && (
            <>
              <section className={`progress-card ${complete ? 'is-complete' : ''}`}>
                <div>
                  <p className="eyebrow">Process / 03</p>
                  <strong>{stageName(job, uploading)}</strong>
                  <p>{error || job?.error || job?.message || 'Подготавливаю задачу…'}</p>
                </div>
                {running ? (
                  <button className="stop-button" onClick={cancel}><Square /> Остановить</button>
                ) : complete ? (
                  <span className="complete-mark"><Check /> Готово</span>
                ) : (
                  <button className="stop-button" onClick={reset}><RotateCcw /> Сначала</button>
                )}
              </section>

              <section className="meter-panel">
                <Progress value={visibleProgress} className="editorial-progress">
                  <ProgressLabel>Общий прогресс</ProgressLabel>
                  <ProgressValue>{(_, value) => `${Math.round(value ?? 0)}%`}</ProgressValue>
                </Progress>
                <div className="progress-stats">
                  <div><b>позиция</b><strong>{clock(job?.processed_seconds)} / {clock(job?.duration)}</strong></div>
                  <div><b>прошло</b><strong>{clock(job?.elapsed_seconds)}</strong></div>
                  <div><b>осталось</b><strong>{complete ? '0:00' : clock(job?.eta_seconds)}</strong></div>
                  <div><b>реплики</b><strong>{job?.segments.length || 0}</strong></div>
                  <div><b>чанки LOGGER</b><strong>{job?.chunks_ready || job?.chunks?.length || 0}</strong></div>
                </div>
              </section>

              {!!job?.chunks_total && (
                <section className="chunk-live-panel">
                  <div>
                    <p className="eyebrow">Live chunks</p>
                    <strong>Готово {job.chunks_ready} из {job.chunks_total}</strong>
                    <p>Каждый JSON появляется сразу после завершения своего окна. Можно отправлять его в LOGGER, пока стрим ещё распознаётся.</p>
                  </div>
                  <div className="chunk-links">
                    {(job.chunk_manifest || []).map((chunk) => chunk.status === 'ready' ? (
                      <a key={chunk.chunk_number} className="download-button" href={`${API}/api/jobs/${job.id}/download/chunk/${chunk.chunk_number}`}>
                        <Download /> ЧАНК {String(chunk.chunk_number).padStart(2, '0')} · {chunk.chunk_start_time}
                      </a>
                    ) : <span key={chunk.chunk_number} className="chunk-pending">ЧАНК {String(chunk.chunk_number).padStart(2, '0')} · {chunk.chunk_start_time} · ожидание</span>)}
                  </div>
                </section>
              )}

              {!complete && running && (
                <div className="working-field" aria-live="polite">
                  <LoaderCircle className="spin" />
                  <div>
                    <p className="eyebrow">Live transcript</p>
                    <p>{job?.segments.at(-1)?.text || 'Первые распознанные фразы появятся здесь.'}</p>
                  </div>
                </div>
              )}

              {complete && job && (
                <section className="result-section">
                  <div className="result-toolbar">
                    <div>
                      <p className="eyebrow">Result / 04</p>
                      <h2>Готовый текст<span className="accent-dot">.</span></h2>
                    </div>
                    <div className="result-actions">
                      <button className="text-button" onClick={copyTranscript}>{copied ? <Check /> : <Copy />} {copied ? 'Скопировано' : 'Копировать'}</button>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/txt`}><Download /> TXT</a>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/md`}><Download /> MD</a>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/json`}><Download /> JSON</a>
                    </div>
                  </div>
                  <div className="pipeline-summary">
                    <div><span>Длительность</span><strong>{job.duration_time || clock(job.duration)}</strong></div>
                    <div><span>FPS</span><strong>{job.fps_label || 'Auto'} <small>({job.fps_source || 'probe'})</small></strong></div>
                    <div><span>LOGGER</span><strong>25 мин / overlap 5 мин</strong></div>
                    <div><span>AI mode</span><strong>{job.ai_mode === 'api' ? 'OpenAI API' : 'Manual JSON'}</strong></div>
                  </div>
                  {job.timestamp_warning && <p className="warning-line result-warning">{job.timestamp_warning}</p>}
                  <div className="export-panel">
                    <div><p className="eyebrow">Resolve exports</p><strong>Маркеры для DaVinci</strong><p>Основной экспорт — CUTTER EDL. Остальные уровни доступны отдельно для проверки.</p></div>
                    <div className="export-links">
                      {(['cutter', 'logger', 'editor'] as const).map((level) => <a key={level} className="download-button" href={`${API}/api/jobs/${job.id}/download/${level}_edl`}><Download /> {level.toUpperCase()} EDL</a>)}
                      {(['cutter', 'logger', 'editor'] as const).map((level) => <a key={`${level}-csv`} className="download-button" href={`${API}/api/jobs/${job.id}/download/${level}_csv`}><Download /> {level.toUpperCase()} CSV</a>)}
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/stream_json`}><Download /> CHUNKS JSON</a>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/editor_input`}><Download /> EDITOR INPUT</a>
                    </div>
                  </div>
                  {job.ai_mode === 'manual' && (
                    <div className="manual-panel">
                      <div>
                        <p className="eyebrow">Manual pipeline</p>
                        <strong>Вернуть ответ нейросети</strong>
                        <p>Импортируй MERGE stream_index и EDITOR output. Приложение свяжет source_episodes с реальными репликами транскрипта.</p>
                        <div className="manual-imports">
                          <label className="import-file-button">Импорт stream_index.json<input type="file" accept=".json,application/json" disabled={manualSending} onChange={(event) => importPipelineFile('stream_index', event.target.files?.[0])} /></label>
                          <label className="import-file-button">Импорт editor_output.json<input type="file" accept=".json,application/json" disabled={manualSending} onChange={(event) => importPipelineFile('editor', event.target.files?.[0])} /></label>
                        </div>
                      </div>
                      <div className="manual-controls">
                        <NativeSelect value={manualStage} onChange={(event) => setManualStage(event.target.value as 'logger' | 'stream_index' | 'editor' | 'cutter')} className="language-select">
                          <NativeSelectOption value="logger">LOGGER result</NativeSelectOption>
                          <NativeSelectOption value="stream_index">stream_index result</NativeSelectOption>
                          <NativeSelectOption value="editor">EDITOR result</NativeSelectOption>
                          <NativeSelectOption value="cutter">CUTTER result</NativeSelectOption>
                        </NativeSelect>
                        <textarea value={manualJson} onChange={(event) => setManualJson(event.target.value)} placeholder='Вставь JSON-ответ, например {"episodes": [...]}' />
                        <Button className="manual-submit" onClick={submitManualResult} disabled={!manualJson.trim() || manualSending}>{manualSending ? 'Сохраняю…' : 'Сохранить JSON'}</Button>
                      </div>
                      {job.pipeline_error && <p className="error-line pipeline-error">{job.pipeline_error}</p>}
                      {!!job.editor_ideas_count && (
                        <div className="editor-ideas-panel">
                          <div>
                            <p className="eyebrow">{job.editor_status || `EDITOR: ${job.editor_ideas_count} video ideas loaded`}</p>
                            <strong>EDITOR: {job.editor_ideas_count} идей</strong>
                          </div>
                          <div className="editor-idea-list">
                            {job.editor_ideas.map((idea, index) => <div key={index}><span>[{String(index + 1).padStart(2, '0')}]</span> {ideaTitle(idea, index)}</div>)}
                          </div>
                          <div className="cutter-choice">
                            <NativeSelect value={String(selectedIdea)} onChange={(event) => setSelectedIdea(Number(event.target.value))} className="language-select">
                              {job.editor_ideas.map((idea, index) => <NativeSelectOption key={index} value={String(index + 1)}>{String(index + 1).padStart(2, '0')} · {ideaTitle(idea, index)}</NativeSelectOption>)}
                            </NativeSelect>
                            {job.cutter_input_files?.[`cutter_input_${String(selectedIdea).padStart(2, '0')}`] ? (
                              <a className="download-button" href={`${API}/api/jobs/${job.id}/download/cutter-input/${selectedIdea}`}><Download /> Скачать CUTTER INPUT</a>
                            ) : <span className="chunk-pending">CUTTER INPUT не собран</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="result-grid">
                    <article className="transcript-paper">
                      {job.transcript || <span className="muted">Речь в файле не обнаружена.</span>}
                    </article>
                    <aside className="segment-list">
                      {job.segments.map((segment) => (
                        <div key={segment.id}>
                          <time>{stamp(segment.start)}—{stamp(segment.end)}</time>
                          <p>{segment.text}</p>
                        </div>
                      ))}
                    </aside>
                  </div>
                  <button className="new-file-button" onClick={reset}><RotateCcw /> Новый файл</button>
                </section>
              )}
            </>
          )}
        </section>
      )}

      <footer className="site-footer">
        <span>faster-whisper 1.2.1 / CPU</span>
        <span>Файлы остаются на этом компьютере</span>
      </footer>
    </main>
  );
}
