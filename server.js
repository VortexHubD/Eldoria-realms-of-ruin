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
        saved: saves[id] || null
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
