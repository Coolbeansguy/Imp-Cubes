const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// --- CONFIGURATION ---
const MAP_SIZE = { x: 2000, y: 1500 };
const WALLS = [
    { x: 300, y: 300, w: 100, h: 400 },
    { x: 800, y: 600, w: 400, h: 100 },
    { x: 1200, y: 200, w: 200, h: 200 },
    { x: -50, y: 0, w: 50, h: MAP_SIZE.y }, { x: MAP_SIZE.x, y: 0, w: 50, h: MAP_SIZE.y },
    { x: 0, y: -50, w: MAP_SIZE.x, h: 50 }, { x: 0, y: MAP_SIZE.y, w: MAP_SIZE.x, h: 50 }
];

// NEW WEAPON DEFINITIONS
const WEAPONS = {
    pistol:  { name: 'Pistol',  damage: 15, speed: 18, cooldown: 20, size: 5, color: 'gold', count: 1, spread: 0 },
    shotgun: { name: 'Shotgun', damage: 8,  speed: 15, cooldown: 50, size: 4, color: 'gray', count: 5, spread: 0.3 }, // Shoots 5 bullets
    ak47:    { name: 'AK-47',   damage: 12, speed: 22, cooldown: 8,  size: 4, color: 'lime', count: 1, spread: 0.1 },
    sniper:  { name: 'Sniper',  damage: 90, speed: 45, cooldown: 90, size: 4, color: 'cyan', count: 1, spread: 0 },
    rpg:     { name: 'RPG',     damage: 60, speed: 10, cooldown: 80, size: 12, color: 'orange', count: 1, spread: 0 }
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
        x = Math.random() * (MAP_SIZE.x - 100) + 50;
        y = Math.random() * (MAP_SIZE.y - 100) + 50;
        hit = WALLS.some(w => x < w.x + w.w && x + 40 > w.x && y < w.y + w.h && y + 40 > w.y);
        attempts++;
    } while (hit && attempts < 100);
    return { x, y };
}

