function connect(id, name, regionId, xy = { x: 120, y: 120 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${process.env.TEST_PORT || 8080}/ws`);
    const received = [];
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "HELLO",
        payload: { id, name, characterClass: "warrior", regionId, x: xy.x, y: xy.y }
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      received.push(msg);
      if (msg.type === "WELCOME") resolve({ ws, received, id, welcome: msg });
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("timeout " + id)), 4000);
  });
}

const a = await connect("auth_A", "Alice", "region_village", { x: 150, y: 150 });
const b = await connect("auth_B", "Bob", "region_village", { x: 160, y: 150 });
const c = await connect("auth_C", "Carol", "region_forest", { x: 150, y: 150 });
await new Promise(r => setTimeout(r, 250));

a.received.length = 0; b.received.length = 0; c.received.length = 0;
a.ws.send(JSON.stringify({ type: "CHAT_MESSAGE", payload: { text: "hola region" } }));
await new Promise(r => setTimeout(r, 300));
console.log("B recibió chat:", b.received.some(m => m.type === "CHAT_MESSAGE" && m.payload.text === "hola region"), "(esperado: true)");
console.log("C NO recibió chat:", !c.received.some(m => m.type === "CHAT_MESSAGE" && m.payload && m.payload.text === "hola region"), "(esperado: true)");

a.received.length = 0; b.received.length = 0;
a.ws.send(JSON.stringify({ type: "CHAT_MESSAGE", payload: { text: "" } }));
a.ws.send(JSON.stringify({ type: "CHAT_MESSAGE", payload: { text: "\n\t  " } }));
await new Promise(r => setTimeout(r, 200));
console.log("Chat vacío ignorado:", !b.received.some(m => m.type === "CHAT_MESSAGE" && m.payload.sender === "Alice"), "(esperado: true)");

b.received.length = 0;
a.ws.send(JSON.stringify({ type: "ATTACK_PLAYER", payload: { targetId: "auth_B", damage: 99999 } }));
await new Promise(r => setTimeout(r, 300));
const hit = b.received.find(m => m.type === "PVP_HIT") || a.received.find(m => m.type === "PVP_HIT");
console.log("PvP hit servidor:", !!(hit && hit.payload.damage < 99999), "dmg=", hit && hit.payload.damage, "(esperado: daño servidor, no 99999)");

c.received.length = 0;
a.ws.send(JSON.stringify({ type: "PLAYER_STATE", payload: { x: 170, y: 150, regionId: "region_village", gold: 999999, level: 80, hp: 1 } }));
await new Promise(r => setTimeout(r, 300));
const leaked = c.received.some(m => m.type === "PLAYER_STATE" && m.payload.id === "auth_A");
console.log("Estado no sale a otra región:", !leaked, "(esperado: true)");
const bState = b.received.find(m => m.type === "PLAYER_STATE" && m.payload.id === "auth_A");
console.log("Level no viene del cliente:", bState ? bState.payload.level : "n/a", "(esperado: 1)");

a.ws.close(); b.ws.close(); c.ws.close();
await new Promise(r => setTimeout(r, 200));
process.exit(0);
