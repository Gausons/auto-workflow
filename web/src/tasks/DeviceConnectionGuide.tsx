import { useState } from 'react';
import styles from './DeviceConnectionGuide.module.css';

function envValue(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error('配置值不能包含换行');
  const quote = ["'", '"', '`'].find(item => !value.includes(item));
  if (!quote) throw new Error('配置值包含不支持的引号组合');
  return `${quote}${value}${quote}`;
}

export function DeviceConnectionGuide({ username = '' }: { username?: string }) {
  const [url, setUrl] = useState(location.origin);
  const [copied, setCopied] = useState(false);
  let config = '', error = '';
  try {
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('请输入工作台访问地址，不含路径、账号或查询参数');
    config = Object.entries({ WORKBENCH_URL: address.origin, WORKBENCH_USERNAME: username || '填写用户名', WORKBENCH_PASSWORD: '在本机填写密码' }).map(([key, value]) => `${key}=${envValue(value)}`).join('\n');
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  return <article className={styles.guide}>
    <h2>连接本机 Agent</h2>
    <p>浏览器通过工作台控制开发机。开发机主动连接服务端，无需开放入站端口；请保持开机、联网和连接器运行。</p>
    <label>工作台访问地址<input value={url} onChange={event => { setUrl(event.target.value); setCopied(false); }} /></label>
    {/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(url) && <p className="tc-callout">当前地址仅指向连接器所在机器。跨设备使用时，请改为开发机能够访问的工作台 HTTPS 地址。</p>}
    <ol><li>在开发机准备 Node.js 22.16+ 及已登录的 Agent。安装已发布的连接器：<code>npm install -g agent-workbench-connector</code>，无需下载工作台源码。若尚未发布到 npm，可安装管理员提供的 tgz 包。</li>
      <li>将下面配置保存为 <code>agent.env</code>，在本机填写账号密码，并将文件权限限制为当前用户可读。</li>
      <li>运行 <code>agent-workbench-connector --env-file ./agent.env</code>，回到本页等待设备上线。</li>
      <li>在“新建任务”选择该设备执行；在历史会话中打开受支持的 Codex 会话，可直接发送消息、审批或停止。</li></ol>
    {error ? <p role="alert">{error}</p> : <><textarea className={styles.config} aria-label="设备连接配置" readOnly rows={4} value={config} />
      <button className="button secondary" type="button" onClick={() => { void navigator.clipboard.writeText(config).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制配置' : '复制配置'}</button></>}
    <p className="tc-meta">配置不会包含当前浏览器令牌。默认使用当前用户主目录、同步全部历史摘要并允许远程执行；每个工作台和账号使用独立状态目录。可通过环境变量收紧范围或关闭相应能力。</p>
  </article>;
}
