const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// --- CONSTANTS & CONFIG ---
const DB_FILE = 'database.json';
const ROUND_TIME = 180; // 3 Minutes (in seconds)
const VOTE_TIME = 15;
const END_TIME = 10;

// --- MAPS & MODES ---
const MODES = ['FFA', 'KOTH', 'CTF'];
const MAPS = [
    { name: 'Arena', walls: [
        {x:300,y:300,w:100,h:400}, {x:800,y:600,w:400,h:100}, {x:1200,y:200,w:200,h:200},
        {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}
    ]},
    { name: 'Maze', walls: [
        {x:200,y:0,w:50,h:1200}, {x:600,y:400,w:50,h:1200}, {x:1000,y:0,w:50,h:1000},
        {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}
    ]}
];

// --- KITS ---
const KITS = {
    shotgun: { name: 'Breacher', hp: 150, speed: 0.9, weapon: { damage: 12, speed: 18, cooldown: 55, count: 6, spread: 0.35, range: 40 } },
    assault: { name: 'Soldier', hp: 100, speed: 1.0, weapon: { damage: 14, speed: 25, cooldown: 9, count: 1, spread: 0.05, range: 100 } },
    sniper:  { name: 'Recon', hp: 75, speed: 1.1, weapon: { damage: 110, speed: 50, cooldown: 90, count: 1, spread: 0, range: 200 } },
    tank:    { name: 'Juggernaut', hp: 250, speed: 0.6, weapon: { damage: 70, speed: 14, cooldown: 80, count: 1, spread: 0, range: 100 } }
};

// --- GAME STATE ---
let players = {};
let bullets = [];
let userDB = {};

let gameState = {
    phase: 'WARMUP', // WARMUP, GAME, END, VOTE
    timer: 0,
    mode: 'FFA',
    mapIndex: 0,
    walls: MAPS[0].walls,
    scores: { red: 0, blue: 0 }, // For Team Modes
    flags: [], // For CTF
    hill: null, // For KOTH
    votes: { map: {}, mode: {} }
};

// Load DB
if (fs.existsSync(DB_FILE)) { try { userDB = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) {} }
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(userDB)); }

// --- HELPERS ---
function getSpawn(team) {
    // Simple spawn logic: Red left, Blue right, FFA random
    let x, y, hit;
    let attempts = 0;
    do {
        if (gameState.mode === 'FFA') {
            x = Math.random() * 1800 + 100;
        } else if (team === 'RED') {
            x = Math.random() * 400 + 100; // Left side
        } else {
            x = Math.random() * 400 + 1500; // Right side
        }
        y = Math.random() * 1300 + 100;
        hit = gameState.walls.some(w => x < w.x + w.w && x + 40 > w.x && y < w.y + w.h && y + 40 > w.y);
        attempts++;
    } while (hit && attempts < 100);
    return { x, y };
}

function resetGame(newMode, newMapIndex) {
    gameState.mode = newMode;
    gameState.mapIndex = newMapIndex;
    gameState.walls = MAPS[newMapIndex].walls;
    gameState.scores = { red: 0, blue: 0 };
    gameState.timer = ROUND_TIME;
    gameState.phase = 'GAME';
    bullets = [];

    // Setup Objectives
    if (gameState.mode === 'KOTH') {
        gameState.hill = { x: 900, y: 650, w: 200, h: 200, owner: null, progress: 0 };
    } else {
        gameState.hill = null;
    }

    if (gameState.mode === 'CTF') {
        gameState.flags = [
            { team: 'RED', x: 100, y: 750, base: {x:100, y:750}, carrier: null },
            { team: 'BLUE', x: 1900, y: 750, base: {x:1900, y:750}, carrier: null }
        ];
    } else {
        gameState.flags = [];
    }

    // Respawn All Players & Assign Teams
    let pIds = Object.keys(players);
    pIds.forEach((id, i) => {
        let p = players[id];
        if (gameState.mode !== 'FFA') {
            p.team = (i % 2 === 0) ? 'RED' : 'BLUE'; // Simple alternating assign
            p.color = (p.team === 'RED') ? '#ff4444' : '#4488ff';
        } else {
            p.team = 'FFA';
            // Reset color if not owner
            if(p.maxHp < 300) p.color = p.originalColor || '#4488FF'; 
        }
        p.score = 0; // Reset round score
        p.deaths = 0;
        p.kills = 0;
        respawnPlayer(p);
    });
}

