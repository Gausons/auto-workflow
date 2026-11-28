import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import styles from './DevicesPage.module.css';

interface PersonalDevice { id: string; name: string; online: boolean; added: boolean; connected: boolean }
const endpoint = '/api/workspaces/devices';

export function PersonalDevicePicker() {
  const client = useQueryClient();
  const devices = useQuery({
    queryKey: ['workspace-devices'], queryFn: ({ signal }) => apiRequest<{ devices: PersonalDevice[] }>(endpoint, { signal })
  });
  const share = useMutation({
    mutationFn: (device: PersonalDevice) => apiRequest(endpoint, {
      method: device.added ? 'DELETE' : 'POST', body: JSON.stringify({ deviceId: device.id })
    }),
    retry: false,
    onSuccess: async () => {
      await Promise.all([['workspace-devices'], ['task-center', 'snapshot'], ['task-center', 'targets'], ['group-chat-targets'], ['history', 'targets']]
        .map(queryKey => client.invalidateQueries({ queryKey })));
    }
  });
  return <section className={styles.guide} id="personal-device-picker" aria-label="添加我的设备">
    <h2>个人空间的设备</h2>
    <p>添加后，有执行权限的团队成员可以使用这台设备上的 Agent 和项目。</p>
    {devices.isPending ? <p role="status">正在读取个人设备…</p> : devices.isError ? <p role="alert">{devices.error.message} <button className={styles.textButton} onClick={() => void devices.refetch()}>重试</button></p>
      : devices.data.devices.length ? <ul className={styles.personalDevices}>{devices.data.devices.map(device => <li key={device.id}>
        <span><strong>{device.name}</strong> · {device.online ? '在线' : '离线'}{device.added ? ' · 已添加' : ''}</span>
        {device.connected ? <span>已直接连接到团队</span> : <button className="button secondary" disabled={share.isPending} onClick={() => share.mutate(device)}
          aria-label={`${device.added ? '停止共享' : '添加'} ${device.name}`}>{device.added ? '停止共享' : '添加到团队'}</button>}
      </li>)}</ul> : <p>个人空间还没有可添加的设备。</p>}
    {share.isError && <p role="alert">{share.error.message}</p>}
  </section>;
}
