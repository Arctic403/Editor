/* Rift Survival Local Play large-world compatibility for island-v2. */
'use strict';
(() => {
  const S = self.RiftSurvivalLocal;
  if (!S) throw new Error('Rift Survival Local Play core must load before island-v2 compatibility.');

  const WORLD_SIZE = 5120;
  const WORLD_CENTER = WORLD_SIZE / 2;
  S.WORLD_SIZE = WORLD_SIZE;
  S.STATE_CACHE = 'rift-survival-local-play-state-v3';

  S.zoneAxis = value => Math.max(
    0,
    Math.min(
      Math.ceil(WORLD_SIZE / S.ZONE_SIZE) - 1,
      Math.floor(Math.max(0, Math.min(WORLD_SIZE - 1e-6, S.finite(value, 0))) / S.ZONE_SIZE)
    )
  );
  S.zoneId = (x, z) => `${S.WORLD_ID}:${S.zoneAxis(x)}:${S.zoneAxis(z)}`;
  S.scannedZones = (x, z, radius) => {
    const r = Math.max(1, Math.min(S.MAX_INTEREST_RADIUS, S.finite(radius, S.INTEREST_RADIUS)));
    const minX = S.zoneAxis(x - r), maxX = S.zoneAxis(x + r);
    const minZ = S.zoneAxis(z - r), maxZ = S.zoneAxis(z + r);
    return (maxX - minX + 1) * (maxZ - minZ + 1);
  };

  const previousFreshState = S.freshState;
  S.freshState = () => {
    const state = previousFreshState();
    const p = { x: WORLD_CENTER, y: .9, z: WORLD_CENTER, yaw: 0 };
    state.schemaVersion = 3;
    state.character.position = { ...p };
    Object.assign(state.realtime, { x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    state.realtime.zoneAuthority.zoneId = S.zoneId(p.x, p.z);
    return state;
  };

  const previousNormalize = S.normalize;
  S.normalize = input => {
    const previousVersion = Number(input?.schemaVersion) || 0;
    const state = previousNormalize(input);
    state.schemaVersion = 3;
    if (previousVersion > 0 && previousVersion < 3) {
      const p = state.character?.position || {};
      const legacyDefault = Math.abs(S.finite(p.x, 320) - 320) < 0.001 && Math.abs(S.finite(p.z, 320) - 320) < 0.001;
      if (legacyDefault) {
        state.character.position = { x: WORLD_CENTER, y: S.finite(p.y, .9), z: WORLD_CENTER, yaw: S.finite(p.yaw, 0) };
        Object.assign(state.realtime, state.character.position);
        state.realtime.zoneAuthority.zoneId = S.zoneId(WORLD_CENTER, WORLD_CENTER);
      }
    }
    return state;
  };

  S.validateMove = (state, p) => {
    const now = S.now();
    const x = S.finite(p?.x), y = S.finite(p?.y), z = S.finite(p?.z), yaw = S.finite(p?.yaw);
    if ([x, y, z, yaw].some(value => value === null)) return { ok: false, reason: 'non-finite-position' };
    if (x < 0 || x > WORLD_SIZE || z < 0 || z > WORLD_SIZE || Math.abs(y) > 10000) return { ok: false, reason: 'world-bounds' };
    const seq = Number.isFinite(Number(p?.seq)) ? Math.trunc(Number(p.seq)) : S.finite(state.realtime.seq, 0) + 1;
    if (seq <= S.finite(state.realtime.seq, 0)) return { ok: false, reason: 'stale-sequence' };
    const dt = Math.max(.1, Math.min(30, (now - S.finite(state.realtime.lastAcceptedAt, now)) / 1000));
    if (Math.hypot(x - state.realtime.x, z - state.realtime.z) > 12 * dt + 3.5) return { ok: false, reason: 'horizontal-speed' };
    if (Math.abs(y - state.realtime.y) > 60 * dt + 20) return { ok: false, reason: 'vertical-speed' };
    return { ok: true, now, x, y, z, yaw, seq, clientSentAt: S.finite(p?.clientSentAt) };
  };

  const previousMockApi = S.mockApi;
  S.mockApi = async (request, url) => {
    if (request.method.toUpperCase() === 'GET' && url.pathname === '/api/bootstrap') {
      const state = await S.load();
      return S.json({
        ok: true,
        authenticated: true,
        user: S.clone(state.user),
        character: S.clone(state.character),
        world: {
          id: S.WORLD_ID,
          url: '/world/rift-survival-terrain.json',
          foundation: 'rift-landscape-v3',
          terrainFormat: 'rift-terrain-v1',
          size: [WORLD_SIZE, WORLD_SIZE],
          negativeWorldY: true,
          generation: {
            id: 'island-v2',
            version: 2,
            seed: 4032026,
            waterLevel: 0,
            coastWidth: 90,
            landHeight: 22,
            hillHeight: 26,
            mountainHeight: 48,
            roughness: .82,
            autoMaterials: true
          }
        },
        localPlay: true
      });
    }
    return previousMockApi(request, url);
  };
})();
