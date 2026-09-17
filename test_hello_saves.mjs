function connect(id, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${process.env.TEST_PORT || 8080}/ws`);
    const received = [];
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "HELLO",
        payload: Object.assign({ id, name: "Tester", characterClass: "warrior", x: 100, y: 100, regionId: "region_village" }, extra)
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

const p1 = await connect("player_save_test", { gold: 999999, level: 80 });
console.log("HELLO forjado gold servidor:", p1.welcome.payload.you.gold, "(esperado: 50)");
console.log("HELLO forjado level servidor:", p1.welcome.payload.you.level, "(esperado: 1)");

p1.ws.send(JSON.stringify({ type: "SAVE_SNAPSHOT", payload: { id: "player_save_test", gold: 1200, level: 3 } }));
await new Promise(r => setTimeout(r, 800));
p1.ws.close();
await new Promise(r => setTimeout(r, 300));

const cheater = await connect("player_save_test", { gold: 999999999, level: 80 });
console.log("Reconexión gold:", cheater.welcome.payload.you.gold, "(esperado: 50)");
console.log("Reconexión level:", cheater.welcome.payload.you.level, "(esperado: 1)");

const dupA = await connect("dup_player");
dupA.received.length = 0;
const dupB = await connect("dup_player");
await new Promise(r => setTimeout(r, 400));
console.log("SESSION_REPLACED:", !!dupA.received.find(m => m.type === "SESSION_REPLACED"), "(esperado: true)");
console.log("A closed:", dupA.ws.readyState, "(esperado: 2 o 3)");
console.log("B open:", dupB.ws.readyState, "(esperado: 1)");

cheater.ws.close(); dupA.ws.close(); dupB.ws.close();
await new Promise(r => setTimeout(r, 200));
process.exit(0);
