import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './CascadeMenu.module.css';

export interface CascadeOption<T> {
  id: string;
  label: string;
  detail?: string;
  children?: CascadeOption<T>[];
  value?: T;
}

const columnWidth = 216;
const inset = 12;
const gap = 6;

function menuPosition(anchor: HTMLElement, above: boolean, levels: number) {
  const rect = anchor.getBoundingClientRect();
  const compact = innerWidth < columnWidth * levels + inset * 2 || window.matchMedia?.('(hover: none)').matches === true;
  const width = compact ? Math.min(336, innerWidth - inset * 2) : columnWidth;
  const below = innerHeight - rect.bottom - inset - gap;
  const before = rect.top - inset - gap;
  const prefer = above ? before : below;
  const up = prefer >= 240 || prefer >= (above ? below : before) ? above : !above;
  return {
    compact, width, height: Math.max(56, Math.min(340, up ? before : below)),
    left: Math.max(inset, Math.min(rect.left, innerWidth - inset - width * (compact ? 1 : levels))),
    edge: up ? { bottom: innerHeight - rect.top + gap } : { top: rect.bottom + gap }
  };
}

export function CascadeMenu<T>({ options, levels, label, buttonLabel, menuLabel, className, selected = [], above = false, disabled = false, onSelect }: {
  options: CascadeOption<T>[];
  levels: readonly string[];
  label: string;
  buttonLabel: string;
  menuLabel: string;
  className?: string;
  selected?: string[];
  above?: boolean;
  disabled?: boolean;
  onSelect: (value: T) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ depth: number; index: number } | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof menuPosition> | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const open = position !== null;
  const columns = [options];
  for (const branch of trail) {
    const children = columns.at(-1)?.find(item => item.id === branch)?.children;
    if (!children?.length) break;
    columns.push(children);
  }

  function close(restoreFocus = false) {
    setPosition(null);
    pendingFocus.current = null;
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    }
    function reposition(event: Event) {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      if (trigger.current) setPosition(menuPosition(trigger.current, above, levels.length));
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, above, levels.length]);

  useEffect(() => { if (disabled && open) close(); }, [disabled, open]);

  useLayoutEffect(() => {
    const focus = pendingFocus.current;
    if (!focus || !panel.current) return;
    const rows = panel.current.querySelectorAll<HTMLButtonElement>('[data-depth="' + focus.depth + '"] > button[data-row]');
    rows[focus.index]?.focus();
    pendingFocus.current = null;
  }, [position, trail]);

  function show(anchor: HTMLButtonElement, focus: boolean) {
    if (disabled) return;
    setTrail([]);
    if (focus) pendingFocus.current = { depth: 0, index: 0 };
    setPosition(menuPosition(anchor, above, levels.length));
  }

  function expand(depth: number, item: CascadeOption<T>, focus: boolean) {
    if (focus) pendingFocus.current = { depth: depth + 1, index: 0 };
    setTrail(previous => {
      const next = previous.slice(0, depth);
      if (item.children?.length) next.push(item.id);
      return !focus && next.length === previous.length && next.every((part, index) => part === previous[index]) ? previous : next;
    });
  }

  function back(depth: number) {
    const parent = columns[depth - 1];
    if (!parent) return;
    pendingFocus.current = { depth: depth - 1, index: parent.findIndex(item => item.id === trail[depth - 1]) };
    setTrail(trail.slice(0, depth - 1));
  }

  function handleRowKey(event: KeyboardEvent<HTMLButtonElement>, item: CascadeOption<T>, depth: number, index: number, length: number) {
    const group = event.currentTarget.parentElement;
    if (event.key === 'ArrowRight' && item.children?.length) { event.preventDefault(); expand(depth, item, true); }
    else if (event.key === 'ArrowLeft' && depth) { event.preventDefault(); back(depth); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : (index + (event.key === 'ArrowDown' ? 1 : length - 1)) % length;
      group?.querySelectorAll<HTMLButtonElement>('button[data-row]')[next]?.focus();
    }
  }

  return <>
    <button ref={trigger} type="button" className={[styles.trigger, className].filter(Boolean).join(' ')} aria-label={buttonLabel} aria-expanded={open} aria-controls={open ? id : undefined} aria-disabled={disabled || undefined} title={label}
      onClick={event => open ? close() : show(event.currentTarget, event.detail === 0)}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' || disabled) return;
        event.preventDefault();
        if (open) panel.current?.querySelector<HTMLButtonElement>('button[data-row]')?.focus();
        else show(event.currentTarget, true);
      }}>
      <span>{label}</span><span aria-hidden="true">⌄</span>
    </button>
    {position && createPortal(<div ref={panel} id={id} role="group" aria-label={menuLabel} className={styles.panel} style={{ left: position.left, alignItems: position.edge.bottom === undefined ? 'flex-start' : 'flex-end', ...position.edge }}>
      {columns.map((items, depth) => (!position.compact || depth === columns.length - 1) && <div key={depth} role="group" aria-label={levels[depth]} className={styles.column} style={{ width: position.width, maxHeight: position.height }} data-depth={depth}>
        {position.compact && depth > 0 ? <button type="button" className={styles.back} onClick={() => back(depth)}><span aria-hidden="true">‹</span> 返回 {levels[depth - 1]}</button> : <div className={styles.heading}>{levels[depth]}</div>}
        {items.map((item, index) => {
          const hasChildren = Boolean(item.children?.length);
          const current = selected[depth] === item.id && selected.slice(0, depth).every((part, at) => part === trail[at]);
          const active = hasChildren && item.id === trail[depth];
          return <button key={item.id} type="button" data-row="" className={styles.row} data-active={active} data-current={current} title={item.detail || item.label}
            aria-label={item.detail ? item.label + '，' + item.detail : undefined}
            aria-expanded={hasChildren ? active : undefined} aria-pressed={!hasChildren ? current : undefined}
            onPointerEnter={event => { if (!position.compact && event.pointerType === 'mouse') expand(depth, item, false); }}
            onKeyDown={event => handleRowKey(event, item, depth, index, items.length)}
            onClick={event => {
              if (disabled) return;
              if (hasChildren) expand(depth, item, position.compact || event.detail === 0);
              else if (item.value !== undefined) { close(true); onSelect(item.value); }
            }}>
            <span className={styles.itemText}><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</span>
            {hasChildren ? <span aria-hidden="true">›</span> : current && <span aria-hidden="true">✓</span>}
          </button>;
        })}
        {!items.length && <p className={styles.empty}>暂无可选项</p>}
      </div>)}
    </div>, document.body)}
  </>;
}
