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
    { name: 'Maze', walls: [{x:400,y:0,w:50,h:1000}, {x:800,y:500,w:50,h:1000}, {x:1200,y:0,w:50,h:1000}, {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] },
    { name: 'Towers', walls: [{x:400,y:400,w:200,h:200}, {x:1400,y:400,w:200,h:200}, {x:400,y:900,w:200,h:200}, {x:1400,y:900,w:200,h:200}, {x:900,y:650,w:200,h:200}, {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] },
    { name: 'Open Field', walls: [{x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] }
];

const KITS = {
    assault: { name: 'Soldier', hp: 120, speed: 1.0, weapon: { damage: 12, speed: 22, cooldown: 8, ammo: 30, reload: 120, spread: 0.05, range: 80 } },
    shotgun: { name: 'Breacher', hp: 160, speed: 0.9, weapon: { damage: 9, speed: 18, cooldown: 55, ammo: 5, reload: 150, count: 6, spread: 0.3, range: 40 } },
    sniper: { name: 'Recon', hp: 80, speed: 1.1, weapon: { damage: 95, speed: 45, cooldown: 80, ammo: 3, reload: 180, spread: 0.0, range: 200 } },
    tank: { name: 'Heavy', hp: 300, speed: 0.7, weapon: { damage: 8, speed: 20, cooldown: 5, ammo: 100, reload: 300, spread: 0.15, range: 70 } },
    ninja: { name: 'Ninja', hp: 90, speed: 1.3, weapon: { damage: 25, speed: 30, cooldown: 15, ammo: 10, reload: 60, spread: 0.02, range: 50 } }
};

const SHOP_ITEMS = {
    'tophat': { name: 'Top Hat', price: 500, type: 'hat' },
    'crown': { name: 'Gold Crown', price: 5000, type: 'hat' },
    'halo': { name: 'Angel Halo', price: 2500, type: 'hat' },
    'red_glow': { name: 'Red Glow', price: 1000, type: 'color', value: '#ff0000' }
};

const GOD_KIT = { name:'ADMIN', hp:99999, speed:1.5, weapon:{damage:99999,speed:40,cooldown:2,ammo:999,reload:0,range:1000}};

// --- DATABASE ---
let userDB = {};
if(fs.existsSync(DB_FILE)) try { userDB=JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){}
function saveDB(){ fs.writeFileSync(DB_FILE,JSON.stringify(userDB)); }
function getLevel(xp) { return Math.floor(Math.sqrt(xp/100))+1; }

const lobbies = {}; 
const socketLobbyMap = {}; 

class Lobby {
    constructor(id, hostId, settings) {
        this.id = id;
        this.hostId = hostId;
        this.name = settings.name || `Lobby ${id}`;
        this.isPublic = settings.isPublic;
        this.players = {};
        this.bullets = [];
        this.mods = [hostId]; // Host is local mod
        this.gameState = {
            phase: 'GAME', timer: 180 * 60, mode: 'FFA', mapIndex: 0,
            walls: MAPS[0].walls, scores: { red: 0, blue: 0 },
            flags: [], hill: null, wave: 1, zombiesLeft: 0, juggernautId: null
        };
        let initialMode = settings.mode || 'FFA';
        let initialMap = parseInt(settings.map) || 0;
        this.resetGame(initialMode, initialMap);
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
        this.gameState.hill = (mode === 'KOTH') ? { x:900, y:650, w:200, h:200 } : null;
        this.gameState.juggernautId = null;
        
        if(mode === 'JUGGERNAUT') {
            const pIds = Object.keys(this.players);
            if(pIds.length > 0) this.gameState.juggernautId = pIds[Math.floor(Math.random() * pIds.length)];
        }
        if(mode === 'ZOMBIES') {
            this.gameState.wave = 1;
            this.spawnZombies(5);
        }

        Object.values(this.players).forEach((p, i) => {
            if(p.type === 'zombie' || p.isDummy) { delete this.players[p.id]; return; }
            this.assignTeam(p, i);
            this.respawn(p);
        });

        io.to(this.id).emit('mapChange', { walls: this.gameState.walls, mode: this.gameState.mode });
    }

    assignTeam(p, index) {
        if(this.gameState.mode === 'JUGGERNAUT') {
            if(p.id === this.gameState.juggernautId) { p.team = 'JUGGERNAUT'; p.color = '#800080'; } 
            else { p.team = 'HUNTER'; p.color = '#4488FF'; }
            return;
        }
        if (this.gameState.mode === 'ZOMBIES') { p.team = 'HUMAN'; p.color = '#4488FF'; p.lives = 3; } 
        else if (this.gameState.mode === 'TDM' || this.gameState.mode === 'CTF') {
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
            else if(this.gameState.mode === 'FFA' || this.gameState.mode === 'ZOMBIES' || this.gameState.mode === 'JUGGERNAUT') x = Math.random()*1800+100;
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
        if(this.gameState.mode === 'JUGGERNAUT' && p.team === 'JUGGERNAUT') { p.maxHp = 2000; p.hp = 2000; p.speed = 1.1; }
        p.ammo=k.weapon.ammo; p.maxAmmo=k.weapon.ammo; p.reloading=false; p.vx=0; p.vy=0;
    }
}

io.on('connection', (socket) => {
    let currentUser = null;

    const syncData = (p) => {
        if (p.isGuest) return;
        if (userDB[p.username]) {
            userDB[p.username].money = p.money;
            userDB[p.username].xp = p.xp;
            userDB[p.username].items = p.items;
            userDB[p.username].equippedHat = p.equippedHat;
            saveDB();
        }
    };

    socket.on('login', (d) => {
        let acc = userDB[d.user];
        if(!acc) return socket.emit('authMsg',{s:false,m:"User not found"});
        if(acc.banned) return socket.emit('authMsg',{s:false,m:"ACCOUNT BANNED"});
        if(acc.pass !== d.pass) return socket.emit('authMsg',{s:false,m:"Wrong Password"});
        finishAuth(socket, d, acc, true);
    });

    socket.on('guest', (d) => { finishAuth(socket, d, { money:0, xp:0, items:[] }, false); });
    socket.on('signup', (d) => {
        if(userDB[d.user]) return socket.emit('authMsg',{s:false,m:"Taken"});
        userDB[d.user] = { pass:d.pass, email:d.email, money:0, xp:0, items:[], banned: false, isStaff: false };
        saveDB(); socket.emit('authMsg',{s:true,m:"Created"});
    });

    function finishAuth(s, d, acc, isLogin) {
        let isOwner = acc.email === 'raidenrmarks12@gmail.com';
        let isStaff = acc.isStaff === true; // Check DB for Global Staff status

        currentUser = {
            id: s.id,
            username: isLogin ? d.user : "Guest"+Math.floor(Math.random()*9999),
            pass: d.pass, 
            selectedKit: KITS.assault,
            money: acc.money, xp: acc.xp, level: getLevel(acc.xp), 
            items: acc.items || [], 
            equippedHat: acc.equippedHat || 'none',
            isOwner: isOwner, 
            isStaff: isStaff,
            godMode: isOwner, 
            isGuest: !isLogin
        };
        s.emit('authSuccess', { isOwner, isStaff, user: currentUser.username, pass: currentUser.pass, money: currentUser.money, items: currentUser.items, equippedHat: currentUser.equippedHat });
        sendLobbyList(s);
    }

    // --- CHAT COMMANDS ENGINE ---
    socket.on('chat', (m) => {
        let lid = socketLobbyMap[socket.id]; if(!lid || !lobbies[lid]) return;
        let lobby = lobbies[lid];
        let p = lobby.players[socket.id];
        if(!p) return;

        let isGlobalOwner = p.isOwner;
        let isGlobalStaff = p.isStaff || isGlobalOwner; // Staff includes Owner
        let isLobbyHost = (lobby.hostId === socket.id);
        let isLobbyMod = lobby.mods.includes(socket.id);
        
        let hasAuth = isGlobalStaff || isLobbyHost || isLobbyMod;

        // Command Parser
        if(m.startsWith('/')) {
            let args = m.split(' ');
            let cmd = args[0].toLowerCase();
            let arg1 = args[1];
            let arg2 = args[2];

            // --- OWNER COMMANDS (Global) ---
            if(cmd === '/makestaff' && isGlobalOwner) {
                let targetName = arg1;
                if(userDB[targetName]) {
                    userDB[targetName].isStaff = true;
                    saveDB();
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${targetName} promoted to Global Staff!`, color:'gold'});
                } else { socket.emit('chatMsg', {user:'[ERR]', text:'User not found in DB', color:'red'}); }
            }
            else if(cmd === '/removestaff' && isGlobalOwner) {
                let targetName = arg1;
                if(userDB[targetName]) {
                    userDB[targetName].isStaff = false;
                    saveDB();
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${targetName} demoted from Staff.`, color:'orange'});
                }
            }
            else if(cmd === '/givecp' && isGlobalOwner) {
                let amount = parseInt(arg1) || 1000;
                let targetName = arg2 || p.username;
                let t = Object.values(lobby.players).find(u => u.username === targetName);
                if(t) {
                    t.money += amount;
                    if(t.id === socket.id) syncData(t); 
                    io.to(t.id).emit('shopUpdate', { money: t.money, items: t.items });
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`Gave ${amount} CP to ${t.username}`, color:'gold'});
                }
            }

            // --- STAFF COMMANDS (Global) ---
            else if(cmd === '/ban' && isGlobalStaff) {
                let tId = Object.keys(lobby.players).find(k => lobby.players[k].username === arg1);
                if(tId) {
                    if(lobby.players[tId].isOwner) return socket.emit('chatMsg', {user:'[ERR]', text:'Cannot ban Owner!', color:'red'});
                    if(userDB[arg1]) { userDB[arg1].banned = true; saveDB(); }
                    io.to(tId).emit('authMsg', {s:false, m:"YOU ARE BANNED"});
                    io.to(tId).emit('disconnect');
                    delete lobby.players[tId];
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${arg1} was BANNED by Staff.`, color:'red'});
                } else if(userDB[arg1]) {
                    userDB[arg1].banned = true; saveDB();
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${arg1} was BANNED offline.`, color:'red'});
                }
            }
            else if(cmd === '/unban' && isGlobalStaff) {
                if(userDB[arg1]) { userDB[arg1].banned = false; saveDB(); io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${arg1} unbanned.`, color:'lime'}); }
            }

            // --- LOBBY COMMANDS (Host & Mods) ---
            else if(cmd === '/kick' && hasAuth) {
                let tId = Object.keys(lobby.players).find(k => lobby.players[k].username === arg1);
                if(tId) {
                    let target = lobby.players[tId];
                    // Hierarchy Protection: Mod cannot kick Host/Staff. Host cannot kick Staff.
                    if(target.isOwner || target.isStaff) return socket.emit('chatMsg', {user:'[ERR]', text:'Cannot kick Global Staff!', color:'red'});
                    if(lobby.hostId === tId && !isGlobalStaff) return socket.emit('chatMsg', {user:'[ERR]', text:'Cannot kick Host!', color:'red'});
                    
                    io.to(tId).emit('disconnect');
                    delete lobby.players[tId];
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${target.username} was kicked.`, color:'orange'});
                }
            }
            else if(cmd === '/mod' && (isGlobalStaff || isLobbyHost)) {
                let t = Object.values(lobby.players).find(u => u.username === arg1);
                if(t && !lobby.mods.includes(t.id)) { 
                    lobby.mods.push(t.id); 
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${t.username} is now Lobby Staff`, color:'cyan'}); 
                }
            }
            else if(cmd === '/unmod' && (isGlobalStaff || isLobbyHost)) {
                let tId = Object.keys(lobby.players).find(k => lobby.players[k].username === arg1);
                if(tId) { 
                    lobby.mods = lobby.mods.filter(m => m !== tId); 
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`${arg1} removed from Lobby Staff.`, color:'orange'}); 
                }
            }
            else if(cmd === '/map' && hasAuth) {
                let idx = 0;
                let name = arg1?.toLowerCase();
                if(name === 'maze') idx=1; else if(name === 'towers') idx=2; else if(name === 'open') idx=3;
                lobby.resetGame(lobby.gameState.mode, idx);
                io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`Map changed to ${MAPS[idx].name}`, color:'cyan'});
            }
            else if(cmd === '/mode' && hasAuth) {
                let m = arg1?.toUpperCase();
                if(['FFA','KOTH','TDM','ZOMBIES','JUGGERNAUT'].includes(m)) {
                    lobby.resetGame(m, lobby.gameState.mapIndex);
                    io.to(lid).emit('chatMsg', {user:'[SYSTEM]', text:`Mode set to ${m}`, color:'cyan'});
                }
            }
            else if(cmd === '/tp' && hasAuth) {
                let t = Object.values(lobby.players).find(u => u.username === arg1);
                if(t) { p.x = t.x; p.y = t.y; socket.emit('chatMsg', {user:'[SYS]', text:`Teleported.`, color:'lime'}); }
            }
            else if(cmd === '/god' && hasAuth) {
                p.godMode = !p.godMode;
                p.color = p.godMode ? '#FFD700' : '#4488FF';
                socket.emit('chatMsg', {user:'[SYS]', text:`God Mode: ${p.godMode}`, color:'gold'});
            }
            else if(cmd === '/help') {
                socket.emit('chatMsg', {user:'[HELP]', text:'Owner: /makestaff. Staff: /ban. Host/LobbyStaff: /kick, /map, /mode.', color:'gold'});
            }
            
            return; 
        }

        // --- CHAT TAG LOGIC ---
        if(p.muted) return;
        
        let tag = "";
        let color = "white";
        
        if (p.isOwner) { 
            tag = "[OWNER] "; color = "#FFD700"; // Gold
        } else if (p.isStaff) {
            tag = "[STAFF] "; color = "cyan"; // Cyan
        } else if (lobby.hostId === socket.id) { 
            tag = "[HOST] "; color = "#ff4757"; // Red
        } else if (lobby.mods.includes(socket.id)) { 
            tag = "[LOBBY STAFF] "; color = "#00b894"; // Green
        } else { 
            tag = `[Lvl ${p.level}] `; 
        }

        io.to(lid).emit('chatMsg', { 
            user: `${tag}${p.username}`, 
            text: m.substring(0, 100), 
            color: p.color,
            nameColor: color 
        });
    });

    // --- OTHER SOCKET EVENTS (Buy, Equip, etc) ---
    socket.on('buy', (itemId) => {
        if(!currentUser || !SHOP_ITEMS[itemId]) return;
        let item = SHOP_ITEMS[itemId];
        if(currentUser.money >= item.price && !currentUser.items.includes(itemId)) {
            currentUser.money -= item.price;
            currentUser.items.push(itemId);
            syncData(currentUser);
            socket.emit('shopUpdate', { money: currentUser.money, items: currentUser.items });
            socket.emit('shopMsg', { s:true, m: "Bought " + item.name });
        } else if (currentUser.items.includes(itemId)) {
            socket.emit('shopMsg', { s:false, m: "Already owned!" });
        } else {
            socket.emit('shopMsg', { s:false, m: "Not enough CP!" });
        }
    });

    socket.on('equip', (itemId) => {
        if(!currentUser || !currentUser.items.includes(itemId) && itemId !== 'none') return;
        currentUser.equippedHat = itemId;
        syncData(currentUser);
        socket.emit('shopMsg', { s:true, m: "Equipped!" });
    });

    socket.on('requestLobbies', () => sendLobbyList(socket));
    function sendLobbyList(s) {
        let list = Object.values(lobbies).filter(l => l.isPublic).map(l => ({ id: l.id, name: l.name, mode: l.gameState.mode, map: MAPS[l.gameState.mapIndex].name, count: Object.keys(l.players).length }));
        s.emit('lobbyList', list);
    }

    socket.on('createLobby', (settings) => {
        if(!currentUser) return;
        let lobbyId = Math.random().toString(36).substring(2, 6).toUpperCase();
        lobbies[lobbyId] = new Lobby(lobbyId, socket.id, settings);
        joinLobby(socket, lobbyId);
        io.emit('lobbyUpdate'); 
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
            kit: KITS.assault, hp:100, maxHp:100, speed:1,
            color: currentUser.isOwner?'#FFD700':'#4488FF',
            ammo:0, maxAmmo:0, reloading:false, reloadTimer:0, shootTimer:0, dashTimer:0,
            grapple:{active:false}, score:0, type:'player', dead:true, lives:3, hat: currentUser.equippedHat 
        };
        
        lobby.players[s.id] = p;
        lobby.assignTeam(p, Object.keys(lobby.players).length);
        s.emit('startGame', { id: s.id, isOwner: currentUser.isOwner, isStaff: currentUser.isStaff, walls: lobby.gameState.walls, lobbyId: lobbyId, mode: lobby.gameState.mode, isHost: lobby.hostId === s.id });
        io.to(lobbyId).emit('chatMsg', { user:'[SYSTEM]', text:`${p.username} joined!`, color:'lime' });
        io.emit('lobbyUpdate');
    }

    socket.on('requestSpawn', (kitName) => {
        let lid = socketLobbyMap[socket.id]; if(!lid || !lobbies[lid]) return;
        let lobby = lobbies[lid];
        let p = lobby.players[socket.id];
        if(p && p.dead) {
            if(KITS[kitName]) p.selectedKit = KITS[kitName];
            lobby.respawn(p);
        }
    });

    socket.on('input', (d) => {
        let lid = socketLobbyMap[socket.id]; if(!lid || !lobbies[lid]) return;
        let p = lobbies[lid].players[socket.id]; if(!p || p.dead) { if(p&&p.dead){p.x=d.gx; p.y=d.gy;} return; }
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

    socket.on('disconnect', () => {
        let lid = socketLobbyMap[socket.id];
        if(lid && lobbies[lid]) {
            delete lobbies[lid].players[socket.id]; delete socketLobbyMap[socket.id];
            if(Object.keys(lobbies[lid].players).length === 0) delete lobbies[lid];
            io.emit('lobbyUpdate'); 
        }
    });
    socket.on('syncReq', () => { if(currentUser) syncData(currentUser); });
    socket.on('staffAction', (data) => {
        let lid = socketLobbyMap[socket.id]; if(!lid||!lobbies[lid]) return;
        let lobby = lobbies[lid];
        let p = lobby.players[socket.id];
        
        let hasAuth = p.isOwner || p.isStaff || lobby.hostId === socket.id || lobby.mods.includes(socket.id);
        
        if(hasAuth) {
            if(data.type==='toggleGod') { p.godMode=!p.godMode; p.color=p.godMode?'#FFD700':'#4488FF'; lobbies[lid].respawn(p); }
            if(data.type==='spawnDummy') { let id='d_'+Math.random(); let s=lobbies[lid].getSpawn('FFA'); lobbies[lid].players[id]={id:id,username:"Dummy",isDummy:true,x:s.x,y:s.y,vx:0,vy:0,w:40,h:40,hp:100,maxHp:100,color:'#888',grapple:{active:false},team:'FFA',score:0,level:0,hat:'none',type:'player',angle:0}; }
            if(data.type==='clearDummies') { for(let id in lobbies[lid].players) if(lobbies[lid].players[id].isDummy) delete lobbies[lid].players[id]; }
            if(data.type==='skipRound') { lobby.gameState.timer = 1; io.to(lid).emit('chatMsg', { user: '[SYSTEM]', text: 'Round Skipped', color: 'gold' }); }
            if(data.type==='giveCP' && p.isOwner) { currentUser.money += 1000; syncData(currentUser); socket.emit('authSuccess', {isOwner:true, isStaff:true, user:p.username, pass:null, money:currentUser.money, items:currentUser.items, equippedHat:currentUser.equippedHat}); }
        }
    });
});

setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
        updateLobby(lobby);
        io.to(lobby.id).emit('state', { players: lobby.players, bullets: lobby.bullets, game: lobby.gameState });
    });
}, 1000/60);

function updateLobby(g) {
    if(g.gameState.mode === 'KOTH' && g.gameState.hill) {
        let r=0, b=0;
        Object.values(g.players).forEach(p => { if(!p.dead && p.x>g.gameState.hill.x && p.x<g.gameState.hill.x+g.gameState.hill.w && p.y>g.gameState.hill.y && p.y<g.gameState.hill.y+g.gameState.hill.h) { if(p.team === 'RED') r++; else if(p.team === 'BLUE') b++; } });
        if(r>b) g.gameState.scores.red++; else if(b>r) g.gameState.scores.blue++;
    }
    if(g.gameState.mode === 'ZOMBIES') {
        let activeZombies = Object.values(g.players).filter(p => p.type === 'zombie');
        if(activeZombies.length === 0) { g.gameState.wave++; io.to(g.id).emit('chatMsg', { user: '[SYSTEM]', text: `WAVE ${g.gameState.wave} STARTED!`, color: 'red' }); g.spawnZombies(5 + (g.gameState.wave * 2)); }
        activeZombies.forEach(z => {
            let target = null, minDist = 9999;
            for(let id in g.players) { let p = g.players[id]; if(p.type === 'player' && !p.dead) { let d = Math.hypot(p.x - z.x, p.y - z.y); if(d < minDist) { minDist = d; target = p; } } }
            if(target) {
                let angle = Math.atan2(target.y - z.y, target.x - z.x); z.angle = angle;
                z.vx += Math.cos(angle) * (z.speed * 0.2); z.vy += Math.sin(angle) * (z.speed * 0.2);
                if(minDist < 40) { target.hp -= 2; if(target.hp <= 0) handleDeath(g, target, z); }
            }
        });
    }
    for(let id in g.players) {
        let p = g.players[id]; p.x+=p.vx; p.y+=p.vy; p.vx*=0.9; p.vy*=0.9;
        if(p.type === 'player' && !p.dead) { 
            if(p.dashTimer>0) p.dashTimer--; if(p.shootTimer>0) p.shootTimer--; 
            if(p.grapple.active) { p.vx+=(p.grapple.x-(p.x+20))*0.004; p.vy+=(p.grapple.y-(p.y+20))*0.004; } 
        }
        if(!p.dead) g.gameState.walls.forEach(w=>{ if(p.x<w.x+w.w && p.x+p.w>w.x && p.y<w.y+w.h && p.y+p.h>w.y) { p.x-=p.vx*1.2; p.y-=p.vy*1.2; p.vx=0; p.vy=0; } });
    }
    for(let i=g.bullets.length-1; i>=0; i--) {
        let b=g.bullets[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        let hit = g.gameState.walls.some(w=>b.x>w.x && b.x<w.x+w.w && b.y>w.y && b.y<w.y+w.h);
        let s = g.players[b.owner]; if(!s) { g.bullets.splice(i,1); continue; }
        if(!hit) {
            for(let id in g.players) {
                let p = g.players[id]; if(p.dead) continue;
                let canHit = (g.gameState.mode === 'FFA' || (g.gameState.mode === 'ZOMBIES' && s.type !== p.type) || (g.gameState.mode !== 'FFA' && p.team !== s.team)) && b.owner !== id;
                if(canHit && b.x>p.x && b.x<p.x+p.w && b.y>p.y && b.y<p.y+p.h) { p.hp-=b.dmg; hit=true; if(p.hp<=0) handleDeath(g, p, s); }
            }
        }
        if(hit || b.life<=0) g.bullets.splice(i,1);
    }
}

function handleDeath(lobby, victim, killer) {
    if(killer && killer.type === 'player') { killer.score+=10; killer.money+=25; killer.xp+=50; killer.level=getLevel(killer.xp); if(userDB[killer.username]) { userDB[killer.username].money=killer.money; userDB[killer.username].xp=killer.xp; saveDB(); } }
    if(victim.type === 'zombie' || victim.isDummy) delete lobby.players[victim.id];
    else { 
        if(lobby.gameState.mode === 'ZOMBIES') { 
            victim.lives--; 
            if(victim.lives <= 0) { victim.dead = true; io.to(lobby.id).emit('chatMsg', { user: '[SYSTEM]', text: `${victim.username} is out!`, color: 'red' }); } 
            else victim.dead = true; 
        } 
        else {
            victim.dead = true; 
        }
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server on ${PORT}`));
