import { useEffect, useRef, useState } from 'react';
import { speechErrorMessage, speechRecognitionConstructor, type BrowserSpeechRecognition } from './speechRecognition.js';
import styles from './SpeechInput.module.css';

export function SpeechInput({ value, onChange, maxLength, disabled = false }: {
  value: string; onChange(value: string): void; maxLength: number; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening' | 'stopping'>('idle');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const recognition = useRef<BrowserSpeechRecognition | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Constructor = speechRecognitionConstructor();
  const unavailable = !window.isSecureContext ? '语音输入需要 HTTPS 或 localhost 安全环境。'
    : !Constructor ? '当前浏览器不支持语音识别，请使用支持此功能的浏览器或键盘输入。' : '';

  function release() {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    const current = recognition.current;
    recognition.current = null;
    if (!current) return;
    current.onstart = null; current.onend = null; current.onerror = null; current.onresult = null;
    try { current.abort(); } catch { /* Some browsers throw after the service has already ended. */ }
  }
  function cancel() {
    release(); setPhase('idle'); setInterim(''); setTranscript(''); setError(''); setOpen(false);
  }
  useEffect(() => {
    if (disabled) cancel();
    return release;
  }, [disabled]);
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', cancel);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', cancel); };
  }, []);

  function start() {
    if (disabled || unavailable || !Constructor || recognition.current) return;
    setError(''); setInterim(''); setPhase('starting');
    const prefix = transcript;
    let finalText = '';
    try {
      const current = new Constructor();
      recognition.current = current;
      current.lang = 'zh-CN'; current.continuous = true; current.interimResults = true;
      current.onstart = () => {
        if (recognition.current !== current) return;
        if (timeout.current) clearTimeout(timeout.current);
        timeout.current = null;
        setPhase('listening');
      };
      current.onresult = event => {
        if (recognition.current !== current) return;
        // Rebuild the cumulative result list so interim revisions and repeated events do not duplicate text.
        const results = Array.from(event.results);
        finalText = results.filter(result => result.isFinal).map(result => result[0]?.transcript || '').join('');
        setTranscript(prefix + finalText);
        setInterim(results.filter(result => !result.isFinal).map(result => result[0]?.transcript || '').join(''));
      };
      current.onerror = event => {
        if (recognition.current !== current) return;
        release(); setPhase('idle'); setInterim(''); setError(speechErrorMessage(event.error));
      };
      current.onend = () => {
        if (recognition.current !== current) return;
        release(); setPhase('idle'); setInterim('');
        if (!finalText.trim()) setError('未识别到新的语音，请重试或使用键盘输入。');
      };
      timeout.current = setTimeout(() => {
        release(); setPhase('idle'); setError('语音识别启动超时，请检查麦克风权限后重试。');
      }, 15_000);
      current.start();
    } catch {
      release(); setPhase('idle'); setError('无法启动语音识别，请检查麦克风权限后重试。');
    }
  }
  function stop() {
    const current = recognition.current;
    if (!current) return;
    current.onstart = null;
    setPhase('stopping');
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      release(); setPhase('idle'); setInterim(''); setError('识别结束超时，已保留确认的文字；未确认的片段请重新输入。');
    }, 5000);
    try { current.stop(); }
    catch { release(); setPhase('idle'); setInterim(''); setError('无法正常结束识别，已保留确认的文字。'); }
  }
  const appended = value + (value && !/\s$/.test(value) ? '\n' : '') + transcript.trim();
  const tooLong = appended.length > maxLength;
  return <div className={styles.root}>
    <button type="button" className={styles.trigger} disabled={disabled} aria-expanded={open} onClick={() => open ? cancel() : setOpen(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>语音输入
    </button>
    {open && <div className={styles.panel} aria-label="语音识别">
      {unavailable ? <p role="status">{unavailable}</p> : <>
        <p className={styles.hint}>中文识别 · 音频可能由浏览器发送至其语音服务。核对后插入文字，再手动发送。</p>
        <p role="status">{phase === 'starting' ? '正在启动，请允许麦克风访问…' : phase === 'listening' ? '正在聆听…' : phase === 'stopping' ? '正在完成识别…' : '点击开始录音。'}</p>
        {(transcript || interim) && <p className={styles.preview} aria-label="识别结果">{transcript}<span className={styles.interim}>{interim}</span></p>}
        {error && <p role="alert">{error}</p>}
        {tooLong && <p role="alert">插入后超过 {maxLength} 字限制，请先缩短输入框内容。</p>}
        <div className={styles.actions}>
          {phase === 'idle' ? <button type="button" onClick={start} disabled={disabled}>{transcript ? '继续录音' : '开始录音'}</button> : <button type="button" onClick={stop} disabled={phase === 'stopping'}>停止录音</button>}
          <button type="button" disabled={disabled || phase !== 'idle' || !transcript.trim() || tooLong} onClick={() => { onChange(appended); cancel(); }}>插入文字</button>
          <button type="button" onClick={cancel}>取消</button>
        </div>
      </>}
    </div>}
  </div>;
}
