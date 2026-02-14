const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// --- CONFIG ---
const MAP_SIZE = { x: 2000, y: 1500 };
const WALLS = [
    {x:300,y:300,w:100,h:400}, {x:800,y:600,w:400,h:100}, {x:1200,y:200,w:200,h:200},
    {x:0,y:0,w:50,h:1500}, {x:1950,y:0,w:50,h:1500}, {x:0,y:0,w:2000,h:50}, {x:0,y:1450,w:2000,h:50}
];

// --- REBALANCED KITS (Classes) ---
const KITS = {
    assault: { 
        name: 'Soldier', hp: 120, speed: 1.0, 
        weapon: { name:'AR', damage: 12, speed: 22, cooldown: 8, ammo: 30, reload: 120, spread: 0.05, range: 80 } 
    },
    shotgun: { 
        name: 'Breacher', hp: 160, speed: 0.9, 
        weapon: { name:'Shotgun', damage: 9, speed: 18, cooldown: 55, ammo: 5, reload: 150, count: 6, spread: 0.3, range: 40 } 
    },
    sniper: { 
        name: 'Recon', hp: 80, speed: 1.1, 
        weapon: { name:'Sniper', damage: 95, speed: 45, cooldown: 80, ammo: 3, reload: 180, spread: 0.0, range: 200 } 
    },
    tank: { 
        name: 'Heavy', hp: 300, speed: 0.7, 
        weapon: { name:'LMG', damage: 8, speed: 20, cooldown: 5, ammo: 100, reload: 300, spread: 0.15, range: 70 } 
    },
    ninja: { 
        name: 'Ninja', hp: 90, speed: 1.3, 
        weapon: { name:'Shuriken', damage: 25, speed: 30, cooldown: 15, ammo: 10, reload: 60, spread: 0.02, range: 50 } 
    }
};

// --- DATABASE ---
const DB_FILE = 'database.json';
let userDB = {};
if (fs.existsSync(DB_FILE)) { try { userDB = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) {} }
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(userDB)); }

// --- STATE ---
const players = {};
const bullets = [];

function getSafeSpawn() {
    let x, y, hit, attempts = 0;
    do {
        x = Math.random() * (MAP_SIZE.x - 200) + 100;
        y = Math.random() * (MAP_SIZE.y - 200) + 100;
        hit = WALLS.some(w => x < w.x + w.w && x + 40 > w.x && y < w.y + w.h && y + 40 > w.y);
        attempts++;
    } while (hit && attempts < 100);
    return { x, y };
}

function getLevel(xp) {
    return Math.floor(Math.sqrt(xp / 100)) + 1;
}

