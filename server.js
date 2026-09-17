#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const SAVE_FILE = process.env.SAVE_FILE || path.join(DATA_DIR, "server-saves.json");
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const MAX_FRAME_PAYLOAD = 16 * 1024;
const MAX_BUFFERED_BYTES = 128 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 50;
const CHAT_LIMIT_WINDOW_MS = 4000;
const CHAT_LIMIT_MAX = 4;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const SAVE_WRITE_DEBOUNCE_MS = 3000;
const MAX_SPEED_PX_PER_S = 520;
const PVP_RANGE = 90;
const PVP_COOLDOWN_MS = 450;
const VALID_REGIONS = new Set([
  "region_village", "region_forest", "region_mines", "region_swamp",
  "region_desert", "region_mountain", "region_ruins", "region_kingdom",
  "region_corrupted", "region_nexus"
]);
const VALID_CLASSES = new Set(["warrior", "mage", "rogue", "paladin"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip"
};

function loadSaves() {
  try { return JSON.parse(fs.readFileSync(SAVE_FILE, "utf8")); }
  catch { return {}; }
}

let saveWriteTimer = null;
let saveWritePending = false;
let saves = loadSaves();
const clients = new Map();

function scheduleSaveWrite() {
  saveWritePending = true;
  if (saveWriteTimer) return;
  saveWriteTimer = setTimeout(flushSaves, SAVE_WRITE_DEBOUNCE_MS);
}

async function flushSaves() {
  saveWriteTimer = null;
  if (!saveWritePending) return;
  saveWritePending = false;
  const tmpFile = SAVE_FILE + ".tmp";
  try {
    await fs.promises.writeFile(tmpFile, JSON.stringify(saves, null, 2));
    await fs.promises.rename(tmpFile, SAVE_FILE);
  } catch (err) {
    console.error("No se pudo guardar server-saves.json:", err.message);
  }
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sanitizeName(name) {
  return String(name || "Aventurero").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 18) || "Aventurero";
}

function sanitizeChat(text) {
  return String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

function validRegion(id) {
  return VALID_REGIONS.has(id) ? id : "region_village";
}

function starterStats(cls) {
  return {
    level: 1, exp: 0, gold: 50, hp: 220, maxHp: 220, mana: 80, maxMana: 80,
    characterClass: VALID_CLASSES.has(cls) ? cls : "warrior"
  };
}

function publicState(player) {
  if (!player) return null;
  return {
    id: player.id,
    name: sanitizeName(player.name),
    characterClass: VALID_CLASSES.has(player.characterClass) ? player.characterClass : "warrior",
    level: clampNum(player.level, 1, 80),
    hp: clampNum(player.hp, 0, 20000),
    maxHp: clampNum(player.maxHp, 1, 20000),
    x: clampNum(player.x, 40, 4000),
    y: clampNum(player.y, 40, 3200),
    direction: player.direction || "down",
    regionId: validRegion(player.regionId),
    dungeonId: player.dungeonId || null,
    isAttacking: !!player.isAttacking,
    pvpEnabled: player.pvpEnabled !== false,
    color: player.color || "#3b82f6"
  };
}

function persistFromPlayer(player) {
  if (!player || !player.id) return;
  const prev = saves[player.id] || {};
  saves[player.id] = {
    id: player.id,
    name: player.name,
    characterClass: player.characterClass,
    level: player.level,
    exp: player.exp || prev.exp || 0,
    gold: player.gold,
    hp: player.hp,
    maxHp: player.maxHp,
    mana: player.mana,
    maxMana: player.maxMana,
    x: player.x,
    y: player.y,
    regionId: player.regionId,
    dungeonId: player.dungeonId || null,
    updatedAt: Date.now()
  };
  scheduleSaveWrite();
}

function sameInstance(a, b) {
  if (!a || !b) return false;
  return a.regionId === b.regionId && (a.dungeonId || null) === (b.dungeonId || null);
}

function send(client, msg) {
  if (client && client.ws && client.ws.readyState === "open") client.ws.sendText(JSON.stringify(msg));
}

function regionBroadcast(msg, player, exceptId) {
  if (!player) return;
  const data = JSON.stringify(msg);
  for (const [id, client] of clients) {
    if (exceptId && id === exceptId) continue;
    if (!client.player || !sameInstance(client.player, player)) continue;
    if (client.ws.readyState === "open") client.ws.sendText(data);
  }
}

function onlineInInstance(player) {
  return Array.from(clients.values())
    .filter((c) => c.player && sameInstance(c.player, player))
    .map((c) => publicState(c.player))
    .filter(Boolean);
}

function findClientByPlayerId(playerId) {
  for (const client of clients.values()) {
    if (client.player && client.player.id === playerId) return client;
  }
  return null;
}

function decodeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 15;
  const masked = (buffer[1] & 128) !== 0;
  let len = buffer[1] & 127;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    if (buffer.readUInt32BE(2) !== 0) return { close: true };
    len = buffer.readUInt32BE(6);
    offset = 10;
  }
  if (len > MAX_FRAME_PAYLOAD) return { close: true };
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + len) return null;
  let payload = buffer.slice(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, leftover: buffer.slice(offset + maskLen + len) };
}

