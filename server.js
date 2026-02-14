const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

const ROUND_TIME = 1800; // 3 Minutes
const VOTE_TIME = 15;
const END_TIME = 10;
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

const GOD_KIT = { name:'ADMIN', hp:1000, speed:1.5, weapon:{damage:1000,speed:40,cooldown:5,ammo:999,reload:0,range:500}};

let userDB = {};
if(fs.existsSync(DB_FILE)) try { userDB=JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){}
function saveDB(){ fs.writeFileSync(DB_FILE,JSON.stringify(userDB)); }

let players = {};
let bullets = [];
let gameState = {
    phase: 'GAME', timer: ROUND_TIME, mode: 'FFA', mapIndex: 0,
    walls: MAPS[0].walls, scores: { red: 0, blue: 0 }, flags: [], hill: null, votes: { map: {}, mode: {} }
};

function getLevel(xp) { return Math.floor(Math.sqrt(xp/100))+1; }

function getSpawn(team) {
    let x, y, hit, attempts=0;
    do {
        if(gameState.mode === 'FFA') x = Math.random()*1800+100;
        else if(team === 'RED') x = Math.random()*300+100;
        else x = Math.random()*300+1600;
        y = Math.random()*1300+100;
        hit = gameState.walls.some(w => x<w.x+w.w && x+40>w.x && y<w.y+w.h && y+40>w.y);
        attempts++;
    } while(hit && attempts<100);
    return {x,y};
}

function resetGame(mode, mapIdx) {
    gameState.mode = mode; gameState.mapIndex = mapIdx; gameState.walls = MAPS[mapIdx].walls;
    gameState.scores = { red: 0, blue: 0 }; gameState.timer = ROUND_TIME; gameState.phase = 'GAME'; bullets = [];
    gameState.hill = (mode === 'KOTH') ? { x:900, y:650, w:200, h:200 } : null;
    gameState.flags = (mode === 'CTF') ? [{ team:'RED', x:100, y:750, base:{x:100,y:750}, carrier:null }, { team:'BLUE', x:1900, y:750, base:{x:1900,y:750}, carrier:null }] : [];
    Object.keys(players).forEach((id, i) => {
        let p = players[id];
        if(!p.isDummy) {
            p.team = (mode !== 'FFA') ? ((i % 2 === 0) ? 'RED' : 'BLUE') : 'FFA';
            p.color = (p.team === 'RED') ? '#ff4757' : ((p.team === 'BLUE') ? '#4488FF' : ((p.isOwner && p.godMode) ? '#FFD700' : '#4488FF'));
            respawn(p);
        } else delete players[id];
    });
}

function respawn(p) {
    let s = getSpawn(p.team); p.x=s.x; p.y=s.y;
    let k = (p.isOwner && p.godMode) ? GOD_KIT : p.selectedKit;
    p.hp=k.hp; p.maxHp=k.hp; p.speed=k.speed; p.kit=k; p.ammo=k.weapon.ammo; p.maxAmmo=k.weapon.ammo; p.reloading=false; p.vx=0; p.vy=0;
}

