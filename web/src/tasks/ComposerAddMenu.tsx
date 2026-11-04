import { useEffect, useRef, useState } from 'react';
import styles from './ComposerAddMenu.module.css';

interface Props {
  disabled: boolean;
  attachmentHint: string;
  goalEnabled: boolean;
  planMode: boolean;
  onAttach(): void;
  onGoal(): void;
  onPlan(): void;
}

export function ComposerAddMenu({ disabled, attachmentHint, goalEnabled, planMode, onAttach, onGoal, onPlan }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function choose(action: () => void) { setOpen(false); trigger.current?.focus(); action(); }
  return <div ref={root} className={styles.root} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} className="tc-attach-button" type="button" aria-label="添加文件或模式" aria-expanded={open} aria-controls="task-composer-add" disabled={disabled} onClick={() => setOpen(value => !value)}>＋</button>
    {open && <div id="task-composer-add" className={styles.panel} role="group" aria-label="添加文件或模式">
      <span className={styles.heading}>添加</span>
      <button type="button" aria-label="添加文件" disabled={Boolean(attachmentHint)} onClick={() => choose(onAttach)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8m-3 9 6-6" /></svg><span>添加文件<small>{attachmentHint || '选择任务参考文件'}</small></span></button>
      <button type="button" aria-pressed={goalEnabled} onClick={() => choose(onGoal)}><span aria-hidden="true">◎</span><span>目标<small>设置要持续追求的目标</small></span><span aria-hidden="true">{goalEnabled ? '✓' : ''}</span></button>
      <button type="button" aria-pressed={planMode} onClick={() => choose(onPlan)}><span aria-hidden="true">☷</span><span>计划模式<small>先制定计划，确认后再实施</small></span><span aria-hidden="true">{planMode ? '✓' : ''}</span></button>
    </div>}
  </div>;
}
