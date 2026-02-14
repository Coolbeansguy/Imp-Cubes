const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// --- CONSTANTS ---
const DB_FILE = 'database.json';
const MAPS = [
    { name: 'Arena', walls: [{x:300,y:300,w:100,h:400}, {x:800,y:600,w:400,h:100}, {x:1200,y:200,w:200,h:200}, {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] },
    { name: 'Maze', walls: [{x:400,y:0,w:50,h:1000}, {x:800,y:500,w:50,h:1000}, {x:1200,y:0,w:50,h:1000}, {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] }
];
const KITS = {
    assault: { name: 'Soldier', hp: 120, speed: 1.0, weapon: { damage: 12, speed: 22, cooldown: 8, ammo: 30, reload: 120, spread: 0.05, range: 80 } },
    shotgun: { name: 'Breacher', hp: 160, speed: 0.9, weapon: { damage: 9, speed: 18, cooldown: 55, ammo: 5, reload: 150, count: 6, spread: 0.3, range: 40 } },
    sniper: { name: 'Recon', hp: 80, speed: 1.1, weapon: { damage: 95, speed: 45, cooldown: 80, ammo: 3, reload: 180, spread: 0.0, range: 200 } },
    tank: { name: 'Heavy', hp: 300, speed: 0.7, weapon: { damage: 8, speed: 20, cooldown: 5, ammo: 100, reload: 300, spread: 0.15, range: 70 } },
    ninja: { name: 'Ninja', hp: 90, speed: 1.3, weapon: { damage: 25, speed: 30, cooldown: 15, ammo: 10, reload: 60, spread: 0.02, range: 50 } }
};
const GOD_KIT = { name:'ADMIN', hp:5000, speed:1.5, weapon:{damage:5000,speed:40,cooldown:5,ammo:999,reload:0,range:500}};

// --- DATABASE ---
let userDB = {};
if(fs.existsSync(DB_FILE)) try { userDB=JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){}
function saveDB(){ fs.writeFileSync(DB_FILE,JSON.stringify(userDB)); }
function getLevel(xp) { return Math.floor(Math.sqrt(xp/100))+1; }

// --- LOBBY SYSTEM ---
const lobbies = {}; // Stores all active game lobbies
const socketLobbyMap = {}; // Maps socket ID to lobby ID

class Lobby {
    constructor(id, hostId) {
        this.id = id;
        this.hostId = hostId;
        this.players = {};
        this.bullets = [];
        this.gameState = {
            phase: 'GAME', timer: 180 * 60, mode: 'FFA', mapIndex: 0,
            walls: MAPS[0].walls, scores: { red: 0, blue: 0 },
            flags: [], hill: null, wave: 1, zombiesLeft: 0
        };
        this.resetGame('FFA', 0);
    }

    resetGame(mode, mapIdx) {
        if(!MAPS[mapIdx]) mapIdx = 0;
        this.gameState.mode = mode;
        this.gameState.mapIndex = mapIdx;
        this.gameState.walls = MAPS[mapIdx].walls;
        this.gameState.scores = { red: 0, blue: 0 };
        this.gameState.timer = 180 * 60;
        this.gameState.phase = 'GAME';
        this.bullets = [];

        // Mode Setup
        this.gameState.hill = (mode === 'KOTH') ? { x:900, y:650, w:200, h:200 } : null;
        this.gameState.flags = (mode === 'CTF') ? [{ team:'RED', x:100, y:750, base:{x:100,y:750}, carrier:null }, { team:'BLUE', x:1900, y:750, base:{x:1900,y:750}, carrier:null }] : [];

        if(mode === 'ZOMBIES') {
            this.gameState.wave = 1;
            this.spawnZombies(5);
        }

        // Reset Players
        Object.values(this.players).forEach((p, i) => {
            if(p.type === 'zombie' || p.isDummy) { delete this.players[p.id]; return; }
            this.assignTeam(p, i);
            this.respawn(p);
        });

        io.to(this.id).emit('mapChange', { walls: this.gameState.walls, mode: this.gameState.mode });
    }

    assignTeam(p, index) {
        if (this.gameState.mode === 'ZOMBIES') {
            p.team = 'HUMAN'; p.color = '#4488FF'; p.lives = 3;
        } else if (this.gameState.mode !== 'FFA') {
            p.team = (index % 2 === 0) ? 'RED' : 'BLUE';
            p.color = (p.team === 'RED') ? '#ff4757' : '#4488FF';
        } else {
            p.team = 'FFA';
            p.color = (p.isOwner && p.godMode) ? '#FFD700' : '#4488FF';
        }
    }

    getSpawn(team) {
        let x, y, hit, attempts=0;
        do {
            if(this.gameState.mode === 'ZOMBIES' && team === 'ZOMBIE') {
                if(Math.random()>0.5) { x=(Math.random()>0.5?50:1950); y=Math.random()*1500; }
                else { x=Math.random()*2000; y=(Math.random()>0.5?50:1450); }
            }
            else if(this.gameState.mode === 'FFA' || this.gameState.mode === 'ZOMBIES') x = Math.random()*1800+100;
            else if(team === 'RED') x = Math.random()*300+100;
            else x = Math.random()*300+1600;
            
            if(team !== 'ZOMBIE') y = Math.random()*1300+100; 
            hit = this.gameState.walls.some(w => x<w.x+w.w && x+40>w.x && y<w.y+w.h && y+40>w.y);
            attempts++;
        } while(hit && attempts<100);
        return {x,y};
    }

    spawnZombies(count) {
        for(let i=0; i<count; i++) {
            let id = 'z_'+Math.random();
            let s = this.getSpawn('ZOMBIE');
            let hp = 50 + (this.gameState.wave * 10);
            this.players[id] = {
                id:id, username:`Zombie`, type:'zombie', team:'ZOMBIE',
                x:s.x, y:s.y, vx:0, vy:0, w:40, h:40, angle:0,
                hp:hp, maxHp:hp, speed:0.5 + (this.gameState.wave * 0.05), color:'#55aa55',
                grapple:{active:false}, hat:'none'
            };
        }
    }

    respawn(p) {
        if(this.gameState.mode === 'ZOMBIES' && p.lives <= 0) { p.dead = true; p.x = -1000; return; }
        p.dead = false;
        let s = this.getSpawn(p.team); p.x=s.x; p.y=s.y;
        let k = (p.isOwner && p.godMode) ? GOD_KIT : p.selectedKit;
        p.hp=k.hp; p.maxHp=k.hp; p.speed=k.speed; p.kit=k; 
        p.ammo=k.weapon.ammo; p.maxAmmo=k.weapon.ammo; 
        p.reloading=false; p.vx=0; p.vy=0;
    }
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('login', (d) => {
        let acc = userDB[d.user];
        if(!acc || acc.pass !== d.pass) return socket.emit('authMsg',{s:false,m:"Fail"});
        finishAuth(socket, d, acc, true);
    });

    socket.on('guest', (d) => {
        finishAuth(socket, d, { money:0, xp:0, items:[] }, false);
    });

    socket.on('signup', (d) => {
        if(userDB[d.user]) return socket.emit('authMsg',{s:false,m:"Taken"});
        userDB[d.user] = { pass:d.pass, email:d.email, money:0, xp:0, items:[] };
        saveDB(); socket.emit('authMsg',{s:true,m:"Created"});
    });

    function finishAuth(s, d, acc, isLogin) {
        let isOwner = acc.email === 'raidenrmarks12@gmail.com';
        currentUser = {
            id: s.id,
            username: isLogin ? d.user : "Guest"+Math.floor(Math.random()*9999),
            selectedKit: KITS[d.kit] || KITS.assault,
            money: acc.money, xp: acc.xp, level: getLevel(acc.xp), items: acc.items || [],
            isOwner: isOwner, godMode: isOwner
        };
        s.emit('authSuccess', { isOwner });
    }

    // --- LOBBY ACTIONS ---
    socket.on('createLobby', () => {
        if(!currentUser) return;
        let lobbyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        lobbies[lobbyId] = new Lobby(lobbyId, socket.id);
        joinLobby(socket, lobbyId);
    });

    socket.on('joinLobby', (lobbyId) => {
        if(!currentUser) return;
        lobbyId = lobbyId.toUpperCase();
        if(lobbies[lobbyId]) joinLobby(socket, lobbyId);
        else socket.emit('authMsg', {s:false, m:"Lobby Not Found"});
    });

    function joinLobby(s, lobbyId) {
        let lobby = lobbies[lobbyId];
        socketLobbyMap[s.id] = lobbyId;
        s.join(lobbyId);

        let p = {
            ...currentUser,
            id: s.id, team: 'FFA', x:0, y:0, vx:0, vy:0, w:40, h:40, angle:0,
            kit: currentUser.selectedKit, hp:100, maxHp:100, speed:1,
            color: currentUser.isOwner?'#FFD700':'#4488FF',
            ammo:0, maxAmmo:0, reloading:false, reloadTimer:0, shootTimer:0, dashTimer:0,
            grapple:{active:false}, score:0, type:'player', dead:false, lives:3
        };
        
        lobby.players[s.id] = p;
        lobby.assignTeam(p, Object.keys(lobby.players).length);
        lobby.respawn(p);

        s.emit('startGame', { id: s.id, isOwner: currentUser.isOwner, walls: lobby.gameState.walls, lobbyId: lobbyId });
        io.to(lobbyId).emit('chatMsg', { user:'[SYSTEM]', text:`${p.username} joined!`, color:'lime' });
    }

    // --- GAME INPUT ---
    socket.on('input', (d) => {
        let lid = socketLobbyMap[socket.id];
        if(!lid || !lobbies[lid]) return;
        let p = lobbies[lid].players[socket.id];
        if(!p) return;

        if(p.dead) { p.x = d.gx; p.y = d.gy; return; }

        p.angle = d.angle;
        let spd = p.speed * (d.dash && p.dashTimer<=0 ? 25 : 0.8);
        if(d.dash && p.dashTimer<=0) p.dashTimer=90;
        if(d.up) p.vy-=spd; if(d.down) p.vy+=spd; if(d.left) p.vx-=spd; if(d.right) p.vx+=spd;

        if(p.reloadTimer > 0) { p.reloadTimer--; if(p.reloadTimer<=0) { p.ammo=p.maxAmmo; p.reloading=false; } } 
        else if(d.shoot && p.shootTimer<=0) {
            if(p.ammo>0) {
                p.shootTimer = p.kit.weapon.cooldown; p.ammo--;
                let cnt = p.kit.weapon.count||1;
                for(let i=0;i<cnt;i++) { 
                    let a = p.angle + (Math.random()-0.5)*(p.kit.weapon.spread||0); 
                    lobbies[lid].bullets.push({x:p.x+20,y:p.y+20,vx:Math.cos(a)*p.kit.weapon.speed,vy:Math.sin(a)*p.kit.weapon.speed,dmg:p.kit.weapon.damage,owner:socket.id,life:p.kit.weapon.range||100,color:p.color}); 
                }
            } else { p.reloading=true; p.reloadTimer=p.kit.weapon.reload; }
        }
        if(d.grapple && !p.grapple.active) { p.grapple.active=true; p.grapple.x=d.gx; p.grapple.y=d.gy; } else if(!d.grapple) p.grapple.active=false;
    });

    // --- CHAT COMMANDS ---
    socket.on('chat', (m) => {
        let lid = socketLobbyMap[socket.id];
        if(!lid || !lobbies[lid]) return;
        let p = lobbies[lid].players[socket.id];
        if(!p) return;

        // COMMANDS
        if(m.startsWith('/')) {
            let args = m.split(' ');
            let cmd = args[0].toLowerCase();
            let isHost = (lobbies[lid].hostId === socket.id) || p.isOwner;

            if(cmd === '/help') {
                socket.emit('chatMsg', {user:'[HELP]', text:'Commands: /kick <name>, /map <arena/maze>, /mode <ffa/koth/ctf>, /size <10-100>', color:'gold'});
            }
            else if(cmd === '/kick' && isHost) {
                let targetName = args[1];
                let targetId = Object.keys(lobbies[lid].players).find(k => lobbies[lid].players[k].username === targetName);
                if(targetId) {
                    io.to(targetId).emit('disconnect'); // Force disconnect logic handled by client refresh
                    delete lobbies[lid].players[targetId];
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${targetName} was kicked.`, color:'red'});
                }
            }
            else if(cmd === '/map' && isHost) {
                let mapName = args[1]?.toLowerCase();
                let idx = (mapName === 'maze') ? 1 : 0;
                lobbies[lid].resetGame(lobbies[lid].gameState.mode, idx);
                io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`Map changed to ${MAPS[idx].name}`, color:'cyan'});
            }
            else if(cmd === '/mode' && isHost) {
                let mode = args[1]?.toUpperCase();
                if(['FFA','KOTH','CTF','ZOMBIES'].includes(mode)) {
                    lobbies[lid].resetGame(mode, lobbies[lid].gameState.mapIndex);
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`Mode changed to ${mode}`, color:'cyan'});
                }
            }
            else if(cmd === '/size') {
                let size = parseInt(args[1]);
                if(size >= 10 && size <= 100) {
                    p.w = size; p.h = size;
                    io.to(lid).emit('chatMsg', {user:'[PLUGIN]', text:`You resized to ${size}px`, color:'pink'});
                }
            }
            return;
        }

        io.to(lid).emit('chatMsg', { user:`[Lvl ${p.level}] ${p.username}`, text:m.substring(0,60), color:p.color });
    });

    socket.on('disconnect', () => {
        let lid = socketLobbyMap[socket.id];
        if(lid && lobbies[lid]) {
            delete lobbies[lid].players[socket.id];
            delete socketLobbyMap[socket.id];
            // If lobby empty, delete it
            if(Object.keys(lobbies[lid].players).length === 0) delete lobbies[lid];
        }
    });
});

// --- MAIN GAME LOOP (Handles ALL Lobbies) ---
setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
        updateLobby(lobby);
        io.to(lobby.id).emit('state', { players: lobby.players, bullets: lobby.bullets, game: lobby.gameState });
    });
}, 1000/60);

function updateLobby(g) {
    // 1. ZOMBIE LOGIC
    if(g.gameState.mode === 'ZOMBIES') {
        let activeZombies = Object.values(g.players).filter(p => p.type === 'zombie');
        if(activeZombies.length === 0) {
            g.gameState.wave++;
            io.to(g.id).emit('chatMsg', { user: '[SYSTEM]', text: `WAVE ${g.gameState.wave} STARTED!`, color: 'red' });
            g.spawnZombies(5 + (g.gameState.wave * 2));
        }
        activeZombies.forEach(z => {
            let target = null, minDist = 9999;
            for(let id in g.players) {
                let p = g.players[id];
                if(p.type === 'player' && !p.dead) {
                    let d = Math.hypot(p.x - z.x, p.y - z.y);
                    if(d < minDist) { minDist = d; target = p; }
                }
            }
            if(target) {
                let angle = Math.atan2(target.y - z.y, target.x - z.x);
                z.angle = angle;
                z.vx += Math.cos(angle) * (z.speed * 0.2);
                z.vy += Math.sin(angle) * (z.speed * 0.2);
                if(minDist < 40) {
                    target.hp -= 2; 
                    if(target.hp <= 0) handleDeath(g, target, z);
                }
            }
        });
    }

    // 2. PHYSICS
    for(let id in g.players) {
        let p = g.players[id];
        p.x+=p.vx; p.y+=p.vy; p.vx*=0.9; p.vy*=0.9;
        
        if(p.type === 'player' && !p.dead) { 
            if(p.dashTimer>0) p.dashTimer--; if(p.shootTimer>0) p.shootTimer--; 
            if(p.grapple.active) { p.vx+=(p.grapple.x-(p.x+20))*0.002; p.vy+=(p.grapple.y-(p.y+20))*0.002; } 
        }
        
        if(!p.dead) {
            g.gameState.walls.forEach(w=>{ if(p.x<w.x+w.w && p.x+p.w>w.x && p.y<w.y+w.h && p.y+p.h>w.y) { p.x-=p.vx*1.2; p.y-=p.vy*1.2; p.vx=0; p.vy=0; } });
        }
    }

    // 3. BULLETS
    for(let i=g.bullets.length-1; i>=0; i--) {
        let b=g.bullets[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        let hit = g.gameState.walls.some(w=>b.x>w.x && b.x<w.x+w.w && b.y>w.y && b.y<w.y+w.h);
        let s = g.players[b.owner]; 
        if(!s) { g.bullets.splice(i,1); continue; }

        if(!hit) {
            for(let id in g.players) {
                let p = g.players[id];
                if(p.dead) continue; 
                let canHit = (g.gameState.mode === 'FFA' || (g.gameState.mode === 'ZOMBIES' && s.type !== p.type) || p.team !== s.team) && b.owner !== id;
                if(canHit && b.x>p.x && b.x<p.x+p.w && b.y>p.y && b.y<p.y+p.h) {
                    p.hp-=b.dmg; hit=true;
                    if(p.hp<=0) handleDeath(g, p, s);
                }
            }
        }
        if(hit || b.life<=0) g.bullets.splice(i,1);
    }
}

function handleDeath(lobby, victim, killer) {
    if(killer && killer.type === 'player') { 
        killer.score+=10; killer.money+=25; killer.xp+=50; killer.level=getLevel(killer.xp); 
        if(userDB[killer.username]) { userDB[killer.username].money=killer.money; userDB[killer.username].xp=killer.xp; saveDB(); } 
    }
    
    if(victim.type === 'zombie' || victim.isDummy) {
        delete lobby.players[victim.id];
    } else {
        if(lobby.gameState.mode === 'ZOMBIES') {
            victim.lives--;
            if(victim.lives <= 0) {
                victim.dead = true; 
                io.to(lobby.id).emit('chatMsg', { user: '[SYSTEM]', text: `${victim.username} is out!`, color: 'red' });
            } else {
                lobby.respawn(victim);
            }
        } else {
            lobby.respawn(victim);
        }
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server on ${PORT}`));
