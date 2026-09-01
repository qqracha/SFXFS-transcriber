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
  Upload,
  X,
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
  const [dragging, setDragging] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const mediaUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);

  useEffect(() => {
    fetch(`${API}/api/health`)
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(() => setOnline(true))
      .catch(() => setOnline(false));
  }, []);

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${API}/api/jobs/${job.id}`);
        if (!response.ok) throw new Error('Сервер не вернул статус задачи');
        setJob(await response.json());
      } catch {
        setError('Потеряно соединение с локальным движком. Перезапустите приложение.');
      }
    }, 650);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

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
    if (inputRef.current) inputRef.current.value = '';
  };

  const copyTranscript = async () => {
    if (!job?.transcript) return;
    await navigator.clipboard.writeText(job.transcript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const active = uploading || !!job;
  const complete = job?.status === 'complete';
  const running = job?.status === 'queued' || job?.status === 'running';
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
            <span>03&nbsp;&nbsp; без облака и API</span>
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
              <label>
                <span>Язык</span>
                <NativeSelect
                  value={language}
                  disabled={active}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="language-select"
                >
                  <NativeSelectOption value="ru">Русский</NativeSelectOption>
                  <NativeSelectOption value="auto">Определить автоматически</NativeSelectOption>
                  <NativeSelectOption value="en">English</NativeSelectOption>
                </NativeSelect>
              </label>
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
                  <ProgressValue>{Math.round(visibleProgress)}%</ProgressValue>
                </Progress>
                <div className="progress-stats">
                  <div><b>позиция</b><strong>{clock(job?.processed_seconds)} / {clock(job?.duration)}</strong></div>
                  <div><b>прошло</b><strong>{clock(job?.elapsed_seconds)}</strong></div>
                  <div><b>осталось</b><strong>{complete ? '0:00' : clock(job?.eta_seconds)}</strong></div>
                  <div><b>фрагменты</b><strong>{job?.segments.length || 0}</strong></div>
                </div>
              </section>

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
                    </div>
                  </div>
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