io.on('connection', (socket) => {
    socket.on('login', (d) => auth(socket, d, true));
    socket.on('guest', (d) => auth(socket, d, false));
    socket.on('signup', (d) => {
        if(userDB[d.user]) return socket.emit('authMsg',{s:false,m:"Taken"});
        userDB[d.user] = { pass:d.pass, email:d.email, money:0, xp:0, items:[] };
        saveDB(); socket.emit('authMsg',{s:true,m:"Created"});
    });

    socket.on('vote', (d) => {
        const p = players[socket.id];
        if(gameState.phase === 'VOTE' && p) {
            let weight = p.isOwner ? 50 : 1; // RIGGED VOTING
            if(d.type === 'map') gameState.votes.map[d.val] = (gameState.votes.map[d.val]||0)+weight;
            if(d.type === 'mode') gameState.votes.mode[d.val] = (gameState.votes.mode[d.val]||0)+weight;
        }
    });

    socket.on('staffAction', (data) => {
        const p = players[socket.id]; if(!p || !p.isOwner) return;
        if(data.type === 'skipRound') { gameState.timer = 1; io.emit('chatMsg', { user: '[SYSTEM]', text: 'Round Skipped', color: 'gold' }); }
        if(data.type === 'giveCP') { p.money += 1000; if(userDB[p.username]) { userDB[p.username].money = p.money; saveDB(); } }
        if(data.type === 'toggleGod') { p.godMode = !p.godMode; p.color = p.godMode ? '#FFD700' : '#4488FF'; respawn(p); }
        if(data.type === 'spawnDummy') { let id='d_'+Math.random(); let s=getSpawn('FFA'); players[id]={id:id,username:"Dummy",isDummy:true,x:s.x,y:s.y,vx:0,vy:0,w:40,h:40,hp:100,maxHp:100,color:'#888',grapple:{active:false},team:'FFA',score:0,level:0,hat:'none'}; }
        if(data.type === 'clearDummies') for(let id in players) if(players[id].isDummy) delete players[id];
    });

    socket.on('buy', (item) => {
        let p = players[socket.id]; if(!p || !userDB[p.username]) return;
        let cost = (item=='tophat'?500:(item=='crown'?2000:0));
        if(p.money >= cost && !p.items.includes(item)) { p.money-=cost; p.items.push(item); p.hat=item; userDB[p.username].money=p.money; userDB[p.username].items=p.items; saveDB(); }
    });

    socket.on('input', (d) => {
        let p = players[socket.id]; if(!p) return;
        p.angle = d.angle;
        let spd = p.speed * (d.dash && p.dashTimer<=0 ? 25 : 0.8);
        if(d.dash && p.dashTimer<=0) p.dashTimer=90;
        if(d.up) p.vy-=spd; if(d.down) p.vy+=spd; if(d.left) p.vx-=spd; if(d.right) p.vx+=spd;
        if(p.reloadTimer > 0) { p.reloadTimer--; if(p.reloadTimer<=0) { p.ammo=p.maxAmmo; p.reloading=false; } } 
        else if(d.shoot && p.shootTimer<=0) {
            if(p.ammo>0) {
                p.shootTimer = p.kit.weapon.cooldown; p.ammo--;
                let cnt = p.kit.weapon.count||1;
                for(let i=0;i<cnt;i++) { let a = p.angle + (Math.random()-0.5)*(p.kit.weapon.spread||0); bullets.push({x:p.x+20,y:p.y+20,vx:Math.cos(a)*p.kit.weapon.speed,vy:Math.sin(a)*p.kit.weapon.speed,dmg:p.kit.weapon.damage,owner:socket.id,life:p.kit.weapon.range||100,color:p.color}); }
            } else { p.reloading=true; p.reloadTimer=p.kit.weapon.reload; }
        }
        if(d.grapple && !p.grapple.active) { p.grapple.active=true; p.grapple.x=d.gx; p.grapple.y=d.gy; } else if(!d.grapple) p.grapple.active=false;
    });

    socket.on('chat', (m) => { let p = players[socket.id]; if(p && m.trim()) io.emit('chatMsg', { user:`[Lvl ${p.level}] ${p.username}`, text:m.substring(0,60), color:p.color }); });
    socket.on('disconnect', () => delete players[socket.id]);
});

function auth(s, d, isLogin) {
    let acc = isLogin ? userDB[d.user] : { money:0, xp:0, items:[] };
    if(isLogin && (!acc || acc.pass !== d.pass)) return s.emit('authMsg',{s:false,m:"Fail"});
    let baseKit = KITS[d.kit] || KITS.assault;
    let isOwner = acc.email === 'raidenrmarks12@gmail.com';
    let startingKit = isOwner ? GOD_KIT : baseKit;
    players[s.id] = { id:s.id, username: isLogin?d.user:"Guest"+Math.floor(Math.random()*9999), team:'FFA', x:0, y:0, vx:0, vy:0, w:40, h:40, selectedKit: baseKit, kit: startingKit, hp: startingKit.hp, maxHp: startingKit.hp, speed: startingKit.speed, isOwner: isOwner, godMode: isOwner, color: isOwner?'#FFD700':'#4488FF', money:acc.money, xp:acc.xp, level:getLevel(acc.xp), items:acc.items||[], hat:'none', ammo:startingKit.weapon.ammo, maxAmmo:startingKit.weapon.ammo, reloading:false, reloadTimer:0, shootTimer:0, dashTimer:0, grapple:{active:false}, score:0 };
    respawn(players[s.id]);
    s.emit('startGame', { id:s.id, isOwner:isOwner });
}

resetGame('FFA', 0); // Start immediately

