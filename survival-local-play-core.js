/* Shared state + asset layer for Rift Survival Local Play. */
'use strict';
(() => {
  const S = self.RiftSurvivalLocal = self.RiftSurvivalLocal || {};
  Object.assign(S, {
    CACHE_NAME: 'ironvale-local-play-preview-v1', // legacy adapter cache; safe to rename after adapter removal
    STATE_CACHE: 'rift-survival-local-play-state-v2',
    PREFIX: (() => { const p = new URL(self.registration.scope).pathname; return p.endsWith('/') ? p : p + '/'; })(),
    WORLD_ID: 'rift-survival-terrain',
    REALTIME_FORMAT: 'rift-survival-realtime-authority-v2',
    ZONE_FORMAT: 'rift-survival-zone-authority-v1',
    NEARBY_FORMAT: 'rift-survival-zone-nearby-v1',
    ANTICHEAT_FORMAT: 'rift-survival-anticheat-v1',
    MANIFEST_FORMAT: 'rift-survival-integrity-manifest-v1',
    CHECKPOINT_MS: 300000,
    ZONE_SIZE: 128,
    ZONE_TTL: 45000,
    ZONE_SYNC_MS: 10000,
    HEARTBEAT_MS: 15000,
    INTEREST_RADIUS: 96,
    MAX_INTEREST_RADIUS: 192,
    MAX_NEARBY: 64,
    CHALLENGE_TTL: 120000,
    TICKET_TTL: 3600000
  });
  S.json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Rift-Survival-Local-Play': '1' } });
  S.clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  S.now = () => Date.now();
  S.finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  S.token = (prefix = 'local') => { const bytes = crypto.getRandomValues(new Uint8Array(18)); return prefix + '-' + [...bytes].map(v => v.toString(16).padStart(2, '0')).join(''); };
  S.zoneAxis = value => Math.max(0, Math.min(4, Math.floor(Math.max(0, Math.min(639.999999, S.finite(value, 0))) / S.ZONE_SIZE)));
  S.zoneId = (x, z) => `${S.WORLD_ID}:${S.zoneAxis(x)}:${S.zoneAxis(z)}`;
  S.scannedZones = (x, z, radius) => { const r = Math.max(1, Math.min(S.MAX_INTEREST_RADIUS, S.finite(radius, S.INTEREST_RADIUS))); const minX=S.zoneAxis(x-r),maxX=S.zoneAxis(x+r),minZ=S.zoneAxis(z-r),maxZ=S.zoneAxis(z+r); return (maxX-minX+1)*(maxZ-minZ+1); };

  S.freshState = () => {
    const t=S.now(), p={x:320,y:.9,z:320,yaw:0};
    return {
      schemaVersion:2,
      user:{id:'rift-survival-local-user',username:'LocalTester',role:'admin',createdAt:t,lastActiveAt:t},
      session:{id:'rift-survival-local-session',expiresAt:t+604800000},
      character:{userId:'rift-survival-local-user',displayName:'LocalTester',position:p,createdAt:t,updatedAt:t},
      integrity:{status:'missing',challenge:null,challengeProof:null,challengeExpiresAt:0,ticket:null,ticketExpiresAt:0,buildId:null,manifestDigest:null,fileCount:0},
      realtime:{format:S.REALTIME_FORMAT,connected:false,x:p.x,y:p.y,z:p.z,yaw:p.yaw,seq:0,connectedAt:0,lastAcceptedAt:t,lastCheckpointAt:t,dirty:false,accepted:0,rejected:0,checkpointCount:0,samples:0,deterministicRejects:0,lastRejectReason:null,zoneAuthority:{format:S.ZONE_FORMAT,zoneId:S.zoneId(p.x,p.z),lastSyncAt:t,syncCount:0,handoffCount:0,nearbyReads:0,lastError:null}},
      createdAt:t,updatedAt:t
    };
  };
  S.normalize = input => {
    const b=S.freshState(); if(!input||typeof input!=='object'||Array.isArray(input))return b; const s=S.clone(input);
    s.schemaVersion=2; s.user={...b.user,...(s.user||{}),id:b.user.id,role:'admin'}; s.session={...b.session,...(s.session||{}),id:b.session.id};
    if(S.finite(s.session.expiresAt,0)<=S.now())s.session.expiresAt=S.now()+604800000;
    s.character={...b.character,...(s.character||{}),userId:b.user.id}; s.character.position={...b.character.position,...(s.character.position||{})};
    s.integrity={...b.integrity,...(s.integrity||{})}; s.realtime={...b.realtime,...(s.realtime||{})}; s.realtime.zoneAuthority={...b.realtime.zoneAuthority,...(s.realtime.zoneAuthority||{})};
    s.createdAt=S.finite(s.createdAt,b.createdAt); s.updatedAt=S.now(); return s;
  };
  S.stateUrl = () => self.location.origin + S.PREFIX + '__state__/core.json';
  S.runtimeState = null;
  S.persist = async input => { S.runtimeState=S.normalize(input); const c=await caches.open(S.STATE_CACHE); await c.put(S.stateUrl(),new Response(JSON.stringify(S.runtimeState),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})); return S.runtimeState; };
  S.load = async () => { if(S.runtimeState)return S.runtimeState; const c=await caches.open(S.STATE_CACHE),r=await c.match(S.stateUrl()); if(!r){S.runtimeState=S.freshState();return S.persist(S.runtimeState)} try{S.runtimeState=S.normalize(await r.json())}catch{S.runtimeState=S.freshState()} return S.runtimeState; };
  S.readJson = async request => { try{return await request.clone().json()}catch{return {}} };

  S.bridgeScript = () => `<script id="rift-survival-local-authority-bridge">\n(() => {'use strict';const NativeWebSocket=window.WebSocket,nativeFetch=window.fetch.bind(window),PATH='/api/realtime/movement';function ce(c,r,w){try{return new CloseEvent('close',{code:c,reason:r,wasClean:w})}catch(_){const e=new Event('close');Object.defineProperties(e,{code:{value:c},reason:{value:r},wasClean:{value:w}});return e}}class LS extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;constructor(url){super();this.url=String(url||'');this.readyState=0;this.protocol='';this.extensions='';this.binaryType='blob';this.bufferedAmount=0;this.closed=false;this.q=Promise.resolve();queueMicrotask(()=>this.connect())}get CONNECTING(){return 0}get OPEN(){return 1}get CLOSING(){return 2}get CLOSED(){return 3}async post(path,body){const r=await nativeFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify(body||{})});let d={};try{d=await r.clone().json()}catch(_){}if(!r.ok)throw new Error(d?.error||('Local realtime HTTP '+r.status));return d}deliver(a){for(const m of Array.isArray(a)?a:[])this.dispatchEvent(new MessageEvent('message',{data:typeof m==='string'?m:JSON.stringify(m)}))}async connect(){try{const d=await this.post('/api/__local/realtime/connect',{url:this.url});if(this.closed)return;this.readyState=1;this.dispatchEvent(new Event('open'));this.deliver(d.messages)}catch(e){if(this.closed)return;this.dispatchEvent(new Event('error'));this.readyState=3;this.closed=true;this.dispatchEvent(ce(4401,String(e?.message||e).slice(0,120),false))}}send(data){if(this.readyState!==1)throw new DOMException('WebSocket is not open','InvalidStateError');const text=typeof data==='string'?data:String(data);this.q=this.q.then(async()=>{if(this.closed)return;try{const d=await this.post('/api/__local/realtime/message',{data:text});this.deliver(d.messages)}catch(_){this.dispatchEvent(new Event('error'))}})}close(code=1000,reason=''){if(this.readyState>1)return;this.readyState=2;this.closed=true;this.post('/api/__local/realtime/close',{code,reason:String(reason||'').slice(0,123)}).catch(()=>null).finally(()=>{this.readyState=3;this.dispatchEvent(ce(Number(code)||1000,String(reason||''),true))})}}function WS(url,protocols){let u;try{u=new URL(String(url),location.href)}catch(_){return protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols)}if(u.host===location.host&&u.pathname===PATH)return new LS(u.href);return protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols)}WS.CONNECTING=0;WS.OPEN=1;WS.CLOSING=2;WS.CLOSED=3;WS.prototype=NativeWebSocket.prototype;window.WebSocket=WS;window.__RIFT_SURVIVAL_LOCAL_PLAY__=true;})();\n<\/script>`;
  S.asset = async pathname => {
    let rel=pathname.startsWith(S.PREFIX)?pathname.slice(S.PREFIX.length):pathname.replace(/^\/+/, ''); if(!rel||rel.endsWith('/'))rel+='index.html'; const c=await caches.open(S.CACHE_NAME); let r=await c.match(self.location.origin+S.PREFIX+rel); if(!r&&!rel.includes('.'))r=await c.match(self.location.origin+S.PREFIX+'index.html'); if(!r)return null; if(rel!=='index.html')return r;
    let html=await r.text(); html=html.replace('window.__IRONVALE_LOCAL_PLAY__=true;','window.__IRONVALE_LOCAL_PLAY__=true;window.__RIFT_SURVIVAL_LOCAL_PLAY__=true;').replace('IRONVALE · LOCAL PLAY','SURVIVAL · LOCAL PLAY'); if(!html.includes('rift-survival-local-authority-bridge'))html=/<head[^>]*>/i.test(html)?html.replace(/<head([^>]*)>/i,`<head$1>${S.bridgeScript()}`):S.bridgeScript()+html; return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
  };
  S.manifest = async () => {
    const names=['app.js','index.html','rift-architecture-guard.js','rift-auto-validation-ui-hotfix.js','rift-auto-validation.js','rift-character.js','rift-core.js','rift-core.wasm.gz','rift-diagnostic-hooks.js','rift-diagnostics.js','rift-engine.js','rift-geometry-guard.js','rift-gl-tripwire.js','rift-history-bridge.js','rift-integrity.js','rift-landscape.js','rift-realtime.js','rift-scale.js','rift-terrain-materials.js','rift-terrain.js','rift-validator-guard.js'].sort(),files=[];
    for(const rel of names){const r=await S.asset('/'+rel);if(!r)throw new Error('Integrity critical preview file missing: '+rel);const bytes=new Uint8Array(await r.arrayBuffer()),d=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));files.push({path:'/'+rel,sha256:[...d].map(v=>v.toString(16).padStart(2,'0')).join(''),size:bytes.byteLength})}
    const canonical={format:S.MANIFEST_FORMAT,algorithm:'SHA-256',files},raw=new TextEncoder().encode(JSON.stringify(canonical)),d=new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),digest=[...d].map(v=>v.toString(16).padStart(2,'0')).join('');return {...canonical,buildId:'rs-'+digest.slice(0,24),digest,fileCount:files.length};
  };
})();
