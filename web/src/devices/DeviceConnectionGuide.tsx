import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { deviceDeploymentCommand } from '../../../shared/deviceDeployment.js';
import { apiRequest } from '../api/client.js';
import styles from './DeviceConnectionGuide.module.css';

export function DeviceConnectionGuide({ username = '' }: { username?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const deployment = useMutation({
    mutationFn: async () => {
      const result = await apiRequest<{ deploymentToken: string; expiresAt: number }>('/api/auth/device-deployment', { method: 'POST', body: '{}' });
      return { command: deviceDeploymentCommand({ ...result, url: location.origin }), expiresAt: result.expiresAt };
    },
    retry: false,
    onMutate: () => { setCopied(false); setCopyError(false); },
    onSuccess: async result => { setNow(Date.now()); if (result.expiresAt > Date.now()) await copy(result.command); }
  });
  useEffect(() => {
    if (!deployment.data) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deployment.data]);
  async function copy(command: string) {
    setCopyError(false);
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setCopied(false); setCopyError(true); }
  }
  const expiresAt = deployment.data?.expiresAt ?? 0;
  const expired = !!deployment.data && expiresAt <= now;
  const command = deployment.isSuccess && !expired ? deployment.data.command : '';
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return <article className={styles.guide}>
    <div className={styles.heading}><span className={styles.badge}>一键部署</span><h2>连接本机 Agent</h2></div>
    <p>生成命令，在开发机终端粘贴运行。自动安装连接器并连接当前账号，无需输入密码或创建配置文件。</p>
    <div className={styles.steps}><span>① 生成并复制命令</span><span>② 终端粘贴运行</span><span>③ 设备上线</span></div>
    <button className="button primary" type="button" disabled={deployment.isPending} onClick={() => deployment.mutate()}>{deployment.isPending ? '正在生成临时令牌…' : deployment.data ? '重新生成部署命令' : '生成并复制部署命令'}</button>
    {deployment.isError && <p role="alert">生成失败：{deployment.error.message}。请重试；此前的命令可能已失效。</p>}
    {command && <>
      <textarea className={styles.command} aria-label="一键部署命令" readOnly rows={3} value={command} />
      <button className="button secondary" type="button" onClick={() => void copy(command)}>{copied ? '已复制，再次复制' : '复制部署命令'}</button>
      <p className={styles.status} role="status">{copied ? '命令已复制，尚未部署。' : '命令已生成。'}请在 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒内运行，仅可使用一次；本页会自动更新设备状态。</p>
    </>}
    {expired && <p role="status">部署命令已过期，请重新生成。</p>}
    {copyError && command && <p role="alert">自动复制失败，请点击“复制部署命令”或选中上方命令手动复制。</p>}
    <p className="tc-meta">适用于 macOS、Linux 和 Windows PowerShell。需已安装 Node.js 22.16+ 及已登录的 Agent。设备上线后自动转入后台，可关闭终端。</p>
    <details className={styles.details}><summary>连接选项与使用说明</summary>
      <p>工作台：{location.origin} · 连接账号：{username || '当前账号'}。</p>
      <p>临时令牌有效期最长 10 分钟，重新生成会使旧命令失效。命令含一次性接入凭据，请勿分享；不会包含浏览器登录令牌，Google 账号也可直接接入。</p>
      <p>兑换后的设备会话有效 24 小时，仅在后台进程内存中使用，不保存到文件。停止、过期或兑换失败后，请重新生成命令；不会自动重试兑换，也不会在重启电脑后自动启动。</p>
      <p>默认使用用户主目录，允许远程执行并同步历史摘要。终端会显示日志路径和停止命令；使用 <code>npx --yes agent-workbench-connector@latest --status</code> 查看状态，使用 <code>--stop 连接标识</code> 正常停止。旧版前台连接器请先按 Ctrl+C 退出。</p>
      <a href="/docs/devices" target="_blank" rel="noreferrer">查看高级配置与 Agent 安装说明 ↗</a>
    </details>
    {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && <p className="tc-callout">当前地址仅适用于本机。跨设备使用时，请先通过开发机能够访问的工作台 HTTPS 地址打开本页，再生成命令。</p>}
  </article>;
}