function encodeWsText(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}

function attachWs(socket) {
  return {
    socket,
    readyState: "open",
    buffer: Buffer.alloc(0),
    sendText(text) {
      if (this.readyState !== "open") return;
      try { this.socket.write(encodeWsText(text)); } catch {}
    },
    close() {
      this.readyState = "closed";
      try { this.socket.end(); } catch {}
    }
  };
}

function checkRateLimit(client) {
  const now = Date.now();
  if (!client.rate || now - client.rate.windowStart > RATE_LIMIT_WINDOW_MS) client.rate = { windowStart: now, count: 0 };
  client.rate.count++;
  return client.rate.count <= RATE_LIMIT_MAX_MESSAGES;
}

function checkChatLimit(client) {
  const now = Date.now();
  if (!client.chatRate || now - client.chatRate.windowStart > CHAT_LIMIT_WINDOW_MS) client.chatRate = { windowStart: now, count: 0 };
  client.chatRate.count++;
  return client.chatRate.count <= CHAT_LIMIT_MAX;
}

function evictDuplicateSession(playerId, currentId) {
  for (const [otherId, other] of clients) {
    if (otherId !== currentId && other.player && other.player.id === playerId) {
      send(other, { type: "SESSION_REPLACED" });
      other.ws.close();
      clients.delete(otherId);
    }
  }
}

function applyMovement(client, payload) {
  const now = Date.now();
  const prev = client.player;
  if (!prev) return null;
  const nextRegion = validRegion(payload.regionId || prev.regionId);
  const nextDungeon = payload.dungeonId === undefined ? prev.dungeonId : (payload.dungeonId || null);
  const changedArea = nextRegion !== prev.regionId || (nextDungeon || null) !== (prev.dungeonId || null);
  let x = clampNum(payload.x, 40, 4000);
  let y = clampNum(payload.y, 40, 3200);
  let corrected = false;
  if (!changedArea && client.lastKnownAt) {
    const dt = Math.max(0.05, Math.min(1.2, (now - client.lastKnownAt) / 1000));
    const dist = Math.hypot(x - prev.x, y - prev.y);
    const maxDist = MAX_SPEED_PX_PER_S * dt;
    if (dist > maxDist) {
      const ratio = maxDist / dist;
      x = prev.x + (x - prev.x) * ratio;
      y = prev.y + (y - prev.y) * ratio;
      corrected = true;
    }
  }
  client.player = Object.assign({}, prev, {
    x, y,
    direction: payload.direction || prev.direction,
    regionId: nextRegion,
    dungeonId: nextDungeon,
    isAttacking: !!payload.isAttacking,
    name: payload.name ? sanitizeName(payload.name) : prev.name
  });
  client.lastKnownAt = now;
  if (changedArea) persistFromPlayer(client.player);
  if (corrected) send(client, { type: "STATE_CORRECTION", payload: publicState(client.player) });
  return client.player;
}

function handleAttackPlayer(client, payload) {
  const attacker = client.player;
  if (!attacker || !payload || !payload.targetId) return;
  if (payload.targetId === attacker.id || attacker.hp <= 0) return;
  const now = Date.now();
  if (client.lastPvpAt && now - client.lastPvpAt < PVP_COOLDOWN_MS) return;
  const targetClient = findClientByPlayerId(payload.targetId);
  if (!targetClient || !targetClient.player) return;
  const target = targetClient.player;
  if (!sameInstance(attacker, target)) return;
  if (Math.hypot(attacker.x - target.x, attacker.y - target.y) > PVP_RANGE) return;
  client.lastPvpAt = now;
  const dmg = Math.max(8, Math.floor(12 + attacker.level * 3));
  target.hp = Math.max(0, target.hp - dmg);
  client.player.isAttacking = true;
  regionBroadcast({
    type: "PVP_HIT",
    payload: { attackerId: attacker.id, targetId: target.id, damage: dmg, hp: target.hp, maxHp: target.maxHp }
  }, attacker);
  send(targetClient, { type: "STATE_CORRECTION", payload: publicState(target) });
  if (target.hp <= 0) {
    target.hp = target.maxHp;
    target.regionId = "region_village";
    target.dungeonId = null;
    target.x = 600;
    target.y = 900;
    persistFromPlayer(target);
    send(targetClient, { type: "STATE_CORRECTION", payload: publicState(target) });
    regionBroadcast({ type: "PLAYER_LEAVE", payload: { id: target.id } }, attacker);
    regionBroadcast({ type: "PLAYER_JOIN", payload: publicState(target) }, target);
  } else {
    regionBroadcast({ type: "PLAYER_STATE", payload: publicState(target) }, target);
  }
  regionBroadcast({ type: "PLAYER_STATE", payload: publicState(client.player) }, client.player, client.id);
}

