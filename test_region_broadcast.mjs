function connect(id, name, regionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${process.env.TEST_PORT || 8080}/ws`);
    const received = [];
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "HELLO",
        payload: { id, name, characterClass: "warrior", level: 1, hp: 100, maxHp: 100, x: 10, y: 10, regionId, gold: 50 }
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      received.push(msg);
      if (msg.type === "WELCOME") resolve({ ws, received, id });
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("timeout " + id)), 3000);
  });
}

const a = await connect("player_A", "Alice", "region_village");
const b = await connect("player_B", "Bob", "region_village"); // misma region que A
const c = await connect("player_C", "Carol", "region_forest"); // otra region

await new Promise(r => setTimeout(r, 300));

// A se mueve -> debe llegar a B (misma región) y NO a C (otra región)
a.received.length = 0; b.received.length = 0; c.received.length = 0;
a.ws.send(JSON.stringify({ type: "PLAYER_STATE", payload: { id: "player_A", x: 15, y: 15, regionId: "region_village", gold: 50, level: 1, hp: 100 } }));

await new Promise(r => setTimeout(r, 500));

const bGotState = b.received.some(m => m.type === "PLAYER_STATE" && m.payload.id === "player_A");
const cGotState = c.received.some(m => m.type === "PLAYER_STATE" && m.payload.id === "player_A");

console.log("B (misma región) recibió PLAYER_STATE de A:", bGotState, "(esperado: true)");
console.log("C (otra región) recibió PLAYER_STATE de A:", cGotState, "(esperado: false)");

// Prueba de teleport: salto grande sin cambio de región debe recortarse
a.received.length = 0; b.received.length = 0;
a.ws.send(JSON.stringify({ type: "PLAYER_STATE", payload: { id: "player_A", x: 7000, y: 15, regionId: "region_village", gold: 50, level: 1, hp: 100 } }));
await new Promise(r => setTimeout(r, 400));
const stateMsg = b.received.find(m => m.type === "PLAYER_STATE" && m.payload.id === "player_A");
console.log("Teleport sin cambio de región -> x recibido por B:", stateMsg ? stateMsg.payload.x : "no llegó", "(esperado: mucho menor que 7000)");

// Prueba de rate limit: mandar 200 mensajes rapidito, no debería tumbar el server
for (let i = 0; i < 200; i++) {
  a.ws.send(JSON.stringify({ type: "PLAYER_STATE", payload: { id: "player_A", x: 20 + i, y: 20, regionId: "region_village", gold: 50, level: 1, hp: 100 } }));
}
await new Promise(r => setTimeout(r, 500));
console.log("Servidor sigue vivo tras ráfaga de 200 mensajes:", a.ws.readyState === 1);

a.ws.close(); b.ws.close(); c.ws.close();
await new Promise(r => setTimeout(r, 200));
process.exit(0);
