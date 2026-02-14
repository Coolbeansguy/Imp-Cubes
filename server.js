const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const crypto = require('crypto');

app.use(express.static('public'));

// --- CONSTANTS ---
const DB_FILE = 'database.json';
const SALT = 'imp-cubes-salt-2026'; // Change this to something unique & secret

const MAPS = [
    { name: 'Arena', walls: [{x:300,y:300,w:100,h:400}, {x:800,y:600,w:400,h:100}, {x:1200,y:200,w:200,h:200}, {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] },
    { name: 'Maze', walls: [{x:400,y:0,w:50,h:1000}, {x:800,y:500,w:50,h:1000}, {x:1200,y:0,w:50,h:1000}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}] },
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
    'tophat':   { name: 'Top Hat',    price:  500, type: 'hat' },
    'crown':    { name: 'Gold Crown', price: 5000, type: 'hat' },
    'halo':     { name: 'Angel Halo', price: 2500, type: 'hat' },
    'red_glow': { name: 'Red Glow',   price: 1000, type: 'color', value: '#ff0000' }
};

const GOD_KIT = { name:'ADMIN', hp:5000, speed:1.5, weapon:{damage:5000,speed:40,cooldown:5,ammo:999,reload:0,range:500}};

let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));
}

function hashPassword(pass) {
    return crypto.createHash('sha256').update(pass + SALT).digest('hex');
}

function getLevel(xp) {
    return Math.floor(Math.sqrt(xp / 100)) + 1;
}

// --- LOBBY SYSTEM ---
const lobbies = {};
const socketLobbyMap = {};

class Lobby {
    constructor(id, hostId, settings) {
        this.id = id;
        this.hostId = hostId;
        this.name = settings.name || `Lobby ${id}`;
        this.isPublic = settings.isPublic !== false;
        this.players = {};
        this.bullets = [];
        this.mods = [hostId];
        this.gameState = {
            phase: 'GAME',
            timer: 180 * 60,
            mode: 'FFA',
            mapIndex: 0,
            walls: MAPS[0].walls,
            scores: { red: 0, blue: 0 },
            hill: null,
            wave: 1,
            zombiesLeft: 0,
            juggernautId: null
        };
        this.resetGame(settings.mode || 'FFA', parseInt(settings.map) || 0);
    }

    resetGame(mode, mapIdx) {
        if (!MAPS[mapIdx]) mapIdx = 0;
        this.gameState.mode = mode;
        this.gameState.mapIndex = mapIdx;
        this.gameState.walls = MAPS[mapIdx].walls;
        this.gameState.scores = { red: 0, blue: 0 };
        this.gameState.timer = 180 * 60;
        this.gameState.phase = 'GAME';
        this.bullets = [];
        this.gameState.hill = (mode === 'KOTH') ? { x:900, y:650, w:200, h:200 } : null;
        this.gameState.juggernautId = null;

        if (mode === 'JUGGERNAUT') {
            const pIds = Object.keys(this.players);
            if (pIds.length > 0) this.gameState.juggernautId = pIds[Math.floor(Math.random() * pIds.length)];
        }
        if (mode === 'ZOMBIES') {
            this.gameState.wave = 1;
            this.spawnZombies(5);
        }

        Object.values(this.players).forEach((p, i) => {
            if (p.type === 'zombie' || p.isDummy) { delete this.players[p.id]; return; }
            this.assignTeam(p, i);
            this.respawn(p);
        });

        io.to(this.id).emit('mapChange', { walls: this.gameState.walls, mode: this.gameState.mode });
    }

    assignTeam(p, index) {
        if (this.gameState.mode === 'JUGGERNAUT') {
            if (p.id === this.gameState.juggernautId) {
                p.team = 'JUGGERNAUT'; p.color = '#800080';
            } else {
                p.team = 'HUNTER'; p.color = '#4488FF';
            }
            return;
        }
        if (this.gameState.mode === 'ZOMBIES') {
            p.team = 'HUMAN'; p.color = '#4488FF'; p.lives = 3;
        } else if (this.gameState.mode === 'TDM') {
            p.team = (index % 2 === 0) ? 'RED' : 'BLUE';
            p.color = (p.team === 'RED') ? '#ff4757' : '#4488FF';
        } else {
            p.team = 'FFA';
            p.color = (p.isOwner && p.godMode) ? '#FFD700' : '#4488FF';
        }
    }

