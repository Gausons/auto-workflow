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
  const [name, setName] = useState('我的开发机');
  const [workspace, setWorkspace] = useState('/absolute/path/to/repository');
  const [execute, setExecute] = useState(true);
  const [copied, setCopied] = useState(false);
  let config = '', error = '';
  try {
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('请输入工作台访问地址，不含路径、账号或查询参数');
    if (!name.trim() || !workspace.trim()) throw new Error('请填写设备名称和本机项目绝对路径');
    config = Object.entries({ WORKBENCH_URL: address.origin, WORKBENCH_USERNAME: username || '填写用户名', WORKBENCH_PASSWORD: '在本机填写密码', WORKBENCH_DEVICE_NAME: name.trim(), CODEX_WORKSPACE_DIR: workspace.trim(), IDE_HISTORY_SCOPE: 'workspace', WORKBENCH_EXECUTE_CODEX: String(execute) }).map(([key, value]) => `${key}=${envValue(value)}`).join('\n');
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  return <article className={styles.guide}>
    <h2>连接本机 Agent</h2>
    <p>浏览器通过工作台控制开发机。开发机主动连接服务端，无需开放入站端口；请保持开机、联网和连接器运行。</p>
    <label>工作台访问地址<input value={url} onChange={event => { setUrl(event.target.value); setCopied(false); }} /></label>
    {/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(url) && <p className="tc-callout">当前地址仅指向连接器所在机器。跨设备使用时，请改为开发机能够访问的工作台 HTTPS 地址。</p>}
    <label>设备名称<input maxLength={120} value={name} onChange={event => { setName(event.target.value); setCopied(false); }} /></label>
    <label>本机项目绝对路径<input maxLength={2000} value={workspace} onChange={event => { setWorkspace(event.target.value); setCopied(false); }} /></label>
    <label className="tc-check"><input type="checkbox" checked={execute} onChange={event => { setExecute(event.target.checked); setCopied(false); }} />允许网页启动 Agent、发送消息和处理审批</label>
    <ol><li>在开发机准备本项目、Node.js 22.16+、pnpm 及已登录的 Agent，运行 <code>pnpm install</code>。</li>
      <li>将下面配置保存为项目根目录的 <code>.env.device</code>，在本机填写账号密码。该文件已被 Git 忽略，请仅允许当前用户读取。</li>
      <li>运行 <code>pnpm device:connect</code>，回到本页等待设备上线。</li>
      <li>在“新建任务”选择该设备执行；在历史会话中打开受支持的 Codex 会话，可直接发送消息、审批或停止。</li></ol>
    {error ? <p role="alert">{error}</p> : <><textarea className={styles.config} aria-label="设备连接配置" readOnly rows={9} value={config} />
      <button className="button secondary" type="button" onClick={() => { void navigator.clipboard.writeText(config).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制配置' : '复制配置'}</button></>}
    <p className="tc-meta">配置不会包含当前浏览器令牌。默认仅同步项目内历史的元数据；远端执行的消息和输出会保存在工作台。仅同步模式也可通过 <code>pnpm device:sync</code> 配合环境变量运行。</p>
  </article>;
}
