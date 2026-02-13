const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// CONFIG
const MAP_SIZE = { x: 1600, y: 1200 };
const WALLS = [
    { x: 200, y: 200, w: 100, h: 400 },
    { x: 600, y: 500, w: 600, h: 100 },
    { x: 1000, y: 200, w: 200, h: 200 },
    { x: 400, y: 900, w: 800, h: 50 },
    { x: -50, y: 0, w: 50, h: 1200 }, { x: 1600, y: 0, w: 50, h: 1200 },
    { x: 0, y: -50, w: 1600, h: 50 }, { x: 0, y: 1200, w: 1600, h: 50 }
];

// ACCOUNTS (Simple email check)
const STAFF = {
    'owner@imp.com': { role: 'OWNER', hp: 300, color: '#FFD700', weapon: 'rpg' },
    'admin@imp.com': { role: 'ADMIN', hp: 200, color: '#FF4500', weapon: 'sniper' }
};

const WEAPONS = {
    pistol: { damage: 15, speed: 18, cooldown: 20, size: 5, color: '#FFD700' },
    sniper: { damage: 90, speed: 45, cooldown: 100, size: 4, color: '#00FFFF' },
    rpg:    { damage: 60, speed: 10, cooldown: 80, size: 12, color: '#FF4500' }
};

const players = {};
const bullets = [];

io.on('connection', (socket) => {
    console.log('User connected', socket.id);

    // WAIT for the "join" event before creating the player
    socket.on('join', (data) => {
        let roleData = { role: 'Imp', hp: 100, color: data.color || '#4488FF', weapon: 'pistol' };

        // Check Login
        if (STAFF[data.email]) {
            const staff = STAFF[data.email];
            roleData = { 
                role: staff.role, 
                hp: staff.hp, 
                color: staff.color, 
                weapon: staff.weapon 
            };
        }

        players[socket.id] = {
            x: 100 + Math.random() * 500,
            y: 100 + Math.random() * 500,
            w: 40, h: 40,
            vx: 0, vy: 0,
            hp: roleData.hp, maxHp: roleData.hp,
            role: roleData.role,
            color: roleData.color,
            weapon: WEAPONS[roleData.weapon],
            name: data.name || "Unknown Imp",
            grapple: { active: false, x:0, y:0 },
            parry: { active: false, timer: 0 },
            score: 0
        };
        
        socket.emit('gameStart'); // Tell client to hide menu
    });

    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p) return; // Ignore inputs if player hasn't joined yet

        p.angle = data.angle;

        // --- IMPROVED MOVEMENT ---
        // 1. Calculate direction
        let dx = (data.right ? 1 : 0) - (data.left ? 1 : 0);
        let dy = (data.down ? 1 : 0) - (data.up ? 1 : 0);

        // 2. Normalize diagonal movement (Pythagorean theorem)
        if (dx !== 0 || dy !== 0) {
            const length = Math.sqrt(dx*dx + dy*dy);
            dx /= length;
            dy /= length;
        }

        // 3. Apply Speed (Sprint if Shift is held)
        const speed = data.sprint ? 1.5 : 0.8;
        p.vx += dx * speed;
        p.vy += dy * speed;

        // --- ACTIONS ---
        // Grapple
        if (data.grapple && !p.grapple.active) {
            // Only grapple walls
            for(let w of WALLS) {
                if(data.mx > w.x && data.mx < w.x+w.w && data.my > w.y && data.my < w.y+w.h) {
                    p.grapple.active = true;
                    p.grapple.x = data.mx; p.grapple.y = data.my;
                    break;
                }
            }
        } else if (!data.grapple) p.grapple.active = false;

        // Parry
        if (data.parry && p.parry.timer <= 0) {
            p.parry.active = true;
            p.parry.timer = 60;
            // Parry logic
             bullets.forEach(b => {
                const dist = Math.sqrt((b.x - (p.x+20))**2 + (b.y - (p.y+20))**2);
                if (dist < 60 && b.owner !== socket.id) {
                    b.vx *= -1.5; b.vy *= -1.5; b.owner = socket.id; b.parried = true;
                }
            });
        }

        // Shoot
        if (data.shoot && (!p.shootTimer || p.shootTimer <= 0)) {
            p.shootTimer = p.weapon.cooldown;
            bullets.push({
                x: p.x+20, y: p.y+20,
                vx: Math.cos(p.angle) * p.weapon.speed,
                vy: Math.sin(p.angle) * p.weapon.speed,
                damage: p.weapon.damage, size: p.weapon.size, color: p.weapon.color,
                owner: socket.id, life: 100
            });
        }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// GAME LOOP
setInterval(() => {
    // Update Physics
    for (const id in players) {
        const p = players[id];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.9; p.vy *= 0.9; // Friction
        
        // Wall Collision
        WALLS.forEach(w => {
            if (p.x < w.x + w.w && p.x + p.w > w.x && p.y < w.y + w.h && p.y + p.h > w.y) {
                p.x -= p.vx * 1.2; p.y -= p.vy * 1.2; // Bounce back slightly
                p.vx = 0; p.vy = 0;
            }
        });

        if(p.grapple.active) {
             const dx = p.grapple.x - (p.x + 20);
             const dy = p.grapple.y - (p.y + 20);
             p.vx += dx * 0.002; p.vy += dy * 0.002;
        }

        if(p.shootTimer > 0) p.shootTimer--;
        if(p.parry.timer > 0) p.parry.timer--;
        if(p.parry.timer < 45) p.parry.active = false;
    }

    // Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;
        let hit = false;

        // Hit Walls
        WALLS.forEach(w => {
            if (b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h) hit = true;
        });

        // Hit Players
        if(!hit) {
            for (const id in players) {
                const p = players[id];
                if (b.owner !== id && b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
                    p.hp -= b.damage;
                    hit = true;
                    if(p.hp <= 0) {
                        p.x = 200; p.y = 200; p.hp = p.maxHp;
                        if(players[b.owner]) players[b.owner].score++;
                    }
                }
            }
        }
        if (hit || b.life <= 0) bullets.splice(i, 1);
    }

    io.emit('state', { players, bullets, walls: WALLS });
}, 1000/60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