function handleMessage(clientId, raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  if (text.length > MAX_FRAME_PAYLOAD) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const client = clients.get(clientId);
  if (!client || !msg || typeof msg.type !== "string") return;
  client.lastSeen = Date.now();
  if (!checkRateLimit(client)) return;

  if (msg.type === "HELLO") {
    const incoming = msg.payload || {};
    const id = String(incoming.id || "").slice(0, 80);
    if (!id) return;
    const saved = saves[id];
    const base = starterStats(incoming.characterClass);
    const player = publicState({
      id,
      name: incoming.name,
      characterClass: incoming.characterClass,
      x: incoming.x,
      y: incoming.y,
      direction: incoming.direction,
      regionId: incoming.regionId,
      dungeonId: incoming.dungeonId,
      color: incoming.color,
      level: saved ? saved.level : base.level,
      hp: saved ? saved.hp : base.hp,
      maxHp: saved ? saved.maxHp : base.maxHp,
      gold: saved ? saved.gold : base.gold
    });
    player.gold = saved ? clampNum(saved.gold, 0, 5e6) : base.gold;
    player.exp = saved ? clampNum(saved.exp, 0, 1e9) : 0;
    player.mana = saved && saved.mana != null ? saved.mana : base.mana;
    player.maxMana = saved && saved.maxMana != null ? saved.maxMana : base.maxMana;
    player.pvpEnabled = true;
    evictDuplicateSession(id, clientId);
    client.player = player;
    client.lastKnownAt = Date.now();
    persistFromPlayer(player);
    send(client, {
      type: "WELCOME",
      payload: {
        serverTime: Date.now(),
        you: Object.assign(publicState(player), { gold: player.gold, exp: player.exp, mana: player.mana, maxMana: player.maxMana }),
        players: onlineInInstance(player).filter((p) => p.id !== id),
        saved: saves[id] || null,
        enemies: snapshotEnemies(player.regionId, player.dungeonId)
      }
    });
    regionBroadcast({ type: "PLAYER_JOIN", payload: publicState(player) }, player, clientId);
    regionBroadcast({
      type: "CHAT_MESSAGE",
      payload: { id: "sys_" + Date.now(), sender: "Sistema", text: player.name + " ha llegado.", channel: "system", timestamp: Date.now() }
    }, player);
    return;
  }

  if (!client.player) return;

  if (msg.type === "PLAYER_STATE" || msg.type === "MOVE") {
    const prevRegion = client.player.regionId;
    const prevDungeon = client.player.dungeonId || null;
    const moved = applyMovement(client, msg.payload || {});
    if (!moved) return;
    const changedArea = moved.regionId !== prevRegion || (moved.dungeonId || null) !== prevDungeon;
    if (changedArea) {
      regionBroadcast({ type: "PLAYER_LEAVE", payload: { id: moved.id } }, { regionId: prevRegion, dungeonId: prevDungeon }, clientId);
      regionBroadcast({ type: "PLAYER_JOIN", payload: publicState(moved) }, moved, clientId);
      sendEnemySnapshot(client);
    } else {
      regionBroadcast({ type: "PLAYER_STATE", payload: Object.assign(publicState(moved), { t: Date.now() }) }, moved, clientId);
    }
    return;
  }

  if (msg.type === "CHAT_MESSAGE") {
    if (!checkChatLimit(client)) return;
    const chatText = sanitizeChat(msg.payload && msg.payload.text);
    if (!chatText) return;
    regionBroadcast({
      type: "CHAT_MESSAGE",
      payload: {
        id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
        sender: client.player.name,
        text: chatText,
        channel: "region",
        timestamp: Date.now()
      }
    }, client.player);
    return;
  }

  if (msg.type === "ATTACK_PLAYER" || msg.type === "PLAYER_ATTACK_PLAYER") {
    handleAttackPlayer(client, msg.payload || {});
    return;
  }

  if (msg.type === "ATTACK_ENEMY") {
    handleAttackEnemy(client, msg.payload || {});
    return;
  }

  if (msg.type === "SAVE_SNAPSHOT") {
    persistFromPlayer(client.player);
    return;
  }

  if (msg.type === "PING") {
    send(client, { type: "PONG", payload: { serverTime: Date.now(), clientTime: msg.payload && msg.payload.t } });
    return;
  }
}