function respawnPlayer(p) {
    let spawn = getSpawn(p.team);
    p.x = spawn.x; p.y = spawn.y;
    p.hp = p.maxHp;
    p.vx = 0; p.vy = 0;
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('login', (data) => handleAuth(socket, data, true));
    socket.on('guest', (data) => handleAuth(socket, data, false));
    socket.on('signup', (data) => {
        if(userDB[data.user]) return socket.emit('authMsg', {success:false, msg:"Taken"});
        userDB[data.user] = { pass: data.pass, email: data.email, money:0, hat:'none' };
        saveDB(); socket.emit('authMsg', {success:true, msg:"Created"});
    });

    socket.on('input', (data) => handleInput(socket, data));
    socket.on('vote', (data) => {
        if (gameState.phase !== 'VOTE') return;
        // Tally votes
        if (data.type === 'map') gameState.votes.map[data.val] = (gameState.votes.map[data.val] || 0) + 1;
        if (data.type === 'mode') gameState.votes.mode[data.val] = (gameState.votes.mode[data.val] || 0) + 1;
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

function handleAuth(socket, data, isLogin) {
    let acc = isLogin ? userDB[data.user] : { money: 0, hat: 'none' };
    if (isLogin && (!acc || acc.pass !== data.pass)) return socket.emit('authMsg', {success:false, msg:"Fail"});

    let kit = KITS[data.kit] || KITS.assault;
    let isOwner = acc.email === 'raidenrmarks12@gmail.com';
    if(isOwner) kit = { name:'OWNER', hp:500, speed:1.2, weapon:{damage:100,speed:25,cooldown:10,count:1,spread:0.05,range:200}};

    players[socket.id] = {
        id: socket.id,
        username: isLogin ? data.user : "Guest"+Math.floor(Math.random()*100),
        team: 'FFA', color: isOwner ? '#FFD700' : '#4488FF', originalColor: isOwner ? '#FFD700' : '#4488FF',
        x:0, y:0, vx:0, vy:0, w:40, h:40,
        hp: kit.hp, maxHp: kit.hp, speed: kit.speed, weapon: kit.weapon,
        kit: kit.name, money: acc.money, hat: acc.hat,
        kills: 0, deaths: 0, score: 0,
        grapple: {active:false}, shootTimer:0, dashTimer:0
    };
    respawnPlayer(players[socket.id]);
    socket.emit('startGame', { id: socket.id });
}

function handleInput(s, d) {
    let p = players[s.id]; if(!p) return;
    p.angle = d.angle;
    
    // Move
    let spd = p.speed * (d.dash && p.dashTimer<=0 ? 25 : 0.8);
    if(d.dash && p.dashTimer<=0) p.dashTimer=60;
    if(d.up) p.vy-=spd; if(d.down) p.vy+=spd; if(d.left) p.vx-=spd; if(d.right) p.vx+=spd;

    // Shoot
    if(d.shoot && p.shootTimer<=0) {
        p.shootTimer = p.weapon.cooldown;
        for(let i=0; i<(p.weapon.count||1); i++) {
            let a = p.angle + (Math.random()-0.5)*(p.weapon.spread||0);
            bullets.push({ x:p.x+20, y:p.y+20, vx:Math.cos(a)*p.weapon.speed, vy:Math.sin(a)*p.weapon.speed, damage:p.weapon.damage, owner:s.id, life:p.weapon.range||100 });
        }
    }
    // Grapple
    if(d.grapple && !p.grapple.active) { p.grapple.active=true; p.grapple.x=d.gx; p.grapple.y=d.gy; }
    else if(!d.grapple) p.grapple.active=false;
}

// --- MAIN LOOP ---
setInterval(() => {
    // 1. GAME LOGIC
    if (gameState.phase === 'GAME') {
        gameState.timer--;
        if (gameState.timer <= 0) {
            gameState.phase = 'END';
            gameState.timer = END_TIME;
            // Send leaderboard
            let sorted = Object.values(players).sort((a,b) => b.score - a.score).slice(0,5);
            io.emit('gameover', { top: sorted, scores: gameState.scores });
        }

        // KOTH Logic
        if (gameState.mode === 'KOTH' && gameState.hill) {
            let redCount = 0, blueCount = 0;
            for(let id in players) {
                let p = players[id];
                if(p.x > gameState.hill.x && p.x < gameState.hill.x+gameState.hill.w && p.y > gameState.hill.y && p.y < gameState.hill.y+gameState.hill.h) {
                    if(p.team === 'RED') redCount++; else if(p.team === 'BLUE') blueCount++;
                }
            }
            if(redCount > blueCount) gameState.scores.red++;
            else if(blueCount > redCount) gameState.scores.blue++;
        }
        
        // CTF Logic is handled in collision
    } 
    else if (gameState.phase === 'END') {
        gameState.timer--;
        if (gameState.timer <= 0) {
            gameState.phase = 'VOTE';
            gameState.timer = VOTE_TIME;
            gameState.votes = { map:{}, mode:{} }; // Reset votes
        }
    }
    else if (gameState.phase === 'VOTE') {
        gameState.timer--;
        if (gameState.timer <= 0) {
            // Count votes
            let maxMode = 'FFA', maxMV = 0;
            for(let m in gameState.votes.mode) if(gameState.votes.mode[m] > maxMV) { maxMode = m; maxMV = gameState.votes.mode[m]; }
            
            let maxMap = 0, maxMapV = 0;
            for(let m in gameState.votes.map) if(gameState.votes.map[m] > maxMapV) { maxMap = parseInt(m); maxMapV = gameState.votes.map[m]; }

            resetGame(maxMode, maxMap);
        }
    }

    // 2. PHYSICS
    for (let id in players) {
        let p = players[id];
        p.x+=p.vx; p.y+=p.vy; p.vx*=0.9; p.vy*=0.9;
        if(p.dashTimer>0) p.dashTimer--; if(p.shootTimer>0) p.shootTimer--;
        
        gameState.walls.forEach(w => {
            if(p.x < w.x+w.w && p.x+p.w > w.x && p.y < w.y+w.h && p.y+p.h > w.y) {
                p.x-=p.vx*1.2; p.y-=p.vy*1.2; p.vx=0; p.vy=0;
            }
        });
        if(p.grapple.active) { p.vx += (p.grapple.x-(p.x+20))*0.002; p.vy += (p.grapple.y-(p.y+20))*0.002; }
        
        // CTF Flag Pickup
        if (gameState.mode === 'CTF') {
            gameState.flags.forEach(f => {
                // Pickup enemy flag
                if (!f.carrier && p.team !== f.team && Math.hypot(p.x-f.x, p.y-f.y) < 40) f.carrier = p.id;
                // Capture (have flag, touch own base)
                if (f.carrier === p.id && Math.hypot(p.x-f.base.x, p.y-f.base.y) < 50) {
                    gameState.scores[p.team.toLowerCase()]++; // Point!
                    p.score += 100; // Personal score
                    f.carrier = null; f.x = f.base.x; f.y = f.base.y; // Reset
                }
            });
        }
    }

    // 3. BULLETS & COMBAT
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        let hit = false;
        if(gameState.walls.some(w => b.x>w.x && b.x<w.x+w.w && b.y>w.y && b.y<w.y+w.h)) hit=true;
        
        if(!hit) {
            for(let id in players) {
                let p = players[id];
                if(b.owner !== id && (gameState.mode === 'FFA' || p.team !== players[b.owner].team) && 
                   b.x>p.x && b.x<p.x+p.w && b.y>p.y && b.y<p.y+p.h) {
                    p.hp -= b.damage; hit = true;
                    if(p.hp <= 0) {
                        let killer = players[b.owner];
                        if(killer) { 
                            killer.kills++; killer.score += 10; killer.money += 10;
                            if(userDB[killer.username]) { userDB[killer.username].money=killer.money; saveDB(); }
                        }
                        p.deaths++;
                        // CTF Drop Flag
                        if(gameState.mode === 'CTF') {
                            gameState.flags.forEach(f => { if(f.carrier === p.id) { f.carrier = null; f.x = p.x; f.y = p.y; } });
                        }
                        respawnPlayer(p);
                    }
                }
            }
        }
        if(hit || b.life <= 0) bullets.splice(i, 1);
    }

    // Update flags position to carrier
    if(gameState.mode === 'CTF') {
        gameState.flags.forEach(f => {
            if(f.carrier && players[f.carrier]) { f.x = players[f.carrier].x; f.y = players[f.carrier].y; }
        });
    }

    io.emit('state', { players, bullets, game: gameState });
}, 1000/60);

http.listen(process.env.PORT || 3000, () => console.log('Server running'));