    getSpawn(team) {
        let x, y, hit, attempts = 0;
        do {
            if (this.gameState.mode === 'ZOMBIES' && team === 'ZOMBIE') {
                if (Math.random() > 0.5) { x = (Math.random() > 0.5 ? 50 : 1950); y = Math.random() * 1500; }
                else { x = Math.random() * 2000; y = (Math.random() > 0.5 ? 50 : 1450); }
            } else if (this.gameState.mode === 'FFA' || this.gameState.mode === 'ZOMBIES' || this.gameState.mode === 'JUGGERNAUT') {
                x = Math.random() * 1800 + 100;
            } else if (team === 'RED') {
                x = Math.random() * 300 + 100;
            } else {
                x = Math.random() * 300 + 1600;
            }
            if (team !== 'ZOMBIE') y = Math.random() * 1300 + 100;
            hit = this.gameState.walls.some(w => 
                x < w.x + w.w && x + 40 > w.x && y < w.y + w.h && y + 40 > w.y
            );
            attempts++;
        } while (hit && attempts < 120);
        return { x, y };
    }

    spawnZombies(count) {
        for (let i = 0; i < count; i++) {
            let id = 'z_' + Math.random().toString(36).slice(2, 9);
            let s = this.getSpawn('ZOMBIE');
            let hp = 50 + (this.gameState.wave * 12);
            this.players[id] = {
                id, username: `Zombie ${this.gameState.wave}-${i+1}`, type: 'zombie', team: 'ZOMBIE',
                x: s.x, y: s.y, vx: 0, vy: 0, w: 40, h: 40, angle: 0,
                hp, maxHp: hp, speed: 0.55 + (this.gameState.wave * 0.06), color: '#55aa55',
                grapple: { active: false }, hat: 'none'
            };
        }
    }

    respawn(p) {
        if (this.gameState.mode === 'ZOMBIES' && p.lives <= 0) {
            p.dead = true;
            p.x = -1000;
            return;
        }
        p.dead = true;
        p.respawnTimer = 180;           // 3 seconds @ 60 fps
        p.invulnTimer = 180;            // 3 seconds invulnerability after spawn
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
        if (!acc || acc.hash !== hashPassword(d.pass)) {
            return socket.emit('authMsg', { s: false, m: "Invalid username or password" });
        }
        finishAuth(socket, d, acc, true);
    });

    socket.on('signup', (d) => {
        if (userDB[d.user]) return socket.emit('authMsg', { s: false, m: "Username taken" });
        if (!d.user || !d.pass || d.user.length < 3 || d.pass.length < 5) {
            return socket.emit('authMsg', { s: false, m: "Invalid username/password" });
        }
        userDB[d.user] = {
            hash: hashPassword(d.pass),
            email: d.email || '',
            money: 0,
            xp: 0,
            items: []
        };
        saveDB();
        socket.emit('authMsg', { s: true, m: "Account created! You can now log in." });
    });

    function finishAuth(s, d, acc, isLogin) {
        let isOwner = acc.email === 'raidenrmarks12@gmail.com';
        currentUser = {
            id: s.id,
            username: isLogin ? d.user : "Guest" + Math.floor(Math.random() * 9999),
            selectedKit: KITS[d.kit] || KITS.assault,
            money: acc.money || 0,
            xp: acc.xp || 0,
            level: getLevel(acc.xp || 0),
            items: acc.items || [],
            equippedHat: acc.equippedHat || 'none',
            isOwner,
            godMode: isOwner,
            isGuest: !isLogin
        };
        s.emit('authSuccess', {
            isOwner,
            user: currentUser.username,
            money: currentUser.money,
            items: currentUser.items,
            equippedHat: currentUser.equippedHat
        });
        sendLobbyList(s);
    }

    // ... (shop, equip, createLobby, joinLobby, requestLobbies handlers remain mostly unchanged)

    socket.on('input', (d) => {
        let lid = socketLobbyMap[socket.id];
        if (!lid || !lobbies[lid]) return;
        let p = lobbies[lid].players[socket.id];
        if (!p || p.dead) return;

        p.angle = d.angle;

        // Basic movement validation
        let expectedSpeed = p.speed * (d.dash && p.dashTimer <= 0 ? 25 : 0.8);
        let moveDist = Math.hypot(d.up ? -expectedSpeed : (d.down ? expectedSpeed : 0),
                                  d.left ? -expectedSpeed : (d.right ? expectedSpeed : 0));
        if (moveDist > expectedSpeed * 1.4) {
            // Suspicious movement → reset velocity
            p.vx = p.vy = 0;
            return;
        }

        let spd = p.speed * (d.dash && p.dashTimer <= 0 ? 25 : 0.8);
        if (d.dash && p.dashTimer <= 0) p.dashTimer = 90;

        if (d.up)    p.vy -= spd;
        if (d.down)  p.vy += spd;
        if (d.left)  p.vx -= spd;
        if (d.right) p.vx += spd;

        // Shooting logic unchanged...

        // Grapple improved
        if (d.grapple && !p.grapple.active) {
            p.grapple.active = true;
            p.grapple.x = d.gx;
            p.grapple.y = d.gy;
        } else if (!d.grapple) {
            p.grapple.active = false;
        }
    });

    // ... (rest of your socket handlers: chat, disconnect, staffAction, etc.)

});

