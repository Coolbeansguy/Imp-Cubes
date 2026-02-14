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

const WEAPONS = {
    pistol: { damage: 15, speed: 18, cooldown: 20, size: 5, color: '#FFD700' },
    sniper: { damage: 90, speed: 45, cooldown: 100, size: 4, color: '#00FFFF' },
    rpg:    { damage: 60, speed: 10, cooldown: 80, size: 12, color: '#FF4500' }
};

// --- DATABASE ---
const DB_FILE = 'database.json';
let userDB = {};

// Load Database
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { console.log(e); }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(userDB));
}

// --- STATE ---
const players = {};
const bullets = [];

// --- HELPERS ---
function getSafeSpawn() {
    let x, y, hit;
    let attempts = 0;
    do {
        x = Math.random() * (MAP_SIZE.x - 100) + 50;
        y = Math.random() * (MAP_SIZE.y - 100) + 50;
        hit = WALLS.some(w => x < w.x + w.w && x + 40 > w.x && y < w.y + w.h && y + 40 > w.y);
        attempts++;
    } while (hit && attempts < 100);
    return { x, y };
}

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        // Load saved data or create default
        let saved = userDB[data.username] || { money: 0, xp: 0, hat: 'none' };
        
        // Save user to DB if new
        if (!userDB[data.username]) {
            userDB[data.username] = saved;
            saveDB();
        }

        // Staff Logic
        let role = { hp: 100, weapon: 'pistol' };
        if (data.email === 'owner@imp.com') role = { hp: 300, weapon: 'rpg' };
        else if (data.email === 'admin@imp.com') role = { hp: 200, weapon: 'sniper' };

        const spawn = getSafeSpawn();

        players[socket.id] = {
            id: socket.id,
            x: spawn.x, y: spawn.y, w: 40, h: 40,
            vx: 0, vy: 0,
            hp: role.hp, maxHp: role.hp,
            color: data.color || '#4488FF',
            username: data.username || "Guest",
            weapon: WEAPONS[role.weapon],
            money: saved.money,
            hat: saved.hat,
            grapple: { active: false, x: 0, y: 0 },
            score: 0
        };

        socket.emit('init', { mapSize: MAP_SIZE, id: socket.id });
    });

    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p) return;

        p.angle = data.angle;
        
        // Movement
        let speed = data.sprint ? 1.5 : 0.8;
        if (data.up) p.vy -= speed;
        if (data.down) p.vy += speed;
        if (data.left) p.vx -= speed;
        if (data.right) p.vx += speed;

        // Shoot
        if (data.shoot && (!p.shootTimer || p.shootTimer <= 0)) {
            p.shootTimer = p.weapon.cooldown;
            bullets.push({
                x: p.x + 20, y: p.y + 20,
                vx: Math.cos(p.angle) * p.weapon.speed,
                vy: Math.sin(p.angle) * p.weapon.speed,
                damage: p.weapon.damage,
                size: p.weapon.size,
                color: p.weapon.color,
                owner: socket.id,
                life: 100
            });
        }
        
        // Grapple
        if (data.grapple && !p.grapple.active) {
             if(data.gx) { p.grapple.active = true; p.grapple.x = data.gx; p.grapple.y = data.gy; }
        } else if(!data.grapple) p.grapple.active = false;
    });

    socket.on('buy', (item) => {
        const p = players[socket.id];
        if (!p) return;

        // Cost Logic
        let cost = 0;
        if (item === 'hat_top') cost = 100;
        if (item === 'hat_fez') cost = 250;

        if (p.money >= cost) {
            p.money -= cost;
            p.hat = item;
            
            // Save to DB
            if(userDB[p.username]) {
                userDB[p.username].money = p.money;
                userDB[p.username].hat = p.hat;
                saveDB();
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// --- GAME LOOP ---
setInterval(() => {
    // 1. Update Players
    for (const id in players) {
        const p = players[id];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.9; p.vy *= 0.9; // Friction
        if (p.shootTimer > 0) p.shootTimer--;
        
        // Wall Collision
        WALLS.forEach(w => {
            if (p.x < w.x + w.w && p.x + p.w > w.x && p.y < w.y + w.h && p.y + p.h > w.y) {
                p.x -= p.vx * 1.2; p.y -= p.vy * 1.2; p.vx = 0; p.vy = 0;
            }
        });
        
        // Grapple Pull
        if(p.grapple.active) {
            const dx = p.grapple.x - (p.x+20), dy = p.grapple.y - (p.y+20);
            p.vx += dx * 0.002; p.vy += dy * 0.002;
        }
        
        // Map Boundaries
        if(p.x < 0) p.x=0; if(p.x > MAP_SIZE.x) p.x=MAP_SIZE.x;
        if(p.y < 0) p.y=0; if(p.y > MAP_SIZE.y) p.y=MAP_SIZE.y;
    }

    // 2. Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;
        let hit = false;
        
        // Wall Hit
        if(WALLS.some(w => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h)) hit = true;

        if(!hit) {
            for(const id in players) {
                const p = players[id];
                // Check collision
                if(b.owner !== id && b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
                    p.hp -= b.damage;
                    hit = true;
                    
                    // --- PLAYER DEATH LOGIC (Added here) ---
                    if(p.hp <= 0) {
                        // 1. Respawn the dead player
                        const spawn = getSafeSpawn();
                        p.x = spawn.x;
                        p.y = spawn.y;
                        p.hp = p.maxHp;

                        // 2. Give "Cube Points" to the killer
                        if (players[b.owner]) {
                            players[b.owner].score++;       // Add Kill
                            players[b.owner].money += 50;   // Add 50 Cube Points
                            
                            // Save immediately so they don't lose it
                            if(userDB[players[b.owner].username]) {
                                userDB[players[b.owner].username].money = players[b.owner].money;
                                saveDB();
                            }
                        }
                    }
                    // ---------------------------------------
                }
            }
        }
        if(hit || b.life <= 0) bullets.splice(i, 1);
    }

    io.emit('state', { players, bullets, walls: WALLS });
}, 1000/60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
