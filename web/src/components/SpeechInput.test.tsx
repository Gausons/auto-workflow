import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechInput } from './SpeechInput.js';
import { mockSpeechRecognition, SpeechRecognitionMock } from '../test/speechRecognitionMock.js';

function Harness({ disabled = false, maxLength = 12000 }: { disabled?: boolean; maxLength?: number }) {
  const [value, setValue] = useState('原有草稿');
  return <form onSubmit={event => { event.preventDefault(); throw new Error('Speech must not submit'); }}>
    <textarea aria-label="草稿" value={value} onChange={event => setValue(event.target.value)} />
    <SpeechInput value={value} onChange={setValue} disabled={disabled} maxLength={maxLength} />
  </form>;
}
async function start() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '语音输入' }));
  expect(SpeechRecognitionMock.instances).toHaveLength(1);
  return { user, recognition: SpeechRecognitionMock.instances.at(-1)! };
}

describe('SpeechInput', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([false, true])('fills finalized results on stop without duplicating, overwriting edits or submitting, prefixed=%s', async prefixed => {
    mockSpeechRecognition(prefixed);
    render(<Harness />);
    const { user, recognition } = await start();
    expect(recognition.lang).toBe('zh-CN');
    act(() => recognition.result(['修复', false]));
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿');
    act(() => recognition.result(['修复问题。', true], ['检查', false]));
    act(() => recognition.result(['修复问题。', true], ['检查测试。', true]));
    act(() => recognition.result(['修复问题。', true], ['检查测试。', true]));
    await user.type(screen.getByLabelText('草稿'), '（补充）');
    expect(screen.queryByRole('button', { name: '插入文字' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '停止录音' }));
    expect(recognition.stop).toHaveBeenCalledOnce();
    act(() => recognition.onend?.());
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿（补充）\n修复问题。检查测试。');
    expect(screen.queryByRole('button', { name: '插入文字' })).toBeNull();
  });

  it.each(['not-allowed', 'audio-capture', 'network', 'no-speech', 'service-not-allowed', 'language-not-supported', 'unknown'])('shows %s errors, retains final text and allows explicit retry', async error => {
    mockSpeechRecognition(); render(<Harness />);
    const { user, recognition } = await start();
    act(() => recognition.result(['第一段。', true], ['未确认', false]));
    act(() => recognition.onerror?.({ error }));
    expect(screen.getByRole('alert').textContent).toBeTruthy();
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿\n第一段。');
    expect(recognition.abort).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '语音输入' }));
    const next = SpeechRecognitionMock.instances.at(-1)!;
    act(() => { next.result(['第二段。', true]); next.onend?.(); });
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿\n第一段。\n第二段。');
  });

  it('blocks over-limit insertion without truncating the transcript or existing draft', async () => {
    mockSpeechRecognition(); render(<Harness maxLength={6} />);
    const { recognition } = await start();
    act(() => { recognition.result(['完整文字', true]); recognition.onend?.(); });
    expect(screen.getByRole('alert').textContent).toContain('超过 6 字');
    expect(screen.queryByRole('button', { name: '插入文字' })).toBeNull();
    expect(screen.getByLabelText('未填入的识别文字').textContent).toBe('完整文字');
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿');
  });

  it.each(['cancel', 'unmount', 'disabled', 'hidden', 'pagehide'])('aborts on %s and ignores late events', async reason => {
    mockSpeechRecognition(); const view = render(<Harness />);
    const { user, recognition } = await start();
    const lateResult = recognition.onresult!;
    if (reason === 'cancel') await user.keyboard('{Escape}');
    else if (reason === 'unmount') view.unmount();
    else if (reason === 'disabled') view.rerender(<Harness disabled />);
    else if (reason === 'pagehide') fireEvent(window, new Event('pagehide'));
    else { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); fireEvent(document, new Event('visibilitychange')); }
    expect(recognition.abort).toHaveBeenCalledOnce();
    act(() => lateResult({ results: [{ isFinal: true, 0: { transcript: '迟到结果' } }] }));
    expect(screen.queryByText('迟到结果')).toBeNull();
    if (reason !== 'unmount') expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿');
  });

  it.each(['unsupported', 'insecure'])('explains %s environments without starting the microphone', async reason => {
    mockSpeechRecognition();
    vi.stubGlobal(reason === 'unsupported' ? 'SpeechRecognition' : 'isSecureContext', reason === 'unsupported' ? undefined : false);
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole('button', { name: '语音输入' }));
    expect(screen.getByRole('alert').textContent).toContain(reason === 'unsupported' ? '不支持' : 'HTTPS');
    expect(screen.queryByRole('button', { name: '开始录音' })).toBeNull();
    expect(SpeechRecognitionMock.instances).toHaveLength(0);
  });

  it('does not start while disabled', () => {
    mockSpeechRecognition(); render(<Harness disabled />);
    expect(screen.getByRole('button', { name: '语音输入' })).toHaveProperty('disabled', true);
    expect(SpeechRecognitionMock.instances).toHaveLength(0);
  });

  it('recovers when start throws and from an end event without speech', async () => {
    mockSpeechRecognition();
    class FailingRecognition extends SpeechRecognitionMock { start = vi.fn(() => { throw new Error('denied'); }); }
    vi.stubGlobal('SpeechRecognition', FailingRecognition);
    render(<Harness />);
    await start();
    expect(screen.getByRole('alert').textContent).toContain('无法启动');
    vi.stubGlobal('SpeechRecognition', SpeechRecognitionMock);
    // Rerender to read the replacement browser implementation.
    cleanup(); render(<Harness />); SpeechRecognitionMock.instances = [];
    const { recognition } = await start();
    act(() => recognition.onend?.());
    expect(screen.getByRole('alert').textContent).toContain('未识别到');
  });

  it('times out a service that never starts without losing the draft', () => {
    vi.useFakeTimers(); mockSpeechRecognition();
    class PendingRecognition extends SpeechRecognitionMock { start = vi.fn(); }
    vi.stubGlobal('SpeechRecognition', PendingRecognition);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    const recognition = SpeechRecognitionMock.instances.at(-1)!;
    act(() => vi.advanceTimersByTime(15_000));
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('启动超时');
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿');
    expect(screen.getByRole('button', { name: '语音输入' })).toBeTruthy();
  });

  it('can stop before microphone permission resolves without returning to listening', () => {
    mockSpeechRecognition();
    class PendingRecognition extends SpeechRecognitionMock { start = vi.fn(); }
    vi.stubGlobal('SpeechRecognition', PendingRecognition);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    const recognition = SpeechRecognitionMock.instances.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: '停止录音' }));
    act(() => recognition.onstart?.());
    expect(screen.getByRole('status').textContent).toBe('正在完成识别…');
    expect(screen.getByRole('button', { name: '停止录音' })).toHaveProperty('disabled', true);
    act(() => recognition.onend?.());
    expect(screen.getByRole('button', { name: '语音输入' })).toBeTruthy();
  });

  it('releases a service that never finishes stopping', () => {
    vi.useFakeTimers(); mockSpeechRecognition(); render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    const recognition = SpeechRecognitionMock.instances.at(-1)!;
    act(() => recognition.result(['已确认', true], ['未确认', false]));
    fireEvent.click(screen.getByRole('button', { name: '停止录音' }));
    act(() => vi.advanceTimersByTime(5000));
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('结束超时');
    expect(screen.getByLabelText('草稿')).toHaveProperty('value', '原有草稿\n已确认');
  });
});