function removeClient(id) {
  const client = clients.get(id);
  if (!client) return;
  clients.delete(id);
  if (client.player) {
    persistFromPlayer(client.player);
    regionBroadcast({ type: "PLAYER_LEAVE", payload: { id: client.player.id } }, client.player);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
  if (url.pathname === "/healthz") {
    res.writeHead(200, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "eldoria", players: clients.size, uptime: Math.floor(process.uptime()) }));
    return;
  }
  if (url.pathname === "/api/online") {
    res.writeHead(200, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      players: Array.from(clients.values()).map((c) => publicState(c.player)).filter(Boolean)
    }));
    return;
  }
  let filePath = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403, securityHeaders);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" });
      res.end("No encontrado");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === ".js" || ext === ".css" ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { ...securityHeaders, "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on("upgrade", (req, socket) => {
  if ((req.url || "").split("?")[0] !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const id = "sock_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const ws = attachWs(socket);
  clients.set(id, { id, ws, player: null, lastSeen: Date.now(), lastKnownAt: Date.now() });
  socket.on("data", (chunk) => {
    const client = clients.get(id);
    if (!client) return;
    client.ws.buffer = Buffer.concat([client.ws.buffer, chunk]);
    if (client.ws.buffer.length > MAX_BUFFERED_BYTES) {
      removeClient(id); client.ws.close(); return;
    }
    while (true) {
      const parsed = decodeWsFrame(client.ws.buffer);
      if (!parsed) break;
      client.lastSeen = Date.now();
      if (parsed.close) { removeClient(id); client.ws.close(); return; }
      client.ws.buffer = parsed.leftover;
      if (parsed.opcode === 8) {
        try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
        removeClient(id); client.ws.close(); return;
      }
      if (parsed.opcode === 9) {
        try { socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload])); } catch {}
        continue;
      }
      if (parsed.opcode === 10) continue;
      if (parsed.opcode === 1) handleMessage(id, parsed.payload.toString("utf8"));
    }
  });
  socket.on("close", () => removeClient(id));
  socket.on("error", () => removeClient(id));
});

setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (client.lastSeen && now - client.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      removeClient(id); client.ws.close(); continue;
    }
    try { client.ws.socket.write(Buffer.from([0x89, 0x00])); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}


const ENEMY_TICK_MS = 100;
const ENEMY_ATTACK_RANGE_PAD = 12;
const PLAYER_HIT_ENEMY_RANGE = 92;
const PLAYER_HIT_COOLDOWN_MS = 280;
const ENEMY_RESPAWN_MS = 10000;
const WORLD_ENEMY_COUNT = 16;
const DUNGEON_ENEMY_COUNT = 12;

const REGION_MAP = {
  region_village: { w: 2400, h: 1800, templates: ["training_dummy", "field_rat"], count: 12, boss: null },
  region_forest: { w: 2800, h: 2200, templates: ["forest_wolf", "shadow_spider", "forest_bandit"], count: WORLD_ENEMY_COUNT, boss: "boss_dire_alpha" },
  region_mines: { w: 3000, h: 2200, templates: ["crystal_bat", "stone_golem", "earth_elemental"], count: WORLD_ENEMY_COUNT, boss: "boss_crystal_colossus" },
  region_swamp: { w: 3000, h: 2200, templates: ["acid_slug", "marsh_serpent", "swamp_witch"], count: WORLD_ENEMY_COUNT, boss: "boss_hydra_spawn" },
  region_desert: { w: 3200, h: 2400, templates: ["giant_scorpion", "sand_nomad", "fire_drake"], count: WORLD_ENEMY_COUNT, boss: "boss_scorpoking" },
  region_mountain: { w: 3200, h: 2400, templates: ["frost_wolf", "ice_golem", "yeti_brute"], count: WORLD_ENEMY_COUNT, boss: "boss_frost_titan" },
  region_ruins: { w: 3200, h: 2400, templates: ["arcane_sentinel", "glyph_construct"], count: WORLD_ENEMY_COUNT, boss: "boss_chronos_guardian" },
  region_kingdom: { w: 3400, h: 2600, templates: ["fallen_knight", "spectral_sorcerer"], count: WORLD_ENEMY_COUNT, boss: "boss_spectral_king" },
  region_corrupted: { w: 3400, h: 2600, templates: ["void_crawler", "chaos_eye"], count: WORLD_ENEMY_COUNT, boss: "boss_void_harbinger" },
  region_nexus: { w: 3600, h: 2800, templates: ["nexus_champion"], count: WORLD_ENEMY_COUNT, boss: "boss_malakor_overlord" }
};

const DUNGEON_MAP = {
  dungeon_crypt: { w: 2200, h: 1600, templates: ["forest_wolf", "shadow_spider", "forest_bandit"], count: DUNGEON_ENEMY_COUNT, boss: "boss_crypt_necromancer", bx: 1850, by: 800 },
  dungeon_crystal: { w: 2600, h: 1800, templates: ["crystal_bat", "stone_golem"], count: DUNGEON_ENEMY_COUNT, boss: "boss_crystal_colossus", bx: 2200, by: 900 },
  dungeon_fire_temple: { w: 2800, h: 2000, templates: ["giant_scorpion", "sand_nomad"], count: DUNGEON_ENEMY_COUNT, boss: "boss_scorpoking", bx: 2400, by: 1000 },
  dungeon_kingdom_halls: { w: 3000, h: 2200, templates: ["fallen_knight", "spectral_sorcerer"], count: DUNGEON_ENEMY_COUNT, boss: "boss_spectral_king", bx: 2600, by: 1100 },
  dungeon_malakor_sanctum: { w: 3400, h: 2400, templates: ["nexus_champion", "void_crawler"], count: DUNGEON_ENEMY_COUNT, boss: "boss_malakor_overlord", bx: 2800, by: 1200 }
};

