// The browser API is not included in TypeScript's DOM declarations yet.
export interface SpeechResult {
  isFinal: boolean;
  readonly [index: number]: { transcript: string };
}

export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function speechRecognitionConstructor() {
  const browser = window as Window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
}

export function speechErrorMessage(error: string) {
  const messages: Record<string, string> = {
    'not-allowed': '麦克风或语音识别权限被拒绝，请在浏览器网站设置中允许后重试。',
    'service-not-allowed': '浏览器不允许使用语音识别服务，请检查浏览器设置。',
    'audio-capture': '无法使用麦克风，请检查设备连接及系统麦克风权限。',
    'network': '语音识别服务连接失败，请检查网络后重试。',
    'no-speech': '未识别到语音，请重试并靠近麦克风说话。',
    'language-not-supported': '当前浏览器的识别服务不支持中文。',
    'aborted': '语音识别已中断，可重新开始。'
  };
  return messages[error] || '语音识别失败，请重试或使用键盘输入。';
}
