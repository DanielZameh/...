// SERVER: server.js
// ------------------
// Node.js + Express + Socket.IO server for Truth-or-Dare Party
// Run:
// 1) npm init -y
// 2) npm install express socket.io
// 3) node server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static client (client.html) from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Utils
function randId(len = 6){ const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; }
function now(){ return Date.now(); }

// Prompt generator (>=300 truths and dares per mode)
function generatePrompts(mode){
  const truthTemplates = [
    "What's the wildest crush you've had since you were a teen?",
    "What's a secret habit you do when nobody's looking?",
    "What's the most embarrassing thing on your phone right now?",
    "What's a lie you told recently and why?",
    "Have you ever ghosted someone? Tell the story.",
    "What's a tiny crime you committed (no serious stuff) and didn't get caught?",
    "What's the dumbest thing you've done for a dare?",
    "What's one thing you'd change about your childhood if you could?",
    "Have you ever been caught singing or dancing alone? What happened?",
    "What's a rumor you started or spread unintentionally?"
  ];
  const dareTemplates = [
    "Do your best pirate impression for 30 seconds.",
    "Sing the chorus of a random pop song like it's a dramatic monologue.",
    "Dance for 40 seconds without music, full commitment.",
    "Text the 3rd contact in your phone this exact phrase: 'you won't believe this' and show receipts.",
    "Pretend you're a cat and act like it for one minute.",
    "Tell a scandalous secret about yourself or make one up and commit.",
    "Call a random number and sing 'happy birthday' with gusto.",
    "Speak in a fake accent until your next turn.",
    "Let someone write a short message (5 words) and post it as your status/avatar.",
    "Wrap your head in a towel and say 'I am the shampoo king' for 20 seconds."
  ];
  const adjectives = ["awkward","sneaky","ridiculous","brutal","tiny","embarrassing","wild","weird","hilarious","sweaty","spicy","cheeky"];
  const actions = ["kiss a random object","do 10 push-ups while singing","dramatically confess love to an inanimate object","hum the tune of your favorite song with no words","act like you're walking on an invisible tightrope","balance a spoon on your nose for 20s","draw a moustache on your face with lipstick","speak only in questions for 30s"];
  const spin = ["in front of the group","but whisper it like a scandal","with full dramatic gestures","while hopping on one foot","in a slow-motion voiceover","while blinking dramatically"];

  let truths = [];
  let dares = [];
  for(let i=0;i<400;i++){
    const tBase = truthTemplates[i % truthTemplates.length];
    const tAdd = adjectives[i % adjectives.length];
    truths.push(`${tBase} (${tAdd} edition #${i+1})`);

    const dBase = dareTemplates[i % dareTemplates.length];
    const act = actions[i % actions.length];
    const suffix = spin[i % spin.length];
    dares.push(`${dBase} — or ${act} ${suffix} (round ${i+1})`);
  }

  if(mode === 'risky'){
    truths = truths.map((s,i)=> s.replace('edition', 'risky edition'));
    dares = dares.map((s,i)=> s.replace('or', 'or (risky)'));
  } else {
    truths = truths.map((s,i)=> s.replace('edition', 'funny edition'));
    dares = dares.map((s,i)=> s.replace('or', 'or (funny)'));
  }

  return { truths: truths.slice(0,350), dares: dares.slice(0,350) };
}

// In-memory room store (for demo / small group). For production, use persistent store.
const rooms = {}; // roomId -> { hostId, hostName, players: {socketId: {id,name,joinedAt}}, mode, turnOrder: [socketId], currentTurnIdx, state, lastPrompt, confirmations: {socketId:true} }

