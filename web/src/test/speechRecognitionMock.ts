import { vi } from 'vitest';
import type { BrowserSpeechRecognition, SpeechResult } from '../components/speechRecognition.js';

export class SpeechRecognitionMock implements BrowserSpeechRecognition {
  static instances: SpeechRecognitionMock[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: BrowserSpeechRecognition['onstart'] = null;
  onend: BrowserSpeechRecognition['onend'] = null;
  onerror: BrowserSpeechRecognition['onerror'] = null;
  onresult: BrowserSpeechRecognition['onresult'] = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  constructor() { SpeechRecognitionMock.instances.push(this); }
  result(...parts: Array<[string, boolean]>) {
    const results: SpeechResult[] = parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));
    this.onresult?.({ results });
  }
}

export function mockSpeechRecognition(prefixed = false) {
  SpeechRecognitionMock.instances = [];
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('SpeechRecognition', prefixed ? undefined : SpeechRecognitionMock);
  vi.stubGlobal('webkitSpeechRecognition', prefixed ? SpeechRecognitionMock : undefined);
}