const TEMPLATES = {
  training_dummy: { name: "Maniqui", hp: 60, damage: 0, defense: 1, speed: 0, size: 20, aggro: 0, atkR: 0, cd: 999, exp: 8, gold: [0, 0], color: "#94a3b8" },
  field_rat: { name: "Rata", hp: 45, damage: 6, defense: 2, speed: 65, size: 16, aggro: 160, atkR: 35, cd: 1.4, exp: 12, gold: [1, 4], color: "#78716c" },
  forest_wolf: { name: "Lobo", hp: 140, damage: 18, defense: 6, speed: 105, size: 22, aggro: 240, atkR: 42, cd: 1.1, exp: 28, gold: [4, 12], color: "#57534e" },
  shadow_spider: { name: "Arana", hp: 170, damage: 24, defense: 8, speed: 95, size: 24, aggro: 220, atkR: 45, cd: 1.2, exp: 34, gold: [6, 14], color: "#3f3f46" },
  forest_bandit: { name: "Bandido", hp: 210, damage: 28, defense: 10, speed: 90, size: 24, aggro: 230, atkR: 45, cd: 1.2, exp: 42, gold: [8, 18], color: "#7c2d12" },
  boss_dire_alpha: { name: "Garmr", hp: 850, damage: 42, defense: 16, speed: 120, size: 40, aggro: 320, atkR: 60, cd: 1, exp: 220, gold: [40, 80], color: "#7f1d1d", boss: 1 },
  boss_crypt_necromancer: { name: "Valerius", hp: 650, damage: 32, defense: 12, speed: 70, size: 34, aggro: 280, atkR: 80, cd: 1.6, exp: 180, gold: [30, 70], color: "#4c1d95", boss: 1 },
  crystal_bat: { name: "Murcielago", hp: 240, damage: 32, defense: 12, speed: 110, size: 20, aggro: 250, atkR: 40, cd: 1, exp: 48, gold: [10, 20], color: "#0369a1" },
  stone_golem: { name: "Golem", hp: 420, damage: 44, defense: 25, speed: 65, size: 32, aggro: 220, atkR: 50, cd: 1.6, exp: 70, gold: [14, 28], color: "#64748b" },
  earth_elemental: { name: "Elemental", hp: 480, damage: 50, defense: 22, speed: 75, size: 30, aggro: 240, atkR: 70, cd: 1.5, exp: 80, gold: [16, 32], color: "#0f766e" },
  boss_crystal_colossus: { name: "Kragthor", hp: 1800, damage: 70, defense: 38, speed: 80, size: 48, aggro: 340, atkR: 75, cd: 1.5, exp: 400, gold: [80, 140], color: "#155e75", boss: 1 },
  acid_slug: { name: "Babosa", hp: 550, damage: 56, defense: 26, speed: 60, size: 26, aggro: 200, atkR: 45, cd: 1.3, exp: 90, gold: [18, 36], color: "#65a30d" },
  marsh_serpent: { name: "Serpiente", hp: 680, damage: 68, defense: 30, speed: 105, size: 28, aggro: 260, atkR: 50, cd: 1.1, exp: 110, gold: [22, 44], color: "#166534" },
  swamp_witch: { name: "Hechicera", hp: 750, damage: 82, defense: 28, speed: 75, size: 26, aggro: 280, atkR: 80, cd: 1.7, exp: 130, gold: [26, 50], color: "#6b21a8" },
  boss_hydra_spawn: { name: "Vennok", hp: 2600, damage: 96, defense: 45, speed: 90, size: 50, aggro: 350, atkR: 80, cd: 1.3, exp: 520, gold: [100, 180], color: "#365314", boss: 1 },
  giant_scorpion: { name: "Escorpion", hp: 880, damage: 98, defense: 44, speed: 95, size: 30, aggro: 250, atkR: 55, cd: 1.2, exp: 140, gold: [28, 56], color: "#b45309" },
  sand_nomad: { name: "Saqueador", hp: 1050, damage: 115, defense: 48, speed: 100, size: 26, aggro: 260, atkR: 50, cd: 1.1, exp: 160, gold: [32, 64], color: "#92400e" },
  fire_drake: { name: "Draco", hp: 1250, damage: 135, defense: 52, speed: 110, size: 36, aggro: 300, atkR: 80, cd: 1.6, exp: 190, gold: [36, 72], color: "#c2410c" },
  boss_scorpoking: { name: "Skorpios", hp: 3800, damage: 155, defense: 60, speed: 95, size: 54, aggro: 360, atkR: 85, cd: 1.2, exp: 700, gold: [140, 240], color: "#9a3412", boss: 1 },
  frost_wolf: { name: "Lobo artico", hp: 1350, damage: 145, defense: 56, speed: 120, size: 26, aggro: 270, atkR: 50, cd: 1, exp: 200, gold: [40, 80], color: "#e2e8f0" },
  ice_golem: { name: "Golem hielo", hp: 1800, damage: 165, defense: 75, speed: 70, size: 36, aggro: 240, atkR: 60, cd: 1.5, exp: 240, gold: [48, 90], color: "#7dd3fc" },
  yeti_brute: { name: "Yeti", hp: 2100, damage: 190, defense: 68, speed: 95, size: 38, aggro: 290, atkR: 65, cd: 1.3, exp: 270, gold: [54, 100], color: "#cbd5e1" },
  boss_frost_titan: { name: "Ymir", hp: 5200, damage: 220, defense: 85, speed: 90, size: 56, aggro: 380, atkR: 90, cd: 1.3, exp: 900, gold: [180, 300], color: "#0369a1", boss: 1 },
  arcane_sentinel: { name: "Centinela", hp: 2350, damage: 215, defense: 80, speed: 85, size: 34, aggro: 270, atkR: 55, cd: 1.2, exp: 300, gold: [60, 110], color: "#7c3aed" },
  glyph_construct: { name: "Constructo", hp: 2750, damage: 245, defense: 85, speed: 80, size: 36, aggro: 300, atkR: 80, cd: 1.5, exp: 340, gold: [70, 120], color: "#6d28d9" },
  boss_chronos_guardian: { name: "Ouroboros", hp: 7000, damage: 285, defense: 105, speed: 95, size: 60, aggro: 400, atkR: 95, cd: 1.2, exp: 1100, gold: [220, 360], color: "#5b21b6", boss: 1 },
  fallen_knight: { name: "Paladin caido", hp: 3200, damage: 275, defense: 100, speed: 95, size: 32, aggro: 280, atkR: 60, cd: 1.1, exp: 380, gold: [80, 140], color: "#44403c" },
  spectral_sorcerer: { name: "Nigromante", hp: 3600, damage: 320, defense: 95, speed: 80, size: 30, aggro: 320, atkR: 90, cd: 1.6, exp: 420, gold: [90, 150], color: "#6b21a8" },
  boss_spectral_king: { name: "Aurelius", hp: 9500, damage: 360, defense: 125, speed: 100, size: 64, aggro: 420, atkR: 100, cd: 1.2, exp: 1400, gold: [280, 450], color: "#a16207", boss: 1 },
  void_crawler: { name: "Devorador", hp: 4400, damage: 350, defense: 120, speed: 125, size: 34, aggro: 300, atkR: 60, cd: 0.9, exp: 480, gold: [100, 170], color: "#3b0764" },
  chaos_eye: { name: "Ojo", hp: 4900, damage: 410, defense: 110, speed: 90, size: 32, aggro: 340, atkR: 90, cd: 1.4, exp: 520, gold: [110, 180], color: "#86198f" },
  boss_void_harbinger: { name: "ZulGath", hp: 13000, damage: 460, defense: 145, speed: 105, size: 68, aggro: 450, atkR: 110, cd: 1.1, exp: 1800, gold: [360, 560], color: "#4a044e", boss: 1 },
  nexus_champion: { name: "Campeon", hp: 6000, damage: 480, defense: 140, speed: 115, size: 36, aggro: 320, atkR: 70, cd: 1, exp: 600, gold: [130, 210], color: "#7e22ce" },
  boss_malakor_overlord: { name: "MALAKOR", hp: 25000, damage: 650, defense: 180, speed: 120, size: 80, aggro: 550, atkR: 130, cd: 0.95, exp: 4000, gold: [800, 1400], color: "#2e1065", boss: 1 }
};