io.on('connection', socket =>{
  console.log('socket connected', socket.id);

  socket.on('create_room', ({name, mode}, cb) =>{
    const roomId = randId(6);
    rooms[roomId] = {
      id: roomId,
      createdAt: now(),
      hostId: socket.id,
      hostName: name || 'Host',
      mode: mode || 'funny',
      players: {},
      turnOrder: [],
      currentTurnIdx: 0,
      state: 'lobby',
      lastPrompt: null,
      confirmations: {},
      prompts: generatePrompts(mode || 'funny')
    };
    // add host as player
    rooms[roomId].players[socket.id] = { id: socket.id, name: name||'Player', joinedAt: now() };
    socket.join(roomId);
    socket.emit('room_created', {roomId, room: rooms[roomId]});
    io.to(roomId).emit('room_update', rooms[roomId]);
    console.log('room created', roomId);
    if(cb) cb({ok:true,roomId});
  });

  socket.on('join_room', ({roomId, name}, cb) =>{
    const r = rooms[roomId];
    if(!r) { if(cb) cb({ok:false, error:'Room not found'}); return; }
    r.players[socket.id] = { id: socket.id, name: name||('Player_'+randId(3)), joinedAt: now() };
    socket.join(roomId);
    io.to(roomId).emit('room_update', r);
    socket.emit('joined_room', {roomId, room: r});
    io.to(roomId).emit('log', {ts:now(), text: `${name} joined the party`});
    if(cb) cb({ok:true});
  });

  socket.on('leave_room', ({roomId}, cb)=>{
    const r = rooms[roomId];
    if(!r) { if(cb) cb({ok:false}); return; }
    delete r.players[socket.id];
    socket.leave(roomId);
    // if host left, transfer host or close
    if(r.hostId === socket.id){
      const ids = Object.keys(r.players);
      if(ids.length>0){ r.hostId = ids[0]; r.hostName = r.players[ids[0]].name; }
      else { delete rooms[roomId]; io.to(roomId).emit('room_closed'); return; }
    }
    io.to(roomId).emit('room_update', r);
    if(cb) cb({ok:true});
  });

  socket.on('start_game', ({roomId}, cb)=>{
    const r = rooms[roomId]; if(!r){ if(cb) cb({ok:false}); return; }
    // build turn order
    const ids = Object.keys(r.players);
    const shuffled = ids.slice().sort(()=>Math.random()-0.5);
    r.turnOrder = shuffled;
    r.state = 'playing';
    r.currentTurnIdx = 0;
    r.confirmations = {};
    r.lastPrompt = null;
    io.to(roomId).emit('room_update', r);
    io.to(roomId).emit('log', {ts:now(), text: `${r.hostName} started the game`});
    if(cb) cb({ok:true});
  });

  socket.on('pick_prompt', ({roomId, choice}, cb)=>{
    const r = rooms[roomId]; if(!r){ if(cb) cb({ok:false}); return; }
    const pool = (choice === 'truth') ? r.prompts.truths : r.prompts.dares;
    const idx = Math.floor(Math.random()*pool.length);
    const prompt = pool[idx];
    r.lastPrompt = { by: r.players[socket.id] ? r.players[socket.id].name : 'unknown', choice, text: prompt, at: now() };
    r.confirmations = {}; // reset confirmations
    io.to(roomId).emit('room_update', r);
    io.to(roomId).emit('log', {ts:now(), text: `${r.lastPrompt.by} picked ${choice.toUpperCase()} — ${prompt}`});
    if(cb) cb({ok:true});
  });

  socket.on('confirm_did_it', ({roomId}, cb)=>{
    const r = rooms[roomId]; if(!r){ if(cb) cb({ok:false}); return; }
    r.confirmations[socket.id] = { name: r.players[socket.id] ? r.players[socket.id].name : 'anon', at: now() };
    io.to(roomId).emit('room_update', r);
    io.to(roomId).emit('log', {ts:now(), text: `${r.players[socket.id].name} confirmed`});
    // check if confirmations reached (all other players)
    const totalPlayers = Object.keys(r.players).length;
    const needed = Math.max(0, totalPlayers - 1);
    const got = Object.keys(r.confirmations).length;
    if(got >= needed && needed>0){
      // auto-advance turn
      r.currentTurnIdx = (r.currentTurnIdx + 1) % Math.max(1, r.turnOrder.length);
      r.confirmations = {};
      r.lastPrompt = null;
      io.to(roomId).emit('room_update', r);
      io.to(roomId).emit('log', {ts:now(), text: `All confirmed — moving to next`});
    }
    if(cb) cb({ok:true});
  });

  socket.on('force_next', ({roomId}, cb)=>{
    const r = rooms[roomId]; if(!r){ if(cb) cb({ok:false}); return; }
    // only host can force; but we allow any if they confirm
    if(r.hostId !== socket.id){ /* optional: allow */ }
    r.currentTurnIdx = (r.currentTurnIdx + 1) % Math.max(1, r.turnOrder.length);
    r.confirmations = {};
    r.lastPrompt = null;
    io.to(roomId).emit('room_update', r);
    io.to(roomId).emit('log', {ts:now(), text: `${r.players[socket.id] ? r.players[socket.id].name : 'someone'} forced next`});
    if(cb) cb({ok:true});
  });

  socket.on('get_room', ({roomId}, cb)=>{
    const r = rooms[roomId]; if(!r){ if(cb) cb({ok:false}); return; }
    if(cb) cb({ok:true, room: r});
  });

  socket.on('disconnect', ()=>{
    // remove from any rooms
    for(const roomId of Object.keys(rooms)){
      const r = rooms[roomId];
      if(r.players && r.players[socket.id]){
        delete r.players[socket.id];
        io.to(roomId).emit('room_update', r);
        io.to(roomId).emit('log', {ts:now(), text: `A player left`});
        if(r.hostId === socket.id){
          const ids = Object.keys(r.players);
          if(ids.length>0){ r.hostId = ids[0]; r.hostName = r.players[ids[0]].name; io.to(roomId).emit('log', {ts:now(), text: `Host left — new host: ${r.hostName}`}); }
          else { delete rooms[roomId]; }
        }
      }
    }
  });

});