setInterval(() => {
    Object.values(lobbies).forEach(lobby => {
        updateLobby(lobby);
        io.to(lobby.id).emit('state', {
            players: lobby.players,
            bullets: lobby.bullets,
            game: lobby.gameState
        });
    });
}, 1000 / 60);

function updateLobby(g) {
    // ... existing KOTH scoring, etc.

    for (let id in g.players) {
        let p = g.players[id];

        if (p.respawnTimer > 0) {
            p.respawnTimer--;
            if (p.respawnTimer <= 0) {
                p.dead = false;
                let s = g.getSpawn(p.team);
                p.x = s.x; p.y = s.y;
                let k = (p.isOwner && p.godMode) ? GOD_KIT : p.selectedKit;
                p.hp = k.hp; p.maxHp = k.hp; p.speed = k.speed; p.kit = k;
                p.ammo = k.weapon.ammo; p.maxAmmo = k.weapon.ammo;
                p.vx = p.vy = 0;
                p.invulnTimer = 180; // 3 sec invuln
            }
            continue;
        }

        if (p.invulnTimer > 0) p.invulnTimer--;

        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.9;
        p.vy *= 0.9;

        // Improved grapple
        if (p.grapple.active) {
            const dx = p.grapple.x - (p.x + 20);
            const dy = p.grapple.y - (p.y + 20);
            const dist = Math.hypot(dx, dy);
            if (dist > 40) {
                const force = 0.018;
                const maxPull = 14;
                const pullX = (dx / dist) * force * Math.min(dist, 800);
                const pullY = (dy / dist) * force * Math.min(dist, 800);
                p.vx += pullX;
                p.vy += pullY;
                const speed = Math.hypot(p.vx, p.vy);
                if (speed > maxPull) {
                    p.vx *= maxPull / speed;
                    p.vy *= maxPull / speed;
                }
            } else {
                p.grapple.active = false;
            }
        }

        // Wall collision, etc. unchanged...

        // Zombie AI improvement
        if (p.type === 'zombie' && !p.dead) {
            let target = null;
            let minDist = Infinity;
            for (let tid in g.players) {
                let t = g.players[tid];
                if (t.type !== 'zombie' && !t.dead) {
                    let d = Math.hypot(t.x - p.x, t.y - p.y);
                    if (d < minDist) {
                        minDist = d;
                        target = t;
                    }
                }
            }
            if (target) {
                let angle = Math.atan2(target.y - p.y, target.x - p.x);
                p.angle = angle;
                let noise = (Math.random() - 0.5) * 0.4;
                p.vx += Math.cos(angle + noise) * p.speed * 0.25;
                p.vy += Math.sin(angle + noise) * p.speed * 0.25;
            }
        }
    }

    // Bullet logic unchanged...

    // ... rest of update function
}

function handleDeath(lobby, victim, killer) {
    // ... existing logic
    if (killer && killer.type === 'player') {
        killer.score += 10;
        killer.money += 25;
        killer.xp += 50;
        killer.level = getLevel(killer.xp);
        if (userDB[killer.username]) {
            userDB[killer.username].money = killer.money;
            userDB[killer.username].xp = killer.xp;
            saveDB();
        }
    }
    if (victim.type === 'zombie' || victim.isDummy) {
        delete lobby.players[victim.id];
    } else {
        if (lobby.gameState.mode === 'ZOMBIES') {
            victim.lives--;
            if (victim.lives <= 0) {
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
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