const enemyInstances = new Map();

function instanceKey(regionId, dungeonId) {
  return validRegion(regionId) + "|" + (dungeonId || "");
}

function makeEnemy(id, templateId, x, y, scaleHp) {
  const t = TEMPLATES[templateId] || TEMPLATES.field_rat;
  const hp = Math.max(1, Math.floor(t.hp * (scaleHp || 1)));
  return {
    id, templateId, name: t.name, x, y, startX: x, startY: y, vx: 0, vy: 0,
    hp, maxHp: hp, damage: t.damage, defense: t.defense, speed: t.speed, size: t.size,
    aggro: t.aggro, atkR: t.atkR, cd: t.cd, exp: t.exp, gold: t.gold, color: t.color,
    isBoss: !!t.boss, state: "patrol", targetId: null, lastAttackAt: 0, dead: false, respawnAt: 0, dirty: true
  };
}

function seedInstance(inst) {
  const dungeon = inst.dungeonId && DUNGEON_MAP[inst.dungeonId];
  const region = REGION_MAP[inst.regionId] || REGION_MAP.region_village;
  const cfg = dungeon || region;
  const w = cfg.w, h = cfg.h;
  const list = cfg.templates;
  const n = cfg.count;
  for (let i = 0; i < n; i++) {
    const tid = list[i % list.length];
    const x = 280 + ((i * 173 + 41) % Math.max(200, w - 560));
    const y = 260 + ((i * 211 + 73) % Math.max(200, h - 520));
    const id = inst.key + ":m" + i;
    inst.enemies.set(id, makeEnemy(id, tid, x, y, dungeon ? 1.3 : 1));
  }
  if (cfg.boss && TEMPLATES[cfg.boss]) {
    const bx = dungeon ? (dungeon.bx || w * 0.7) : w * 0.55;
    const by = dungeon ? (dungeon.by || h * 0.5) : h * 0.5;
    const id = inst.key + ":boss";
    inst.enemies.set(id, makeEnemy(id, cfg.boss, bx, by, 1));
  }
}

