/* HTTP/message/fetch routes for Rift Survival Local Play. */
'use strict';
(() => {
  const S=self.RiftSurvivalLocal;
  const bootstrap=state=>({ok:true,authenticated:true,user:S.clone(state.user),character:S.clone(state.character),world:{id:S.WORLD_ID,url:'/world/rift-survival-terrain.json',foundation:'rift-landscape-v2',terrainFormat:'rift-terrain-v1',size:[640,640],negativeWorldY:true},localPlay:true});

  S.mockApi=async(request,url)=>{
    const method=request.method.toUpperCase(),path=url.pathname;let state=await S.load();
    if(method==='POST'&&path==='/api/__local/realtime/connect')return S.socketConnect(request,state);
    if(method==='POST'&&path==='/api/__local/realtime/message')return S.socketMessage(request,state);
    if(method==='POST'&&path==='/api/__local/realtime/close'){state.realtime.connected=false;await S.checkpoint(state,'disconnect');return S.json({ok:true})}
    if(method==='GET'&&path==='/api/integrity/challenge')return S.integrityChallenge(state);
    if(method==='POST'&&path==='/api/integrity/attest')return S.integrityAttest(request,state);
    if(method==='GET'&&path==='/api/bootstrap')return S.json(bootstrap(state));
    if(method==='GET'&&path==='/api/auth/me')return S.json({ok:true,authenticated:true,user:S.clone(state.user),localPlay:true});
    if(method==='POST'&&(path==='/api/auth/login'||path==='/api/auth/register')){const b=await S.readJson(request),name=String(b?.username||'').trim();if(name){state.user.username=name.slice(0,24);if(state.character.displayName==='LocalTester')state.character.displayName=state.user.username}state.user.lastActiveAt=S.now();state.session.expiresAt=S.now()+604800000;state=await S.persist(state);return S.json({ok:true,authenticated:true,user:S.clone(state.user),localPlay:true},path.endsWith('/register')?201:200)}
    if(method==='POST'&&path==='/api/auth/logout'){await S.checkpoint(state,'logout');state.realtime.connected=false;return S.json({ok:true,localPlay:true})}
    if(method==='GET'&&path==='/api/character')return S.json({ok:true,character:S.clone(state.character),localPlay:true});
    if(method==='PATCH'&&path==='/api/character'){const b=await S.readJson(request),name=String(b?.displayName||'').trim();if(!/^[A-Za-z0-9][A-Za-z0-9 '\-]{1,23}$/.test(name))return S.json({ok:false,error:'Character name must be 2-24 characters.'},400);state.character.displayName=name;state.character.updatedAt=S.now();state=await S.persist(state);return S.json({ok:true,character:S.clone(state.character),localPlay:true})}
    if(method==='PUT'&&path==='/api/character/position')return S.moveRoute(request,state);
    if(method==='POST'&&path==='/api/realtime/checkpoint')return S.checkpointRoute(request,state);
    if(method==='GET'&&path==='/api/realtime/nearby')return S.nearbyRoute(request,state);
    if(method==='GET'&&path==='/api/anticheat/session-status')return S.antiCheatRoute(request,state);
    if(method==='GET'&&path==='/api/health')return S.json({ok:true,service:'rift-survival-core',database:'browser-cache',localPlay:true});
    if(method==='GET'&&path==='/api/local-play/state')return S.json({ok:true,state:S.clone(state),localPlay:true});
    if(method==='POST'&&path==='/api/local-play/reset'){await caches.delete(S.STATE_CACHE);S.runtimeState=S.freshState();state=await S.persist(S.runtimeState);return S.json({ok:true,state:S.clone(state),localPlay:true})}
    return S.json({ok:false,error:'RIFT_SURVIVAL_LOCAL_ROUTE_NOT_SIMULATED',message:`Rift Survival Local Play does not simulate ${method} ${path}.`,localPlay:true},404);
  };

  self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
  self.addEventListener('message',event=>{
    const type=event.data?.type,port=event.ports?.[0];
    if(type==='RIFT_SURVIVAL_LOCAL_RESET_STATE'||type==='IRONVALE_LOCAL_RESET_STATE'){event.waitUntil((async()=>{await caches.delete(S.STATE_CACHE);S.runtimeState=S.freshState();const state=await S.persist(S.runtimeState);try{port?.postMessage({ok:true,state:S.clone(state)})}catch{}})());return}
    if(type==='RIFT_SURVIVAL_LOCAL_EXPORT_STATE'||type==='IRONVALE_LOCAL_EXPORT_STATE'){event.waitUntil((async()=>{const state=await S.load();await S.checkpoint(state,'export');try{port?.postMessage({ok:true,state:S.clone(state)})}catch{}})());return}
    if(type==='RIFT_SURVIVAL_LOCAL_IMPORT_STATE'||type==='IRONVALE_LOCAL_IMPORT_STATE'){event.waitUntil((async()=>{try{const state=await S.persist(event.data?.payload);port?.postMessage({ok:true,state:S.clone(state)})}catch(error){try{port?.postMessage({ok:false,error:String(error?.message||error)})}catch{}}})())}
  });
  self.addEventListener('fetch',event=>event.respondWith((async()=>{
    const url=new URL(event.request.url),client=event.clientId?await self.clients.get(event.clientId):null,controlled=client?new URL(client.url).pathname.startsWith(S.PREFIX):false,direct=url.origin===self.location.origin&&url.pathname.startsWith(S.PREFIX);
    if(!controlled&&!direct)return fetch(event.request);if(url.origin!==self.location.origin)return fetch(event.request);
    if(url.pathname.startsWith('/api/'))return S.mockApi(event.request,url);
    if(url.pathname==='/rift-survival-integrity-manifest.json'){const m=await S.manifest();return new Response(JSON.stringify(m,null,2)+'\n',{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Rift-Survival-Local-Manifest':'1'}})}
    if(event.request.mode==='navigate'&&!direct&&url.pathname==='/')return Response.redirect(self.location.origin+S.PREFIX+'index.html',302);
    const cached=await S.asset(url.pathname);if(cached)return cached;
    return new Response(`Rift Survival Local Play asset not found: ${url.pathname}`,{status:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  })()));
})();