setInterval(() => {
    if(gameState.phase === 'GAME') {
        gameState.timer--;
        if(gameState.timer <= 0) {
            gameState.phase = 'END'; gameState.timer = END_TIME;
            let sorted = Object.values(players).filter(p=>!p.isDummy).sort((a,b)=>b.score-a.score).slice(0,5);
            io.emit('gameover', { top:sorted, scores:gameState.scores });
        }
        if(gameState.mode === 'KOTH' && gameState.hill) {
            let r=0, b=0;
            for(let id in players) { let p=players[id]; if(p.x>gameState.hill.x && p.x<gameState.hill.x+200 && p.y>gameState.hill.y && p.y<gameState.hill.y+200) { if(p.team === 'RED') r++; else if(p.team === 'BLUE') b++; } }
            if(r>b) gameState.scores.red++; else if(b>r) gameState.scores.blue++;
        }
    } 
    else if(gameState.phase === 'END') { gameState.timer--; if(gameState.timer <= 0) { gameState.phase = 'VOTE'; gameState.timer = VOTE_TIME; gameState.votes = {map:{}, mode:{}}; } }
    else if(gameState.phase === 'VOTE') {
        gameState.timer--;
        if(gameState.timer <= 0) {
            let mode='FFA', mm=0; for(let m in gameState.votes.mode) if(gameState.votes.mode[m]>mm){mode=m;mm=gameState.votes.mode[m];}
            let map=0, mp=0; for(let m in gameState.votes.map) if(gameState.votes.map[m]>mp){map=parseInt(m);mp=gameState.votes.map[m];}
            resetGame(mode, map);
        }
    }

    for(let id in players) {
        let p = players[id]; p.x+=p.vx; p.y+=p.vy; p.vx*=0.9; p.vy*=0.9;
        if(!p.isDummy) { if(p.dashTimer>0) p.dashTimer--; if(p.shootTimer>0) p.shootTimer--; if(p.grapple.active) { p.vx+=(p.grapple.x-(p.x+20))*0.002; p.vy+=(p.grapple.y-(p.y+20))*0.002; } }
        gameState.walls.forEach(w=>{ if(p.x<w.x+w.w && p.x+p.w>w.x && p.y<w.y+w.h && p.y+p.h>w.y) { p.x-=p.vx*1.2; p.y-=p.vy*1.2; p.vx=0; p.vy=0; } });
        if(gameState.mode === 'CTF' && !p.isDummy) gameState.flags.forEach(f => { if(!f.carrier && p.team !== f.team && Math.hypot(p.x-f.x, p.y-f.y)<40) f.carrier=p.id; if(f.carrier===p.id && Math.hypot(p.x-f.base.x, p.y-f.base.y)<50) { gameState.scores[p.team.toLowerCase()]++; p.score+=100; f.carrier=null; f.x=f.base.x; f.y=f.base.y; } });
    }

    for(let i=bullets.length-1; i>=0; i--) {
        let b=bullets[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        let hit = gameState.walls.some(w=>b.x>w.x && b.x<w.x+w.w && b.y>w.y && b.y<w.y+w.h);
        let s = players[b.owner]; if(!s) { bullets.splice(i,1); continue; }
        if(!hit) {
            for(let id in players) {
                let p = players[id];
                if(b.owner!==id && (gameState.mode==='FFA' || p.team!==s.team) && b.x>p.x && b.x<p.x+p.w && b.y>p.y && b.y<p.y+p.h) {
                    p.hp-=b.dmg; hit=true;
                    if(p.hp<=0) {
                        if(!s.isDummy) { s.score+=10; s.money+=25; s.xp+=50; s.level=getLevel(s.xp); if(userDB[s.username]) { userDB[s.username].money=s.money; userDB[s.username].xp=s.xp; saveDB(); } }
                        if(gameState.mode==='CTF') gameState.flags.forEach(f=>{if(f.carrier===p.id){f.carrier=null;f.x=p.x;f.y=p.y;}});
                        if(p.isDummy) delete players[id]; else respawn(p);
                    }
                }
            }
        }
        if(hit || b.life<=0) bullets.splice(i,1);
    }
    if(gameState.mode === 'CTF') gameState.flags.forEach(f => { if(f.carrier && players[f.carrier]) { f.x=players[f.carrier].x; f.y=players[f.carrier].y; } });
    io.emit('state', { players, bullets, game:gameState });
}, 1000/60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server on ${PORT}`));