function getInstance(regionId, dungeonId) {
  const key = instanceKey(regionId, dungeonId);
  let inst = enemyInstances.get(key);
  if (!inst) {
    inst = { key, regionId: validRegion(regionId), dungeonId: dungeonId || null, enemies: new Map(), w: 2400, h: 1800 };
    const cfg = (inst.dungeonId && DUNGEON_MAP[inst.dungeonId]) || REGION_MAP[inst.regionId] || REGION_MAP.region_village;
    inst.w = cfg.w; inst.h = cfg.h;
    seedInstance(inst);
    enemyInstances.set(key, inst);
  }
  return inst;
}

function publicEnemy(e) {
  return {
    id: e.id,
    tid: e.templateId,
    name: e.name,
    x: Math.round(e.x),
    y: Math.round(e.y),
    hp: Math.max(0, Math.round(e.hp)),
    maxHp: e.maxHp,
    st: e.state,
    tgt: e.targetId,
    atk: e.state === "attack" ? 1 : 0,
    boss: e.isBoss ? 1 : 0,
    size: e.size,
    color: e.color
  };
}

function snapshotEnemies(regionId, dungeonId) {
  const inst = getInstance(regionId, dungeonId);
  return Array.from(inst.enemies.values()).filter((e) => !e.dead).map(publicEnemy);
}

function playersInInstance(regionId, dungeonId) {
  const out = [];
  for (const client of clients.values()) {
    if (!client.player) continue;
    if (client.player.regionId !== regionId) continue;
    if ((client.player.dungeonId || null) !== (dungeonId || null)) continue;
    out.push(client);
  }
  return out;
}

function sendEnemySnapshot(client) {
  if (!client || !client.player) return;
  send(client, {
    type: "ENEMY_SNAPSHOT",
    payload: { enemies: snapshotEnemies(client.player.regionId, client.player.dungeonId) }
  });
}

function handleAttackEnemy(client, payload) {
  const attacker = client.player;
  if (!attacker || !payload || !payload.enemyId) return;
  if (attacker.hp <= 0) return;
  const now = Date.now();
  if (client.lastEnemyAt && now - client.lastEnemyAt < PLAYER_HIT_COOLDOWN_MS) return;
  const inst = getInstance(attacker.regionId, attacker.dungeonId);
  const enemy = inst.enemies.get(payload.enemyId);
  if (!enemy || enemy.dead) return;
  const dist = Math.hypot(attacker.x - enemy.x, attacker.y - enemy.y);
  if (dist > PLAYER_HIT_ENEMY_RANGE + enemy.size) return;
  client.lastEnemyAt = now;
  const dmg = Math.max(6, Math.floor(10 + attacker.level * 3.2 - enemy.defense * 0.12));
  enemy.hp = Math.max(0, enemy.hp - dmg);
  enemy.state = "chase";
  enemy.targetId = attacker.id;
  enemy.dirty = true;
  regionBroadcast({
    type: "ENEMY_DAMAGE",
    payload: { id: enemy.id, hp: enemy.hp, maxHp: enemy.maxHp, dmg, x: enemy.x, y: enemy.y, attackerId: attacker.id }
  }, attacker);
  if (enemy.hp <= 0) {
    enemy.dead = true;
    enemy.respawnAt = now + (enemy.isBoss ? ENEMY_RESPAWN_MS * 4 : ENEMY_RESPAWN_MS);
    const gold = enemy.gold[0] + Math.floor(Math.random() * (enemy.gold[1] - enemy.gold[0] + 1));
    attacker.gold = clampNum((attacker.gold || 0) + gold, 0, 5e6);
    persistFromPlayer(attacker);
    regionBroadcast({
      type: "ENEMY_DEATH",
      payload: { id: enemy.id, x: enemy.x, y: enemy.y, tid: enemy.templateId, killerId: attacker.id }
    }, attacker);
    send(client, {
      type: "ENEMY_REWARD",
      payload: { gold, exp: enemy.exp, tid: enemy.templateId }
    });
    send(client, { type: "STATE_CORRECTION", payload: Object.assign(publicState(attacker), { gold: attacker.gold }) });
  }
}