io.on('connection', (socket) => {
    
    // AUTH
    socket.on('signup', (data) => {
        if (userDB[data.user]) return socket.emit('authMsg', { success: false, msg: "Taken!" });
        userDB[data.user] = { password: data.pass, email: data.email, money: 0, hat: 'none' };
        saveDB();
        socket.emit('authMsg', { success: true, msg: "Created!" });
    });

    socket.on('login', (data) => {
        const acc = userDB[data.user];
        if (!acc || acc.password !== data.pass) return socket.emit('authMsg', { success: false, msg: "Fail" });
        joinGame(socket, data.user, acc, data.color);
    });

    socket.on('guest', (data) => joinGame(socket, "Guest"+Math.floor(Math.random()*99), {money:0, hat:'none', email:''}, data.color));

    function joinGame(socket, username, stats, color) {
        const spawn = getSafeSpawn();
        const isOwner = (stats.email === 'raidenrmarks12@gmail.com');

        // GIVE WEAPONS: Everyone gets Pistol, Shotgun, AK. Owner gets RPG/Sniper too.
        let inventory = ['pistol', 'shotgun', 'ak47'];
        if (isOwner) inventory.push('sniper', 'rpg');

        players[socket.id] = {
            id: socket.id,
            x: spawn.x, y: spawn.y, w: 40, h: 40,
            vx: 0, vy: 0,
            hp: isOwner ? 300 : 100, maxHp: isOwner ? 300 : 100,
            color: isOwner ? '#FFD700' : (color || '#4488FF'),
            username: username,
            inventory: inventory,
            activeWeapon: 0, // Index of current weapon
            weapon: WEAPONS['pistol'],
            money: stats.money,
            hat: stats.hat,
            grapple: { active: false, x: 0, y: 0 },
            dashCooldown: 0,
            score: 0
        };
        socket.emit('startGame', { mapSize: MAP_SIZE, id: socket.id });
    }

    // SWITCH WEAPON (Keys 1-5)
    socket.on('switch', (index) => {
        const p = players[socket.id];
        if(!p || !p.inventory[index]) return;
        p.activeWeapon = index;
        p.weapon = WEAPONS[p.inventory[index]];
    });

    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p) return;

        p.angle = data.angle;

        // --- NEW DASH MOVEMENT (Shift) ---
        if (data.dash && p.dashCooldown <= 0) {
            // Push player hard in movement direction
            const speed = 25; 
            if (data.up) p.vy -= speed;
            if (data.down) p.vy += speed;
            if (data.left) p.vx -= speed;
            if (data.right) p.vx += speed;
            
            // If standing still, dash towards mouse
            if(!data.up && !data.down && !data.left && !data.right) {
                p.vx = Math.cos(p.angle) * speed;
                p.vy = Math.sin(p.angle) * speed;
            }
            p.dashCooldown = 60; // 1 Second cooldown
        } else {
            // Normal Walking
            let speed = 0.8;
            if (data.up) p.vy -= speed;
            if (data.down) p.vy += speed;
            if (data.left) p.vx -= speed;
            if (data.right) p.vx += speed;
        }

        // SHOOTING (Handles Shotgun Spread)
        if (data.shoot && (!p.shootTimer || p.shootTimer <= 0)) {
            p.shootTimer = p.weapon.cooldown;
            
            const count = p.weapon.count || 1;
            const spread = p.weapon.spread || 0;

            for(let i=0; i<count; i++) {
                // Calculate spread angle
                const angleOffset = (Math.random() - 0.5) * spread;
                bullets.push({
                    x: p.x + 20, y: p.y + 20,
                    vx: Math.cos(p.angle + angleOffset) * p.weapon.speed,
                    vy: Math.sin(p.angle + angleOffset) * p.weapon.speed,
                    damage: p.weapon.damage, size: p.weapon.size, color: p.weapon.color,
                    owner: socket.id, life: 100
                });
            }
        }
        
        if (data.grapple && !p.grapple.active) {
             if(data.gx) { p.grapple.active = true; p.grapple.x = data.gx; p.grapple.y = data.gy; }
        } else if(!data.grapple) p.grapple.active = false;
    });

    // Buy logic...
    socket.on('buy', (item) => {
        const p = players[socket.id];
        if (!p || !userDB[p.username]) return;
        let cost = (item === 'hat_top') ? 100 : 250;
        if (p.money >= cost) {
            p.money -= cost; p.hat = item;
            userDB[p.username].money = p.money; userDB[p.username].hat = p.hat;
            saveDB();
        }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// GAME LOOP
setInterval(() => {
    for (const id in players) {
        const p = players[id];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.9; p.vy *= 0.9; // Friction
        if (p.shootTimer > 0) p.shootTimer--;
        if (p.dashCooldown > 0) p.dashCooldown--;
        
        WALLS.forEach(w => {
            if (p.x < w.x + w.w && p.x + p.w > w.x && p.y < w.y + w.h && p.y + p.h > w.y) {
                p.x -= p.vx * 1.2; p.y -= p.vy * 1.2; p.vx = 0; p.vy = 0;
            }
        });
        if(p.grapple.active) {
            const dx = p.grapple.x - (p.x+20), dy = p.grapple.y - (p.y+20);
            p.vx += dx * 0.002; p.vy += dy * 0.002;
        }
    }

    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;
        let hit = false;
        if(WALLS.some(w => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h)) hit = true;

        if(!hit) {
            for(const id in players) {
                const p = players[id];
                if(b.owner !== id && b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
                    p.hp -= b.damage; hit = true;
                    if(p.hp <= 0) {
                        const spawn = getSafeSpawn();
                        p.x = spawn.x; p.y = spawn.y; p.hp = p.maxHp;
                        if (players[b.owner]) {
                            players[b.owner].score++;
                            players[b.owner].money += 50;
                            if(userDB[players[b.owner].username]) {
                                userDB[players[b.owner].username].money = players[b.owner].money;
                                saveDB();
                            }
                        }
                    }
                }
            }
        }
        if(hit || b.life <= 0) bullets.splice(i, 1);
    }
    io.emit('state', { players, bullets, walls: WALLS });
}, 1000/60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
