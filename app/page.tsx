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

type Segment = { id: number; start: number; end: number; text: string };
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

function stamp(value: number) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
  const [file, setFile] = useState<File | null>(null);
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
  const [manualStage, setManualStage] = useState<'logger' | 'editor' | 'cutter'>('logger');
  const [manualJson, setManualJson] = useState('');
  const [manualSending, setManualSending] = useState(false);

  const mediaUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);

  useEffect(() => {
    fetch(`${API}/api/health`)
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(() => setOnline(true))
      .catch(() => setOnline(false));
  }, []);

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
    setFile(candidate);
  }, []);

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

      {!file ? (
        <section className="intro-view">
          <p className="eyebrow">New transcript</p>
          <h1>
            Запись —<br />
            <em>в текст, который</em><br />
            легко читать<span className="accent-dot">.</span>
          </h1>
          <p className="intro-copy">
            MP4, MP3 или WAV обрабатываются на этом компьютере. Видно каждый этап: загрузку, текущую позицию в записи и оставшееся время.
          </p>

          <div
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
          </div>
          {error && <p className="error-line">{error}</p>}
          <div className="intro-footnote">
            <span>01&nbsp;&nbsp; тот же faster-whisper</span>
            <span>02&nbsp;&nbsp; модель small</span>
            <span>03&nbsp;&nbsp; Manual / OpenAI API</span>
          </div>
        </section>
      ) : (
        <section className="workspace-view">
          <div className="file-head">
            <div className="file-title">
              <p className="eyebrow">Current file</p>
              <h1>{file.name}<span className="accent-dot">.</span></h1>
              <p>{bytes(file.size)} · {file.type || 'медиафайл'}</p>
            </div>
            <div className="file-actions">
              <label htmlFor="language-select">
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
              </label>
              <label htmlFor="ai-mode-select">
                <span>AI mode</span>
                <NativeSelect id="ai-mode-select" value={aiMode} disabled={active} onChange={(event) => setAiMode(event.target.value as 'manual' | 'api')} className="language-select">
                  <NativeSelectOption value="manual">Manual / JSON</NativeSelectOption>
                  <NativeSelectOption value="api">OpenAI API</NativeSelectOption>
                </NativeSelect>
              </label>
              {aiMode === 'api' && <label><span>Модель</span><input className="model-input" value={aiModel} disabled={active} onChange={(event) => setAiModel(event.target.value)} /></label>}
              <label><span>FPS</span><input className="model-input" value={fpsOverride} disabled={active} placeholder="Auto (из файла)" onChange={(event) => setFpsOverride(event.target.value)} /></label>
              {!active && (
                <button className="text-button" onClick={reset}>Выбрать другой</button>
              )}
            </div>
          </div>

          {!active && (
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
                  <div><b>чанки LOGGER</b><strong>{job?.chunks?.length || 0}</strong></div>
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
                  <div className="export-panel">
                    <div><p className="eyebrow">Resolve exports</p><strong>Маркеры для DaVinci</strong><p>Основной экспорт — CUTTER EDL. Остальные уровни доступны отдельно для проверки.</p></div>
                    <div className="export-links">
                      {(['cutter', 'logger', 'editor'] as const).map((level) => <a key={level} className="download-button" href={`${API}/api/jobs/${job.id}/download/${level}_edl`}><Download /> {level.toUpperCase()} EDL</a>)}
                      {(['cutter', 'logger', 'editor'] as const).map((level) => <a key={`${level}-csv`} className="download-button" href={`${API}/api/jobs/${job.id}/download/${level}_csv`}><Download /> {level.toUpperCase()} CSV</a>)}
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/stream_json`}><Download /> CHUNKS JSON</a>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/editor_input`}><Download /> EDITOR INPUT</a>
                      <a className="download-button" href={`${API}/api/jobs/${job.id}/download/cutter_input`}><Download /> CUTTER INPUT</a>
                    </div>
                  </div>
                  {job.ai_mode === 'manual' && (
                    <div className="manual-panel">
                      <div>
                        <p className="eyebrow">Manual pipeline</p>
                        <strong>Вернуть ответ нейросети</strong>
                        <p>Скачай JSON-входы, отправь их в LOGGER / EDITOR / CUTTER и вставь ответ сюда. После CUTTER EDL обновится автоматически.</p>
                      </div>
                      <div className="manual-controls">
                        <NativeSelect value={manualStage} onChange={(event) => setManualStage(event.target.value as 'logger' | 'editor' | 'cutter')} className="language-select">
                          <NativeSelectOption value="logger">LOGGER result</NativeSelectOption>
                          <NativeSelectOption value="editor">EDITOR result</NativeSelectOption>
                          <NativeSelectOption value="cutter">CUTTER result</NativeSelectOption>
                        </NativeSelect>
                        <textarea value={manualJson} onChange={(event) => setManualJson(event.target.value)} placeholder='Вставь JSON-ответ, например {"episodes": [...]}' />
                        <Button className="manual-submit" onClick={submitManualResult} disabled={!manualJson.trim() || manualSending}>{manualSending ? 'Сохраняю…' : 'Сохранить JSON'}</Button>
                      </div>
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