io.on('connection', (socket) => {
    
    // --- AUTH ---
    socket.on('signup', (data) => {
        if (userDB[data.user]) return socket.emit('authMsg', { success: false, msg: "Username Taken" });
        userDB[data.user] = { 
            pass: data.pass, email: data.email, 
            money: 0, xp: 0, items: [] 
        };
        saveDB();
        socket.emit('authMsg', { success: true, msg: "Account Created!" });
    });

    socket.on('login', (data) => {
        const acc = userDB[data.user];
        if (!acc || acc.pass !== data.pass) return socket.emit('authMsg', { success: false, msg: "Invalid Login" });
        joinGame(socket, data.user, acc, data.kit);
    });

    socket.on('guest', (data) => joinGame(socket, "Guest"+Math.floor(Math.random()*999), {money:0, xp:0, email:''}, data.kit));

    function joinGame(socket, username, stats, kitName) {
        const spawn = getSafeSpawn();
        const isOwner = (stats.email === 'raidenrmarks12@gmail.com');
        let kit = KITS[kitName] || KITS.assault;

        if (isOwner) {
            // God Mode Kit for Owner
            kit = { name:'ADMIN', hp:1000, speed:1.5, weapon:{name:'BANHAMMER', damage:1000, speed:40, cooldown:5, ammo:999, reload:0, range:500}};
        }

        players[socket.id] = {
            id: socket.id,
            username: username,
            x: spawn.x, y: spawn.y, w: 40, h: 40, vx: 0, vy: 0,
            
            // Stats
            kit: kit,
            hp: kit.hp, maxHp: kit.hp, speed: kit.speed,
            color: isOwner ? '#FFD700' : '#4488FF',
            money: stats.money, xp: stats.xp, level: getLevel(stats.xp),
            items: stats.items || [],
            hat: 'none',

            // Combat
            ammo: kit.weapon.ammo, maxAmmo: kit.weapon.ammo,
            reloading: false, reloadTimer: 0,
            shootTimer: 0, dashTimer: 0, grapple: { active: false },
            
            score: 0, kills: 0, deaths: 0,
            isOwner: isOwner
        };
        
        socket.emit('startGame', { id: socket.id, isOwner: isOwner });
    }

    // --- STAFF COMMANDS ---
    socket.on('staffAction', (data) => {
        const p = players[socket.id];
        if(!p || !p.isOwner) return;

        if(data.type === 'giveCP') {
            p.money += 1000;
            if(userDB[p.username]) userDB[p.username].money = p.money;
            saveDB();
        }
        if(data.type === 'kickAll') {
            // Logic to kick non-owners would go here
            io.emit('chatMsg', { user: '[SYSTEM]', text: 'Server Restarting...', color: 'red' });
        }
    });

    // --- SHOP ---
    socket.on('buy', (item) => {
        const p = players[socket.id]; // Only works in-game for now or needs DB lookup
        // Simplified: Client handles menu, Server validates purchase if player is online
        if(!p || !userDB[p.username]) return;
        
        let cost = 0;
        if(item === 'tophat') cost = 500;
        if(item === 'crown') cost = 2000;

        if(p.money >= cost && !p.items.includes(item)) {
            p.money -= cost;
            p.items.push(item);
            p.hat = item;
            userDB[p.username].money = p.money;
            userDB[p.username].items = p.items;
            saveDB();
        }
    });

    socket.on('equip', (item) => {
        const p = players[socket.id];
        if(p && (p.items.includes(item) || item === 'none')) {
            p.hat = item;
        }
    });

    // --- CHAT ---
    socket.on('chat', (msg) => {
        const p = players[socket.id];
        if(p && msg.trim()) {
            let col = p.isOwner ? '#FFD700' : 'white';
            let tag = p.isOwner ? '[OWNER] ' : `[Lvl ${p.level}] `;
            io.emit('chatMsg', { user: tag + p.username, text: msg.substring(0, 100), color: col });
        }
    });

    // --- INPUT ---
    socket.on('input', (d) => {
        const p = players[socket.id];
        if(!p) return;
        
        p.angle = d.angle;
        
        // MOVEMENT
        let spd = p.speed * (d.dash && p.dashTimer <= 0 ? 25 : 0.8);
        if(d.dash && p.dashTimer <= 0) p.dashTimer = 90; // 1.5s dash cooldown

        if(d.up) p.vy -= spd; if(d.down) p.vy += spd;
        if(d.left) p.vx -= spd; if(d.right) p.vx += spd;

        // SHOOTING & RELOADING
        if(p.reloadTimer > 0) {
            p.reloadTimer--;
            if(p.reloadTimer <= 0) {
                p.ammo = p.maxAmmo;
                p.reloading = false;
            }
        } else if (d.shoot && p.shootTimer <= 0) {
            if (p.ammo > 0) {
                p.shootTimer = p.kit.weapon.cooldown;
                p.ammo--;
                
                const count = p.kit.weapon.count || 1;
                for(let i=0; i<count; i++) {
                    let spread = (Math.random()-0.5) * (p.kit.weapon.spread || 0);
                    bullets.push({
                        x: p.x+20, y: p.y+20,
                        vx: Math.cos(p.angle + spread) * p.kit.weapon.speed,
                        vy: Math.sin(p.angle + spread) * p.kit.weapon.speed,
                        damage: p.kit.weapon.damage,
                        owner: socket.id,
                        life: p.kit.weapon.range || 100,
                        color: p.color
                    });
                }
            } else {
                // Auto reload on empty
                p.reloading = true;
                p.reloadTimer = p.kit.weapon.reload;
            }
        }

        // Manual Reload (R key usually, but automated here for simplicity or add key)
        
        // GRAPPLE
        if(d.grapple && !p.grapple.active) { 
            p.grapple.active=true; p.grapple.x=d.gx; p.grapple.y=d.gy; 
        } else if(!d.grapple) p.grapple.active=false;
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// --- GAME LOOP ---
setInterval(() => {
    // PHYSICS
    for(let id in players) {
        let p = players[id];
        p.x += p.vx; p.y += p.vy; p.vx *= 0.9; p.vy *= 0.9;
        if(p.shootTimer > 0) p.shootTimer--;
        if(p.dashTimer > 0) p.dashTimer--;

        // Walls
        WALLS.forEach(w => {
            if(p.x < w.x+w.w && p.x+p.w > w.x && p.y < w.y+w.h && p.y+p.h > w.y) {
                p.x-=p.vx*1.2; p.y-=p.vy*1.2; p.vx=0; p.vy=0;
            }
        });
        
        // Grapple
        if(p.grapple.active) {
            p.vx += (p.grapple.x - (p.x+20)) * 0.002;
            p.vy += (p.grapple.y - (p.y+20)) * 0.002;
        }
    }

    // BULLETS
    for(let i=bullets.length-1; i>=0; i--) {
        let b = bullets[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        let hit = false;
        
        if(WALLS.some(w => b.x>w.x && b.x<w.x+w.w && b.y>w.y && b.y<w.y+w.h)) hit=true;
        
        if(!hit) {
            for(let id in players) {
                let p = players[id];
                if(b.owner !== id && b.x>p.x && b.x<p.x+p.w && b.y>p.y && b.y<p.y+p.h) {
                    p.hp -= b.damage; hit=true;
                    if(p.hp <= 0) {
                        let k = players[b.owner];
                        if(k) {
                            k.kills++; k.money += 25; k.xp += 50; 
                            k.level = getLevel(k.xp);
                            // Auto Save Killer
                            if(userDB[k.username]) { 
                                userDB[k.username].money = k.money; 
                                userDB[k.username].xp = k.xp; 
                                saveDB(); 
                            }
                        }
                        // Respawn
                        let s = getSafeSpawn(); p.x=s.x; p.y=s.y; p.hp=p.maxHp; p.deaths++;
                        p.ammo = p.maxAmmo; p.reloading = false;
                    }
                }
            }
        }
        if(hit || b.life <= 0) bullets.splice(i,1);
    }
    
    io.emit('state', { players, bullets });
}, 1000/60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server on ${PORT}`));
