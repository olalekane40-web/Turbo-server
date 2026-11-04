// Turbo Circuit 3D - multiplayer server
// Node.js 18+ only, no npm packages needed.
// Run:  node server.js        (PORT env var sets the port, default 8080)
//
// Transport: Server-Sent Events (server -> player) + HTTP POST (player -> server).
// Players send their car state about 10 times a second; the server relays a
// combined snapshot to everyone in the same room 10 times a second.
// NOTE: the server trusts the client's car position (no anti-cheat). Fine for
// friends and testing; a public game needs server-side physics later.

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 8;
const TIMEOUT_MS = 10000;
const MAPS = ['park', 'city', 'desert', 'alpine', 'coast'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const rid = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
const roomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const cleanName = (s) => String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Racer';

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function send(res, code, obj){
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20000){ req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function getRoomPlayer(url, res){
  const room = rooms.get(url.searchParams.get('room') || '');
  const p = room && room.players.get(url.searchParams.get('id') || '');
  if (!p){ send(res, 404, { error: 'not in room' }); return null; }
  return { room, p };
}

// ---------- room helpers ----------
function publicPlayers(room){
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, car: p.car, slot: p.slot }));
}
function emit(room, event, data){
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  room.players.forEach(p => { if (p.sse){ try { p.sse.write(msg); } catch (e) {} } });
}
function removePlayer(room, pid){
  room.players.delete(pid);
  if (room.players.size === 0){ rooms.delete(room.code); return; }
  if (room.host === pid){ room.host = room.players.keys().next().value; }
  if (room.status === 'lobby') emit(room, 'lobby', { host: room.host, map: room.map, players: publicPlayers(room) });
  else emit(room, 'players', { players: publicPlayers(room) });
}
function standings(room){
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, car: p.car, finished: p.finished, finishTime: p.finishTime,
    progress: p.lap * 1000 + p.idx
  })).sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return a.finishTime - b.finishTime;
    return b.progress - a.progress;
  });
}

// ---------- HTTP API ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS'){ cors(res); res.writeHead(204); return res.end(); }
  try {
    // quick health check
    if (url.pathname === '/health') return send(res, 200, { ok: true, rooms: rooms.size });

    // join (or create) a lobby
    if (url.pathname === '/api/join' && req.method === 'POST'){
      const body = await readBody(req);
      let room = [...rooms.values()].find(r => r.status === 'lobby' && r.players.size < MAX_PLAYERS);
      if (!room){
        let code; do { code = roomCode(); } while (rooms.has(code));
        room = { code, status: 'lobby', host: null, map: 'park', laps: 3, players: new Map(), startAt: 0 };
        rooms.set(code, room);
      }
      const pid = rid(12);
      const slot = room.players.size;
      room.players.set(pid, {
        id: pid, name: cleanName(body.name), car: String(body.car || 'c0_0').slice(0, 12), slot,
        x: 0, z: 0, heading: 0, speed: 0, idx: 0, lap: -1, finished: false, finishTime: 0,
        seen: Date.now(), sse: null
      });
      if (!room.host) room.host = pid;
      emit(room, 'lobby', { host: room.host, map: room.map, players: publicPlayers(room) });
      return send(res, 200, { room: room.code, id: pid, host: room.host, map: room.map, slot });
    }

    // live event stream for one player
    if (url.pathname === '/api/events' && req.method === 'GET'){
      const hit = getRoomPlayer(url, res); if (!hit) return;
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      hit.p.sse = res; hit.p.seen = Date.now();
      res.write('event: hello\ndata: ' + JSON.stringify({ id: hit.p.id, host: hit.room.host, status: hit.room.status, map: hit.room.map, laps: hit.room.laps, startAt: hit.room.startAt, players: publicPlayers(hit.room) }) + '\n\n');
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(ka); if (hit.p.sse === res) hit.p.sse = null; });
      return;
    }

    // host starts the race
    if (url.pathname === '/api/start' && req.method === 'POST'){
      const body = await readBody(req);
      const hit = getRoomPlayer(new URL('http://x/?room=' + (body.room || '') + '&id=' + (body.id || '')), res); if (!hit) return;
      const { room, p } = hit;
      if (room.host !== p.id) return send(res, 403, { error: 'only the host can start' });
      if (room.players.size < 2) return send(res, 400, { error: 'need at least 2 players' });
      if (room.status !== 'lobby') return send(res, 400, { error: 'already racing' });
      room.map = MAPS.includes(body.map) ? body.map : room.map;
      room.laps = Math.min(5, Math.max(1, Math.round(num(body.laps, 3))));
      room.status = 'racing'; room.startAt = Date.now() + 4000;
      room.players.forEach(pl => { pl.finished = false; pl.finishTime = 0; pl.lap = -1; pl.idx = 0; });
      emit(room, 'start', { map: room.map, laps: room.laps, startAt: room.startAt, players: publicPlayers(room) });
      return send(res, 200, { ok: true });
    }

    // player car state (about 10 times a second)
    if (url.pathname === '/api/state' && req.method === 'POST'){
      const body = await readBody(req);
      const hit = getRoomPlayer(new URL('http://x/?room=' + (body.room || '') + '&id=' + (body.id || '')), res); if (!hit) return;
      const { room, p } = hit;
      p.seen = Date.now();
      p.x = num(body.x); p.z = num(body.z); p.heading = num(body.heading); p.speed = num(body.speed);
      p.idx = Math.max(0, Math.min(599, Math.round(num(body.idx))));
      p.lap = Math.round(num(body.lap, -1));
      if (body.finished && !p.finished){ p.finished = true; p.finishTime = Math.max(0, num(body.finishTime)); }
      return send(res, 200, { ok: true });
    }

    // leave the room
    if (url.pathname === '/api/leave' && req.method === 'POST'){
      const body = await readBody(req);
      const room = rooms.get(body.room || '');
      if (room) removePlayer(room, body.id);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
});

// ---------- broadcast loop (10 per second) ----------
setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    // drop players who went silent
    room.players.forEach(p => { if (now - p.seen > TIMEOUT_MS) removePlayer(room, p.id); });
    if (!rooms.has(room.code)) return;
    if (room.status !== 'racing') return;
    const snap = [...room.players.values()].map(p => ({
      id: p.id, x: p.x, z: p.z, heading: p.heading, speed: p.speed,
      idx: p.idx, lap: p.lap, finished: p.finished, finishTime: p.finishTime
    }));
    emit(room, 'snap', { t: now, players: snap });
    const everyoneDone = room.players.size > 0 &&
      ([...room.players.values()].every(p => p.finished) || now - room.startAt > 10 * 60 * 1000);
    if (everyoneDone){
      emit(room, 'done', { standings: standings(room) });
      room.status = 'lobby';
      room.players.forEach(p => { p.finished = false; });
      emit(room, 'lobby', { host: room.host, map: room.map, players: publicPlayers(room) });
    }
  });
}, 100);

server.listen(PORT, () => console.log('Turbo Circuit server listening on port ' + PORT));
