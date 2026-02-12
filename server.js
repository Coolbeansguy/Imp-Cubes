const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- CONFIGURATION ---
const MAP_SIZE = { x: 1600, y: 1200 };

// Walls (x, y, width, height)
const WALLS = [
    { x: 200, y: 200, w: 100, h: 400 },   // Pillar
    { x: 600, y: 500, w: 600, h: 100 },   // Barrier
    { x: 1000, y: 200, w: 200, h: 200 },  // Box
    { x: 400, y: 900, w: 800, h: 50 },    // Long wall
    // Map Borders
    { x: -50, y: 0, w: 50, h: 1200 },     // Left
    { x: 1600, y: 0, w: 50, h: 1200 },    // Right
    { x: 0, y: -50, w: 1600, h: 50 },     // Top
    { x: 0, y: 1200, w: 1600, h: 50 }     // Bottom
];

const WEAPONS = {
    pistol: { id: 'pistol', damage: 15, speed: 18, cooldown: 20, size: 5, color: '#FFD700' },
    sniper: { id: 'sniper', damage: 90, speed: 45, cooldown: 100, size: 4, color: '#00FFFF' },
    rpg:    { id: 'rpg',    damage: 60, speed: 10, cooldown: 80, size: 12, color: '#FF4500' }
};

const ROLES = {
    OWNER: { name: '[OWNER]', hp: 300, color: '#FFD700' }, // Gold
    ADMIN: { name: '[ADMIN]', hp: 200, color: '#FF4500' }, // Red-Orange
    MOD:   { name: '[MOD]',   hp: 150, color: '#32CD32' }, // Lime
    USER:  { name: 'Imp',     hp: 100, color: '#4488FF' }  // Blue
};

// --- STATE ---
const players = {};
const bullets = [];

// --- PHYSICS HELPER ---
function rectIntersect(r1, r2) {
    return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
}

function pointInWall(x, y) {
    for (const w of WALLS) {
        if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
    }
    return false;
}

io.on('connection', (socket) => {
    // Init Player
    players[socket.id] = {
        x: 100, y: 100, w: 40, h: 40,
        vx: 0, vy: 0,
        hp: 100,
        maxHp: 100,
        role: ROLES.USER,
        weapon: WEAPONS.pistol,
        shootTimer: 0,
        grapple: { active: false, x: 0, y: 0 },
        parry: { active: false, timer: 0 },
        angle: 0,
        score: 0
    };

    // Role Login
    socket.on('auth', (key) => {
        const p = players[socket.id];
        if (key === 'impthebest') { p.role = ROLES.OWNER; p.weapon = WEAPONS.rpg; }
        else if (key === 'admin123') { p.role = ROLES.ADMIN; p.weapon = WEAPONS.sniper; }
        
        p.maxHp = p.role.hp;
        p.hp = p.maxHp;
    });

    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p) return;

        p.angle = data.angle;

        // Movement
        const speed = 0.8;
        if (data.up) p.vy -= speed;
        if (data.down) p.vy += speed;
        if (data.left) p.vx -= speed;
        if (data.right) p.vx += speed;

        // Grapple (Right Click) - ONLY if clicking a wall
        if (data.grapple && !p.grapple.active) {
            // Check if mouse click hits a wall
            if (pointInWall(data.mx, data.my)) {
                p.grapple.active = true;
                p.grapple.x = data.mx;
                p.grapple.y = data.my;
            }
        } else if (!data.grapple) {
            p.grapple.active = false;
        }

        // Parry (Space)
        if (data.parry && p.parry.timer <= 0) {
            p.parry.active = true;
            p.parry.timer = 60; // 1 second cooldown
            
            // Reflect nearby bullets
            bullets.forEach(b => {
                const dx = b.x - (p.x + p.w/2);
                const dy = b.y - (p.y + p.h/2);
                if (Math.sqrt(dx*dx + dy*dy) < 60 && b.owner !== socket.id) {
                    b.vx *= -1.5;
                    b.vy *= -1.5;
                    b.owner = socket.id; // Steal bullet
                    b.parried = true;
                }
            });
        }

        // Shoot (Left Click)
        if (data.shoot && p.shootTimer <= 0) {
            p.shootTimer = p.weapon.cooldown;
            const cx = p.x + p.w/2;
            const cy = p.y + p.h/2;
            
            bullets.push({
                x: cx, y: cy,
                vx: Math.cos(p.angle) * p.weapon.speed,
                vy: Math.sin(p.angle) * p.weapon.speed,
                damage: p.weapon.damage,
                size: p.weapon.size,
                color: p.weapon.color,
                owner: socket.id,
                life: 100
            });
        }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// SERVER LOOP (60 TPS)
setInterval(() => {
    // Update Players
    for (const id in players) {
        const p = players[id];

        // Physics
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.9; // Friction
        p.vy *= 0.9;
        if (p.shootTimer > 0) p.shootTimer--;

        // Wall Collision (Player)
        for (const w of WALLS) {
            if (rectIntersect(p, w)) {
                // Simple resolve: push back based on velocity
                p.x -= p.vx;
                p.y -= p.vy;
                p.vx = 0; p.vy = 0;
            }
        }

        // Grapple Pull
        if (p.grapple.active) {
            const dx = p.grapple.x - (p.x + p.w/2);
            const dy = p.grapple.y - (p.y + p.h/2);
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > 50) {
                p.vx += (dx/dist) * 1.5;
                p.vy += (dy/dist) * 1.5;
            }
        }

        // Parry logic
        if (p.parry.timer > 0) p.parry.timer--;
        if (p.parry.timer < 45) p.parry.active = false; // Active for 15 ticks
    }

    // Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        let hit = false;

        // Wall Collision
        for (const w of WALLS) {
            if (b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h) hit = true;
        }

        // Player Collision
        if (!hit) {
            for (const id in players) {
                const p = players[id];
                if (b.owner !== id && 
                    b.x > p.x && b.x < p.x + p.w &&
                    b.y > p.y && b.y < p.y + p.h) {
                    
                    p.hp -= b.damage;
                    hit = true;

                    // Death
                    if (p.hp <= 0) {
                        p.x = 100 + Math.random() * 500;
                        p.y = 100 + Math.random() * 500;
                        p.hp = p.maxHp;
                        if(players[b.owner]) players[b.owner].score++;
                    }
                }
            }
        }

        if (hit || b.life <= 0) bullets.splice(i, 1);
    }

    io.emit('state', { players, bullets, walls: WALLS });
}, 1000 / 60);

http.listen(3000, () => console.log('Imp Cubes Server running on port 3000'));