function tickEnemies() {
  const dt = ENEMY_TICK_MS / 1000;
  const now = Date.now();
  for (const inst of enemyInstances.values()) {
    const pops = playersInInstance(inst.regionId, inst.dungeonId);
    if (pops.length === 0) continue;
    const dirty = [];
    const deaths = [];
    for (const enemy of inst.enemies.values()) {
      if (enemy.dead) {
        if (!enemy.isBoss && now >= enemy.respawnAt) {
          const t = TEMPLATES[enemy.templateId] || TEMPLATES.field_rat;
          enemy.hp = enemy.maxHp;
          enemy.dead = false;
          enemy.x = enemy.startX;
          enemy.y = enemy.startY;
          enemy.vx = 0; enemy.vy = 0;
          enemy.state = "patrol";
          enemy.targetId = null;
          enemy.dirty = true;
          dirty.push(publicEnemy(enemy));
        }
        continue;
      }
      let nearest = null, nearestDist = 1e9;
      for (const c of pops) {
        const d = Math.hypot(c.player.x - enemy.x, c.player.y - enemy.y);
        if (d < nearestDist) { nearestDist = d; nearest = c; }
      }
      const prevX = enemy.x, prevY = enemy.y, prevSt = enemy.state, prevHp = enemy.hp;
      if (nearest && enemy.aggro > 0 && nearestDist < enemy.aggro) {
        enemy.state = nearestDist <= enemy.atkR + ENEMY_ATTACK_RANGE_PAD ? "attack" : "chase";
        enemy.targetId = nearest.player.id;
        if (nearestDist > enemy.atkR * 0.75) {
          const ang = Math.atan2(nearest.player.y - enemy.y, nearest.player.x - enemy.x);
          enemy.vx += Math.cos(ang) * enemy.speed * 4 * dt;
          enemy.vy += Math.sin(ang) * enemy.speed * 4 * dt;
        }
        if (nearestDist <= enemy.atkR + ENEMY_ATTACK_RANGE_PAD && now - enemy.lastAttackAt >= enemy.cd * 1000) {
          enemy.lastAttackAt = now;
          const dmg = Math.max(1, Math.floor(enemy.damage * 0.85));
          nearest.player.hp = Math.max(0, nearest.player.hp - dmg);
          send(nearest, { type: "ENEMY_ATTACK", payload: { id: enemy.id, dmg, hp: nearest.player.hp, maxHp: nearest.player.maxHp } });
          send(nearest, { type: "STATE_CORRECTION", payload: publicState(nearest.player) });
          if (nearest.player.hp <= 0) {
            nearest.player.hp = nearest.player.maxHp;
            nearest.player.regionId = "region_village";
            nearest.player.dungeonId = null;
            nearest.player.x = 600;
            nearest.player.y = 900;
            persistFromPlayer(nearest.player);
            send(nearest, { type: "STATE_CORRECTION", payload: publicState(nearest.player) });
            sendEnemySnapshot(nearest);
          }
        }
      } else {
        enemy.state = "patrol";
        enemy.targetId = null;
        if (Math.random() < 0.02) {
          const ang = Math.random() * Math.PI * 2;
          enemy.vx += Math.cos(ang) * enemy.speed * 0.4;
          enemy.vy += Math.sin(ang) * enemy.speed * 0.4;
        }
      }
      enemy.vx *= Math.pow(0.08, dt);
      enemy.vy *= Math.pow(0.08, dt);
      enemy.x = Math.max(40, Math.min(inst.w - 40, enemy.x + enemy.vx * dt));
      enemy.y = Math.max(40, Math.min(inst.h - 40, enemy.y + enemy.vy * dt));
      if (Math.abs(enemy.x - prevX) > 6 || Math.abs(enemy.y - prevY) > 6 || enemy.state !== prevSt || enemy.hp !== prevHp || enemy.dirty) {
        enemy.dirty = false;
        dirty.push(publicEnemy(enemy));
      }
    }
    if (dirty.length) {
      const fakePlayer = { regionId: inst.regionId, dungeonId: inst.dungeonId };
      regionBroadcast({ type: "ENEMY_BATCH", payload: { enemies: dirty } }, fakePlayer);
    }
  }
}

setInterval(tickEnemies, ENEMY_TICK_MS);


if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const lan = lanAddress();
    console.log("Eldoria MP | http://localhost:" + PORT + " | bind " + HOST + " | LAN http://" + lan + ":" + PORT);
  });
}

async function shutdown() {
  if (saveWritePending) {
    if (saveWriteTimer) clearTimeout(saveWriteTimer);
    await flushSaves();
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