server.listen(PORT, ()=> console.log('Server running on port', PORT));


/*
  CLIENT: public/client.html
  -------------------------
  Put this file in a folder named "public" next to server.js. The server serves it at http://localhost:3000/
  It connects to this Socket.IO server and runs the UI.
*/

/*
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Truth or Dare — Party Mode (Socket.IO)</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
  :root{ --bg:#0f1724; --accent:#ff5c7c; --muted:#9aa4b2 }
  *{box-sizing:border-box;font-family:Inter,system-ui,Arial}
  body{margin:0;background:var(--bg);color:#e6eef6}
  .wrap{max-width:1100px;margin:20px auto;padding:18px}
  .logo{width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#ff7b8a,#7dd3fc);display:flex;align-items:center;justify-content:center;font-weight:800;color:#051024}
  header{display:flex;gap:12px;align-items:center}
  input,select,button{padding:8px;border-radius:8px;border:0}
  button{cursor:pointer}
  main{display:grid;grid-template-columns:320px 1fr;gap:14px;margin-top:16px}
  .card{background:rgba(255,255,255,0.03);padding:14px;border-radius:12px}
  .players{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto}
  .player{display:flex;gap:8px;align-items:center}
  .prompt-box{min-height:120px;display:flex;align-items:center;justify-content:center;font-weight:600}
  .actions{display:flex;gap:8px;margin-top:12px}
  .confirm-strip{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">T&D</div>
    <div>
      <h2>Truth or Dare • Realtime</h2>
      <div style="color:var(--muted)">Socket.IO server • Host & join • Confirm before move</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
      <select id="langSelect"><option value="en">EN</option><option value="ar">AR</option></select>
      <input id="nameInput" placeholder="Your name" />
      <button id="createBtn">Create Party</button>
      <input id="joinRoomInput" placeholder="Room code" style="width:110px"/>
      <button id="joinBtn">Join</button>
    </div>
  </header>

  <main>
    <div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="color:var(--muted);font-size:13px">Room</div>
            <div id="roomCode">—</div>
          </div>
          <div>
            <div style="color:var(--muted);font-size:13px">Host</div>
            <div id="hostName">—</div>
          </div>
        </div>

        <div style="margin-top:8px">
          <label><input type="radio" name="mode" value="risky" checked/> Risky</label>
          <label style="margin-left:8px"><input type="radio" name="mode" value="funny"/> Funny</label>
        </div>

        <div style="margin-top:10px;color:var(--muted);font-size:13px">Players</div>
        <div class="players" id="playersList"></div>

        <div style="display:flex;gap:8px;margin-top:10px">
          <button id="startGameBtn">Start</button>
          <button id="leaveBtn">Leave</button>
          <button id="forceNextBtn">Force Next</button>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div style="color:var(--muted);font-size:13px">Log</div>
        <div id="log" style="max-height:160px;overflow:auto;margin-top:6px"></div>
      </div>
    </div>

    <div>
      <div class="card">
        <div id="turnBanner" style="font-weight:800">Not in party</div>
        <div id="promptArea" class="prompt-box" style="margin-top:8px">Waiting...</div>

        <div class="actions">
          <button id="truthBtn">Truth</button>
          <button id="dareBtn">Dare</button>
          <button id="passBtn">Pass</button>
        </div>

        <div style="margin-top:10px;color:var(--muted);font-size:13px">Players who confirmed:</div>
        <div class="confirm-strip" id="confirmStrip"></div>

        <div style="margin-top:10px;display:flex;gap:8px">
          <button id="confirmDidIt">HE DID IT</button>
          <button id="iDidIt">I did it</button>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div><strong>Mode:</strong> <span id="currentMode">—</span> • <strong>Turn:</strong> <span id="turnIndex">—</span></div>
      </div>
    </div>
  </main>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function $(id){return document.getElementById(id)}
  const nameInput = $('nameInput'), createBtn = $('createBtn'), joinBtn = $('joinBtn'), joinRoomInput = $('joinRoomInput');
  const roomCodeEl = $('roomCode'), hostNameEl = $('hostName'), playersList = $('playersList'), startGameBtn = $('startGameBtn'), leaveBtn = $('leaveBtn');
  const logEl = $('log'), turnBanner = $('turnBanner'), promptArea = $('promptArea'), truthBtn = $('truthBtn'), dareBtn = $('dareBtn'), passBtn = $('passBtn'), confirmStrip = $('confirmStrip');
  const confirmDidIt = $('confirmDidIt'), iDidIt = $('iDidIt'), currentModeEl = $('currentMode'), turnIndexEl = $('turnIndex'), forceNextBtn = $('forceNextBtn');

  let local = { name:'', roomId:null, isHost:false };

  createBtn.onclick = ()=>{
    const name = nameInput.value.trim() || ('Player_'+Math.floor(Math.random()*900));
    const mode = document.querySelector('input[name="mode"]:checked').value;
    local.name = name;
    socket.emit('create_room', {name, mode}, (res)=>{
      if(res && res.roomId){ local.roomId = res.roomId; roomCodeEl.textContent = res.roomId; }
    });
  };

  joinBtn.onclick = ()=>{
    const code = (joinRoomInput.value||'').trim().toUpperCase();
    if(!code) return alert('enter room code');
    const name = nameInput.value.trim() || ('Player_'+Math.floor(Math.random()*900));
    local.name = name;
    socket.emit('join_room', {roomId: code, name}, (res)=>{
      if(res && res.ok){ local.roomId = code; roomCodeEl.textContent = code; }
      else alert(res.error||'Could not join');
    });
  };

  leaveBtn.onclick = ()=>{
    if(!local.roomId) return; socket.emit('leave_room', {roomId: local.roomId}, ()=>{ resetUI(); });
  };

  startGameBtn.onclick = ()=>{ if(!local.roomId) return; socket.emit('start_game', {roomId: local.roomId}); };
  forceNextBtn.onclick = ()=>{ if(!local.roomId) return; socket.emit('force_next', {roomId: local.roomId}); };

  truthBtn.onclick = ()=>{ if(!local.roomId) return; socket.emit('pick_prompt', {roomId: local.roomId, choice:'truth'}); };
  dareBtn.onclick = ()=>{ if(!local.roomId) return; socket.emit('pick_prompt', {roomId: local.roomId, choice:'dare'}); };
  passBtn.onclick = ()=>{ if(!local.roomId) return; socket.emit('force_next', {roomId: local.roomId}); };

  confirmDidIt.onclick = ()=>{ if(!local.roomId) return; socket.emit('confirm_did_it', {roomId: local.roomId}); };
  iDidIt.onclick = ()=>{ if(!local.roomId) return; socket.emit('i_did_it', {roomId: local.roomId}); };

  socket.on('room_created', ({roomId, room})=>{ renderRoom(room); });
  socket.on('joined_room', ({roomId, room})=>{ renderRoom(room); });
  socket.on('room_update', (room)=>{ renderRoom(room); });
  socket.on('log', (entry)=>{ appendLog(entry.text); });
  socket.on('room_closed', ()=>{ alert('Room closed'); resetUI(); });

  function renderRoom(room){
    if(!room) return;
    roomCodeEl.textContent = room.id;
    hostNameEl.textContent = room.hostName || '—';
    currentModeEl.textContent = room.mode || '—';

    // players
    playersList.innerHTML = '';
    Object.values(room.players||{}).forEach(p=>{
      const div = document.createElement('div'); div.className='player'; div.textContent = p.name + (room.hostId===p.id? ' • host':''); playersList.appendChild(div);
    });

    // state & turn
    if(room.state !== 'playing'){
      turnBanner.textContent = 'Lobby — waiting to start';
      promptArea.textContent = 'Waiting...';
      turnIndexEl.textContent = '-';
    } else {
      const idx = room.currentTurnIdx||0; const order = room.turnOrder||[]; const curId = order[idx]; const cur = room.players[curId]; const curName = cur ? cur.name : '—';
      turnBanner.textContent = `${curName}'s turn`;
      turnIndexEl.textContent = `${idx+1}/${Math.max(1,order.length)}`;
      if(room.lastPrompt && room.lastPrompt.text){ promptArea.textContent = `${room.lastPrompt.choice.toUpperCase()} — ${room.lastPrompt.text}`; }
      else { promptArea.textContent = `${curName} must pick Truth or Dare`; }
    }

    // confirmations
    confirmStrip.innerHTML = '';
    Object.values(room.confirmations||{}).forEach(c=>{ const b=document.createElement('div'); b.textContent=c.name; b.className='player'; confirmStrip.appendChild(b); });

    // log
  }

  function appendLog(txt){ const d = document.createElement('div'); d.textContent = txt; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }

  function resetUI(){ local = {name:'',roomId:null}; roomCodeEl.textContent='—'; hostNameEl.textContent='—'; playersList.innerHTML=''; turnBanner.textContent='Not in party'; promptArea.textContent='Waiting...'; }

</script>
</body>
</html>
*/
