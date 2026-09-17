# Eldoria: Realms of Ruin - despliegue web

Esta entrega deja Eldoria preparado para ejecutarse como un único servicio HTTP + WebSocket.

## Requisitos
- Node.js 20+ para ejecución directa.
- En producción, HTTPS/WSS debe terminar en el proxy o plataforma de hosting.

## Ejecutar localmente
`npm start` y abre `http://localhost:8080`.

## Producción con Node
`NODE_ENV=production PORT=8080 DATA_DIR=/data SAVE_FILE=/data/server-saves.json npm start`

El servidor escucha en `0.0.0.0` por defecto y expone `/` (juego), `/ws` (WebSocket), `/healthz` (health check) y `/api/online` (jugadores conectados).

## Docker
`docker build -t eldoria .`
`docker run -p 8080:8080 -v eldoria-data:/data eldoria`

El volumen `/data` conserva `server-saves.json` entre reinicios del contenedor.

## HTTPS y WebSocket
Coloca Eldoria detrás de un reverse proxy o plataforma que proporcione HTTPS. El cliente detecta automáticamente `https:` y usa `wss://` para `/ws`.

No publiques el puerto HTTP interno como HTTPS directamente. La capa externa debe terminar TLS y reenviar HTTP y WebSocket al puerto 8080.

## Persistencia
`server-saves.json` es almacenamiento local. En un hosting con disco efímero necesitas un volumen persistente o una base de datos antes de tratar el progreso como permanente.

## Pruebas
Con el servidor ejecutándose en otra terminal: `npm test`.
