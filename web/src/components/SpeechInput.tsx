import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { speechErrorMessage, speechRecognitionConstructor, type BrowserSpeechRecognition } from './speechRecognition.js';
import styles from './SpeechInput.module.css';

export function SpeechInput({ value, onChange, maxLength, disabled = false }: {
  value: string; onChange(value: string): void; maxLength: number; disabled?: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening' | 'stopping'>('idle');
  const [error, setError] = useState('');
  const [overflow, setOverflow] = useState('');
  const statusId = useId();
  const recognition = useRef<BrowserSpeechRecognition | null>(null);
  const transcript = useRef('');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value, onChange, maxLength, disabled });
  useLayoutEffect(() => { latest.current = { value, onChange, maxLength, disabled }; });

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
    release(); setPhase('idle'); transcript.current = ''; setError(''); setOverflow('');
  }
  function finish(message = '') {
    if (!recognition.current) return;
    const text = transcript.current.trim();
    release(); setPhase('idle'); transcript.current = '';
    if (latest.current.disabled) return;
    if (text) {
      const draft = latest.current.value;
      const appended = draft + (draft && !/\s$/.test(draft) ? '\n' : '') + text;
      if (appended.length > latest.current.maxLength) {
        setOverflow(text);
        setError(`识别文字超过 ${latest.current.maxLength} 字限制，草稿未修改。请复制下方文字后自行精简。${message}`);
        return;
      }
      latest.current.onChange(appended);
    }
    setError(message || (text ? '' : '未识别到语音，请重试或使用键盘输入。'));
  }
  useEffect(() => {
    if (disabled) cancel();
    return release;
  }, [disabled]);
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && recognition.current) { event.preventDefault(); cancel(); } };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', cancel);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', cancel); window.removeEventListener('keydown', escape); };
  }, []);

  function start() {
    if (disabled || recognition.current) return;
    const Constructor = speechRecognitionConstructor();
    if (!window.isSecureContext || !Constructor) {
      setError(!window.isSecureContext ? '语音输入需要 HTTPS 或 localhost 安全环境。' : '当前浏览器不支持语音识别，请使用支持此功能的浏览器或键盘输入。');
      return;
    }
    setError(''); setOverflow(''); transcript.current = ''; setPhase('starting');
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
        // Replace cumulative results; repeated events and interim revisions must not duplicate text.
        transcript.current = Array.from(event.results).filter(result => result.isFinal).map(result => result[0]?.transcript || '').join('');
      };
      current.onerror = event => { if (recognition.current === current) finish(speechErrorMessage(event.error)); };
      current.onend = () => { if (recognition.current === current) finish(); };
      timeout.current = setTimeout(() => finish('语音识别启动超时，请检查麦克风权限后重试。'), 15_000);
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
    timeout.current = setTimeout(() => finish('识别结束超时，已填入确认的文字；未确认的片段请重新输入。'), 5000);
    try { current.stop(); }
    catch { finish('无法正常结束识别，已填入确认的文字。'); }
  }
  const active = phase !== 'idle';
  const status = phase === 'starting' ? '正在启动，请允许麦克风访问…' : phase === 'listening' ? '正在聆听，点击停止录音后填入文字。' : phase === 'stopping' ? '正在完成识别…' : '';
  return <div className={styles.root}>
    <button type="button" className={`${styles.control} ${active ? styles.recording : ''}`} disabled={disabled || phase === 'stopping'} aria-label={active ? '停止录音' : '语音输入'} aria-pressed={active} aria-describedby={statusId} title={active ? '停止录音（Esc 取消）' : '语音输入 · 中文识别；音频可能由浏览器发送至其语音服务'} onClick={active ? stop : start}>
      {active ? <><span className={styles.wave} data-listening={phase === 'listening'} aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</span><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" /></svg></> : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6" /></svg>}
    </button>
    <span className={styles.srOnly} id={statusId} role="status">{status}</span>
    {error && <div className={styles.error}>
      <p role="alert">{error}</p>
      {overflow && <p className={styles.recovery} aria-label="未填入的识别文字">{overflow}</p>}
      <button type="button" onClick={() => { setError(''); setOverflow(''); }} aria-label="关闭语音提示">关闭</button>
    </div>}
  </div>;
}
