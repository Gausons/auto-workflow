// Experimental local IPC probe. This is not a supported public Codex API.
// Default: discovery only. --send-probe adds ONE fixed text-only test turn.
import os from 'node:os';import {join,dirname} from 'node:path';
import net from 'node:net';import {randomUUID} from 'node:crypto';import {lstatSync} from 'node:fs';
const threadId=process.argv[2], mode=process.argv[3];
if(!/^[a-f0-9-]{36}$/.test(threadId??'') || (mode && !['--send-probe','--read-probe'].includes(mode))) throw Error('Usage: node scripts/codex-ipc-probe.mjs THREAD_ID [--send-probe|--read-probe]');
const path=join(process.env.CODEX_HOME || join(os.homedir(),'.codex'),'ipc','ipc.sock');
const dir=lstatSync(dirname(path));if(!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o077))throw Error('Unsafe IPC directory');
const st=lstatSync(path);if(!st.isSocket()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('Unsafe socket');
const socket=net.connect(path);let buffer=Buffer.alloc(0),client='initializing-client';const pending=new Map();
function send(m){const b=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);socket.write(Buffer.concat([h,b]));}
function call(method,params,version,targetClientId){const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('timeout; do not retry submission'));},30000);pending.set(requestId,m=>{clearTimeout(timer);resolve(m)});send({type:'request',requestId,sourceClientId:client,method,params,version,targetClientId});});}
socket.on('error',()=>{});
socket.on('data',b=>{buffer=Buffer.concat([buffer,b]);while(buffer.length>=4){const n=buffer.readUInt32LE();if(n>16*1024*1024){socket.destroy();return;}if(buffer.length<n+4)return;const m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);if(m.type==='response'){pending.get(m.requestId)?.(m);pending.delete(m.requestId);}if(m.type==='client-discovery-request')send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});}});
try{await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j)});const init=await call('initialize',{clientType:'auto-workflow-diagnostic'},0);client=init.result.clientId;
const owner=await call('thread-owner-discovery',{hostId:'local',conversationId:threadId},1);console.log('discovery',JSON.stringify(owner));if(owner.resultType!=='success')throw Error('No owner');
if(mode==='--read-probe'){const result=await call('thread-follower-load-complete-history',{conversationId:threadId},1,owner.handledByClientId);console.log('history',JSON.stringify({resultType:result.resultType,error:result.error,result:result.result}));}
if(mode==='--send-probe'){const messageId=randomUUID();console.log('messageId',messageId);const result=await call('thread-follower-start-turn',{conversationId:threadId,turnStart:{request:{threadId,input:[{type:'text',text:'这是用户授权的网页后端 IPC 接续验证。请只回复“IPC 接续验证成功”，不要使用工具或修改文件。',text_elements:[]}],clientUserMessageId:messageId},context:{inheritThreadSettings:true}}},2,owner.handledByClientId);console.log('submission',JSON.stringify(result));}
}finally{socket.destroy();}
