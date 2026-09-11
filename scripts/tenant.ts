import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.js';
import { databasePath, generateToken, loadEnvironment, provisionDefaultTenant } from '../src/tenancy.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = loadEnvironment(rootDir);
const database = openDatabase(databasePath(rootDir, environment));
try {
  const [command, id, ...nameParts] = process.argv.slice(2);
  if (command === 'list') {
    console.table(database.listTenants());
  } else if (command === 'add' && id) {
    const token = generateToken();
    database.createTenant({ id, name: nameParts.join(' ') || id, token });
    console.log(`租户：${id}\n组织初始化令牌（仅显示一次）：${token}\n凭据文件：${path.resolve(rootDir, environment.TENANT_ENV_DIR || '.workflow-data/tenants', `${id}.env`)}\n配置凭据及独立 CODEX_WORKSPACE_DIR 后重启服务。`);
  } else if (command === 'rotate' && id) {
    const token = generateToken();
    database.rotateToken(id, token);
    console.log(`租户：${id}\n新组织初始化令牌（旧令牌立即失效；已初始化组织不能再次使用令牌登录）：${token}`);
  } else if (command === 'migrate') {
    provisionDefaultTenant(database, rootDir, environment);
    console.log(database.importLegacy(rootDir, id || 'default'));
  } else if (command === 'users' && id) {
    console.table(database.listUsers(id));
  } else if (command === 'reset-password' && id && nameParts[0]) {
    const members = database.listUsers(id);
    const target = members.find((member: any) => member.username === nameParts[0].trim().toLowerCase());
    const owner = members.find((member: any) => member.role === 'owner' && member.enabled);
    if (!target || !owner) throw new Error('成员不存在或组织尚未初始化');
    const password = generateToken();
    await database.resetPassword(id, target.id, password, owner);
    database.audit(id, null, 'local.password_recovery', target.id);
    console.log(`组织：${id}\n用户名：${target.username}\n新密码（仅显示一次）：${password}\n该用户的所有会话已撤销。`);
  } else {
    throw new Error('用法：npm run tenant -- list | add <id> [名称] | rotate <id> | migrate [id] | users <id> | reset-password <id> <用户名>');
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
} finally { database.close(); }
