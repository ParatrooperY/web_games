'use strict';

// 小熊猫摘星星 · M4 内置卡农
// 参数来源：docs/DESIGN.md 第六节（M1 试玩定稿值）

const canvas = document.querySelector('#stage');
const ctx = canvas.getContext('2d');

// 逻辑分辨率（设计文档：960×540）
const W = 960;
const H = 540;

// 物理参数（定稿）
const GRAVITY = 1085;      // 重力加速度 px/s²
const BOUNCE_V = 690;      // 弹跳速度 px/s（起跳与踩星共用）
const FOLLOW_DELAY = 0.1;  // 延迟跟随：鼠标移动后延迟秒数
const FOLLOW_MAX = 1600;   // 跟随速度上限 px/s

const CHAR_H = 56;         // 角色显示高度 px（M1 反馈缩小 1/3）
const STAR_R = 14;         // 可踩星星半径（设计文档：大小统一 14px）
const PLAYER_SY = H * 0.85; // 角色脚底在屏幕上的固定高度，世界随镜头滚动

// 阶梯参数（设计文档第六节）
const STEP_X_MIN = 120;
const STEP_X_MAX = 280;
const STEP_Y_MIN = 100;
const STEP_Y_MAX = 160;
const EDGE = 60;           // 阶梯距画面左右边界的留白
const GEN_AHEAD = H * 2;   // 预生成窗口：角色上方约两个画面高度

// 引航形态参数（音乐模式，原型初值，试玩后回写设计文档第六节）
const DRIFT_MAX = 150;     // 松手漂移速度上限 px/s
const BOOST_MAX = 850;     // 按住加速速度上限 px/s
const FLY_ARRIVE = 4;      // 接近鼠标时的减速系数（越大越"跟手"）
const SPEED_EASE = 6;      // 按住/松开之间速度过渡的快慢
const FLOAT_G = 60;        // 微弱重力 px/s²
const FALL_MAX = 140;      // 缓降速度上限 px/s
const ANCHOR_GAP = 2.2;    // 乐句锚点最小间隔 s
const ANCHOR_Y_MIN = 200;  // 引航纵向间隔
const ANCHOR_Y_MAX = 320;

// 精灵图表：内容包围盒来自抠图后的实测值，用于底边对齐
const SPRITES = {
  stand: { src: 'assets/月面站立图.png', box: [28, 2, 107, 117] },
  rise:  { src: 'assets/跳跃上升图.png', box: [18, 15, 87, 106] },
  fall:  { src: 'assets/跳跃下落图.png', box: [19, 13, 90, 99] },
};
const images = {};

function resize() {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

// ---------- 设置与最高纪录（IndexedDB，见设计文档第九节） ----------
const settings = { muted: false, volume: 0.8, reduceFx: false };
let best = 0;
let songRecords = {}; // 音乐模式每首曲子独立记录最高分与最远进度
let idb = null;

function idbOpen() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('star-collector', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { idb = req.result; resolve(); };
      req.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

function idbLoad() {
  return new Promise((resolve) => {
    if (!idb) { resolve(); return; }
    try {
      const req = idb.transaction('kv').objectStore('kv').get('state');
      req.onsuccess = () => {
        const v = req.result;
        if (v) {
          Object.assign(settings, v.settings || {});
          best = v.best || 0;
          songRecords = v.songs || {};
        }
        resolve();
      };
      req.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

function idbSave() {
  if (!idb) return;
  try {
    idb.transaction('kv', 'readwrite').objectStore('kv').put({ settings, best, songs: songRecords }, 'state');
  } catch (e) { /* 写入失败不阻断游戏 */ }
}

// ---------- 音效（Web Audio 合成铃音，首次起跳点击创建上下文） ----------
let actx = null;

function ensureAudio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (actx.state === 'suspended') actx.resume();
}

function tone(freq, dur, peak, type, when) {
  if (!actx || settings.muted) return;
  const t = when ?? actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type || 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak * settings.volume, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function soundJump() { tone(280, 0.25, 0.16, 'triangle'); }
function soundStar() { tone(760, 0.35, 0.2); tone(1520, 0.22, 0.07); }

// ---------- 音乐模式（M4，规则见设计文档第八节） ----------
function noteFreq(pitch) { return 440 * Math.pow(2, (pitch - 69) / 12); }

// 从解析结果生成关卡（引航形态）：选主旋律轨 → 筛乐句锚点 → 音高映射横坐标、纵向随机铺开
function buildSong(parsed, name) {
  const candidates = parsed.tracks.filter((t) => t.notes.length);
  if (!candidates.length) throw new Error('没有音符');
  candidates.sort((a, b) => b.notes.length - a.notes.length);
  const notes = candidates[0].notes;

  // 乐句锚点：相邻间隔 ≥ ANCHOR_GAP 秒，簇内优先留时值长的音
  const sel = [];
  for (const n of notes) {
    if (!sel.length || n.time - sel[sel.length - 1].time >= ANCHOR_GAP) sel.push(n);
    else if (n.dur > sel[sel.length - 1].dur && n.time - (sel.length > 1 ? sel[sel.length - 2].time : -9) >= ANCHOR_GAP) sel[sel.length - 1] = n;
  }

  // 音高 → 横坐标：全曲音域拉满屏（最低音贴左、最高音贴右）
  let minP = 127, maxP = 0, duration = 0;
  for (const n of notes) {
    minP = Math.min(minP, n.pitch);
    maxP = Math.max(maxP, n.pitch);
  }
  const span = Math.max(1, maxP - minP);
  const pitchX = (p) => EDGE + ((p - minP) / span) * (W - 2 * EDGE);

  const songStars = [];
  let y = 150;
  for (const n of sel) {
    songStars.push({ x: pitchX(n.pitch), y, note: n });
    y += ANCHOR_Y_MIN + Math.random() * (ANCHOR_Y_MAX - ANCHOR_Y_MIN);
  }

  // 全部音符按锚点切成乐句段；锚点音本身不重复进段（踩中时单独奏响）
  const all = [];
  for (const t of parsed.tracks) for (const n of t.notes) all.push(n);
  all.sort((a, b) => a.time - b.time);
  for (const n of all) duration = Math.max(duration, n.time + n.dur);
  const segments = sel.map((anchor, i) => {
    const t1 = i + 1 < sel.length ? sel[i + 1].time : Infinity;
    return all.filter((n) => n !== anchor && n.time >= anchor.time && n.time < t1);
  });

  return { name, stars: songStars, segments, total: sel.length, duration };
}

let canonPromise = null;
function loadCanon() {
  if (!canonPromise) {
    canonPromise = fetch('../assets/canon.mid')
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((buf) => buildSong(MidiParse.parse(buf), '卡农（D 大调）'));
  }
  return canonPromise;
}

function startMusic() {
  const status = $('musicStatus');
  status.textContent = '解析中…';
  loadCanon()
    .then((s) => {
      song = s;
      $('panel').classList.add('hidden');
      $('home').classList.add('hidden');
      resetGame('music');
    })
    .catch(() => { status.textContent = '加载失败：本地文件模式下音乐功能不可用'; });
}

// ---------- 游戏状态 ----------
// 世界坐标：wy 为脚底距月面的高度（向上为正，月面为 0）
// 角色在屏幕上固定于 PLAYER_SY，镜头始终绑定角色
const player = {
  x: W / 2,
  wy: 0,
  vy: 0, // 向上为正
  onGround: true,
  face: 'left', // 素材图默认朝左
};

// 状态：idle 待机 / play 游戏中 / over 结算；paused 为切后台自动暂停
let state = 'idle';
let paused = false;
let score = 0;
let count = 0;
let squash = 0; // 踩星时脚部短促压缩的剩余时间

// 音乐模式：mode 为 'free' 或 'music'
let mode = 'free';
let song = null;      // { name, stars, segments, total, duration }
let seg = 0;          // 已踩锚点数 = 下一段乐句的索引
let segStartT = 0;    // 当前乐句真实开始时刻（actx 时钟）
let segEndT = 0;      // 当前乐句应然结束时刻（perfect 判定基准）
let segGain = null;   // 当前乐句的增益节点，抢拍时淡出余音
let ratings = { perfect: 0, good: 0, rush: 0, late: 0 };

// 星星与阶梯游标（世界坐标）
let stars = [];
const ladder = { x: W / 2, y: 0, dir: 1 };

// 踩星反馈：粒子与飘字
let particles = [];
let floaters = [];

// 延迟跟随：记录鼠标 x 的历史，角色追向 FOLLOW_DELAY 秒前的位置
const mouseTrail = [];
let mouseX = W / 2;

// 引航飞行状态（音乐模式）：上下左右朝鼠标漂移，按住加速，松开快速减速
let holding = false;
let mouseSy = PLAYER_SY;
let flyCap = DRIFT_MAX;
let fallV = 0;

function delayedTarget(now) {
  const t = now - FOLLOW_DELAY;
  while (mouseTrail.length > 1 && mouseTrail[1].t <= t) mouseTrail.shift();
  return mouseTrail.length ? mouseTrail[0].x : mouseX;
}

function canvasX(event) {
  const rect = canvas.getBoundingClientRect();
  return ((event.clientX - rect.left) / rect.width) * W;
}

function pointerMove(event) {
  mouseX = canvasX(event);
  const rect = canvas.getBoundingClientRect();
  mouseSy = ((event.clientY - rect.top) / rect.height) * H;
}

const overBtn = { x: W / 2 - 90, y: H / 2 + 40, w: 180, h: 48 };

function pointerDown(event) {
  if (paused) { paused = false; if (actx) actx.resume(); return; }
  if (state === 'idle') {
    ensureAudio();
    soundJump();
    state = 'play';
    if (mode !== 'music') {
      player.vy = BOUNCE_V;
      player.onGround = false;
    }
    // 音乐模式：点击只是解除待机，乐曲在踩中第一颗锚点星时开始
  } else if (state === 'over') {
    const rect = canvas.getBoundingClientRect();
    const cx = canvasX(event);
    const cy = ((event.clientY - rect.top) / rect.height) * H;
    if (cx >= overBtn.x && cx <= overBtn.x + overBtn.w && cy >= overBtn.y && cy <= overBtn.y + overBtn.h) {
      resetGame();
    }
  }
}

function resetGame(m) {
  if (m) mode = m;
  state = 'idle';
  paused = false;
  score = 0;
  count = 0;
  squash = 0;
  seg = 0;
  segStartT = 0;
  segEndT = 0;
  segGain = null;
  ratings = { perfect: 0, good: 0, rush: 0, late: 0 };
  flyCap = DRIFT_MAX;
  fallV = 0;
  holding = false;
  player.x = W / 2;
  player.wy = 0;
  player.vy = 0;
  player.onGround = true;
  particles = [];
  floaters = [];
  if (mode === 'music' && song) {
    stars = song.stars.map((s) => ({ x: s.x, y: s.y, note: s.note })); // 整首曲子开局即铺完
  } else {
    stars = [];
    ladder.x = W / 2;
    ladder.y = 0;
    ladder.dir = Math.random() < 0.5 ? -1 : 1;
  }
}

const rand = (a, b) => a + Math.random() * (b - a);

// 阶梯生成：随到随铺，保持角色上方约两个画面高度内有星
function ensureStars() {
  if (mode === 'music') return; // 音乐模式阶梯已在开局铺完
  const target = player.wy + GEN_AHEAD;
  while (ladder.y < target) {
    let nx = ladder.x + ladder.dir * rand(STEP_X_MIN, STEP_X_MAX);
    if (nx < EDGE || nx > W - EDGE) {
      ladder.dir *= -1; // 触及边界折返
      nx = ladder.x + ladder.dir * rand(STEP_X_MIN, STEP_X_MAX);
    }
    ladder.x = Math.max(EDGE, Math.min(W - EDGE, nx));
    ladder.y += rand(STEP_Y_MIN, STEP_Y_MAX);
    stars.push({ x: ladder.x, y: ladder.y });
  }
}

function collectStar(index, s) {
  count += 1;
  const pts = 100 + 10 * (count - 1); // 第 n 颗：100 + 10 × (n − 1)
  score += pts;
  stars.splice(index, 1);
  player.vy = BOUNCE_V; // 踩中立即向上弹起
  squash = 0.12;
  soundStar();
  burstStar(s, '+' + pts);
}

function burstStar(s, text) {
  floaters.push({ x: s.x, y: s.y, text, life: 0.9, max: 0.9 });
  if (!settings.reduceFx) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      particles.push({ x: s.x, y: s.y, vx: Math.cos(a) * 150, vy: Math.sin(a) * 150, life: 0.6, max: 0.6 });
    }
  }
}

// ---------- 引航形态：钢琴音色 + 乐句跟随播放 ----------
let wafPlayer = null;

function pianoNote(pitch, dur, gain, when, dest) {
  if (!actx || settings.muted) return;
  if (window._tone_0000_FluidR3_GM_sf2_file) {
    if (!wafPlayer) wafPlayer = new WebAudioFontPlayer();
    wafPlayer.queueWaveTable(actx, dest || actx.destination, _tone_0000_FluidR3_GM_sf2_file,
      when, pitch, Math.max(dur, 0.4), Math.min(1, gain * 2) * settings.volume);
  } else {
    tone(noteFreq(pitch), Math.min(dur, 1.2), gain * 0.6, 'sine', when);
  }
}

// 本段乐句时长：到下一锚点，末段到全曲末尾
function segDur(i) {
  const t0 = song.stars[i].note.time;
  if (i + 1 < song.stars.length) return song.stars[i + 1].note.time - t0;
  return Math.max(1.5, song.duration - t0);
}

// 踩中锚点星：奏响锚点音，调度本段乐句，判定 perfect/good/抢拍
function touchAnchor(s) {
  count += 1;
  const pts = 100 + 10 * (count - 1);
  score += pts;
  squash = 0.12;

  let grade = '';
  if (actx) {
    const T = actx.currentTime;
    if (seg > 0) {
      const diff = T - segEndT; // 负 = 提前（抢拍），正 = 迟到
      if (Math.abs(diff) <= 0.1) { grade = ' Perfect'; ratings.perfect++; }
      else if (diff < -0.3) { grade = ' 抢拍'; ratings.rush++; }
      else if (Math.abs(diff) <= 0.3) { grade = ' Good'; ratings.good++; }
      else ratings.late++; // 迟到的代价是刚才的音乐空白，不评级
    }
    // 淡出上一段未播完的余音（抢拍时尤为明显）
    if (segGain) {
      try {
        segGain.gain.cancelScheduledValues(T);
        segGain.gain.setValueAtTime(segGain.gain.value, T);
        segGain.gain.linearRampToValueAtTime(0.0001, T + 0.08);
      } catch (e) { /* 忽略 */ }
    }
    segStartT = T;
    segGain = actx.createGain();
    segGain.connect(actx.destination);
    pianoNote(s.note.pitch, Math.min(Math.max(s.note.dur, 0.5), 2), 0.5, T);
    for (const n of song.segments[seg]) {
      pianoNote(n.pitch, Math.min(n.dur, 3), 0.32, T + (n.time - s.note.time), segGain);
    }
    segEndT = T + segDur(seg);
    seg += 1;
  }
  stars.shift();
  burstStar(s, '+' + pts + grade);
}

// 目标星亮度：乐句过半渐亮，播完最亮并缓慢呼吸等待
function anchorGlow(now) {
  if (!actx || state !== 'play') return 0.6 + 0.3 * Math.sin(now * 3);
  if (actx.currentTime >= segEndT) return 0.75 + 0.25 * Math.sin(now * 4);
  const prog = (actx.currentTime - segStartT) / Math.max(0.001, segEndT - segStartT);
  if (prog < 0.5) return 0.15;
  return 0.15 + 0.85 * ((prog - 0.5) / 0.5);
}

// 引航飞行：朝鼠标漂移，按住加速，松开快速减速，微弱重力
function updateFlight(dt) {
  flyCap += ((holding ? BOOST_MAX : DRIFT_MAX) - flyCap) * Math.min(1, dt * SPEED_EASE);
  const ty = player.wy + (PLAYER_SY - mouseSy); // 鼠标屏幕位置对应的世界高度
  const dx = mouseX - player.x;
  const dy = ty - player.wy;
  const dist = Math.hypot(dx, dy);
  let vyEff = 0;
  if (dist > 2) {
    const sp = Math.min(flyCap, dist * FLY_ARRIVE);
    const mx = (dx / dist) * sp * dt;
    const my = (dy / dist) * sp * dt;
    player.x += mx;
    player.wy += my;
    vyEff = my / dt;
    if (my > 0) fallV = 0; // 主动上移时重置下坠
    if (Math.abs(mx / dt) > 20) player.face = mx > 0 ? 'right' : 'left';
  }
  if (player.wy > 0) {
    fallV = Math.min(FALL_MAX, fallV + FLOAT_G * dt);
    player.wy -= fallV * dt;
    vyEff -= fallV;
    if (player.wy <= 0) { player.wy = 0; fallV = 0; }
  } else {
    player.wy = 0;
    fallV = 0;
  }
  player.vy = vyEff; // 供上升/下降 sprite 选择
  player.onGround = player.wy <= 0;
  const half = CHAR_H * 0.35;
  player.x = Math.max(half, Math.min(W - half, player.x));
}

function endGame() {
  state = 'over';
  best = Math.max(best, score);
  if (mode === 'music' && song) {
    const rec = songRecords[song.name] || { best: 0, progress: 0 };
    rec.best = Math.max(rec.best, score);
    rec.progress = Math.max(rec.progress, seg);
    songRecords[song.name] = rec;
  }
  idbSave();
}

function update(dt, now) {
  mouseTrail.push({ t: now, x: mouseX });
  while (mouseTrail.length > 2 && mouseTrail[0].t < now - FOLLOW_DELAY - 0.5) mouseTrail.shift();

  if (paused) return;

  // 粒子与飘字在任何非暂停状态下继续消散
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].life -= dt;
    if (floaters[i].life <= 0) floaters.splice(i, 1);
  }
  squash = Math.max(0, squash - dt);

  if (state === 'over') return;

  if (mode === 'music') {
    updateFlight(dt);
    if (state === 'play' && stars.length) {
      const s = stars[0]; // 只有当前目标锚点可触碰，其余星星只是路标
      if (Math.hypot(s.x - player.x, s.y - player.wy) < STAR_R + 22) touchAnchor(s);
    }
    // 末段乐句播完即曲终结算（音乐模式无失败）
    if (state === 'play' && song && seg >= song.total && actx && actx.currentTime >= segEndT) endGame();
  } else {
    const target = delayedTarget(now);
    const dx = target - player.x;
    const step = Math.sign(dx) * Math.min(Math.abs(dx), FOLLOW_MAX * dt);
    player.x += step;
    if (Math.abs(step) > 0.5) player.face = step > 0 ? 'right' : 'left';

    const half = CHAR_H * 0.35;
    player.x = Math.max(half, Math.min(W - half, player.x));

    if (state === 'play' && !player.onGround) {
      const prevWy = player.wy;
      player.vy -= GRAVITY * dt;
      player.wy += player.vy * dt;

      // 踩星判定：横向容差内，竖直方向跨过或贴近星位即触发（含下落自救）
      for (let i = stars.length - 1; i >= 0; i--) {
        const s = stars[i];
        if (Math.abs(s.x - player.x) > STAR_R + 20) continue;
        const crossed = (prevWy - s.y) * (player.wy - s.y) <= 0;
        const near = Math.abs(s.y - player.wy) < STAR_R + 14;
        if (crossed || near) {
          collectStar(i, s);
          break;
        }
      }

      if (player.wy <= 0) {
        player.wy = 0;
        player.vy = 0;
        player.onGround = true;
        endGame(); // 首次起跳后落地即结束本局
      }
    }
  }

  ensureStars();
}

// 世界高度 → 屏幕 y（镜头绑定角色）
function sy(wy) {
  return PLAYER_SY - (wy - player.wy);
}

function drawBackground(now) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#060b1b');
  sky.addColorStop(1, '#111f3b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(164,202,255,.62)';
  const dotCount = settings.reduceFx ? 40 : 90;
  for (let i = 0; i < dotCount; i++) {
    const px = (i * 137) % W;
    const py = (i * 71) % H;
    const twinkle = 1 + Math.sin(now / 800 + i) * 0.35;
    ctx.beginPath();
    ctx.arc(px, py, twinkle, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(103,150,220,.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(W * 0.72, H * 0.3, 120, 28, -0.18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(W * 0.72, H * 0.3, 170, 40, -0.18, 0, Math.PI * 2);
  ctx.stroke();

  // 月面：位于世界高度 0，镜头升高后移出画面
  const moonSy = sy(0);
  if (moonSy < H + 80) {
    ctx.fillStyle = '#5b6472';
    ctx.beginPath();
    ctx.ellipse(W / 2, moonSy + 640, 1100, 660, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4c5460';
    for (const [cx, off, r] of [[180, 41, 26], [420, 53, 18], [700, 46, 30], [880, 57, 14]]) {
      ctx.beginPath();
      ctx.ellipse(cx, moonSy + off, r, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function starPath(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawStars(now) {
  ctx.save();
  ctx.shadowColor = 'rgba(255,240,180,.9)';
  ctx.fillStyle = '#fff6d8';
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const y = sy(s.y);
    if (y < -30 || y > H + 30) continue;
    if (mode === 'music') {
      if (i === 0) {
        // 当前目标锚点：呼吸灯标示时机
        const g = anchorGlow(now);
        ctx.globalAlpha = 0.35 + 0.65 * g;
        ctx.shadowBlur = 10 + 26 * g;
        starPath(s.x, y, STAR_R * (0.9 + 0.5 * g));
      } else {
        // 未到的锚点：暗星路标
        ctx.globalAlpha = 0.28;
        ctx.shadowBlur = 8;
        starPath(s.x, y, STAR_R);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.shadowBlur = 12;
      starPath(s.x, y, STAR_R);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawParticles() {
  ctx.fillStyle = '#ffe59b';
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    starPath(p.x, sy(p.y), 4);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFloaters() {
  ctx.textAlign = 'center';
  ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
  for (const f of floaters) {
    const t = 1 - f.life / f.max;
    ctx.globalAlpha = Math.max(0, f.life / f.max);
    ctx.fillStyle = '#ffe59b';
    ctx.fillText(f.text, f.x, sy(f.y) - 20 - t * 40);
  }
  ctx.globalAlpha = 1;
}

function drawPlayer() {
  const key = player.onGround ? 'stand' : (player.vy > 0 ? 'rise' : 'fall');
  const sprite = SPRITES[key];
  const img = images[key];
  if (!img) return;

  const [sx0, sy0, ex, ey] = sprite.box;
  const sw = ex - sx0;
  const sh = ey - sy0;
  const dh = CHAR_H;
  const dw = (sw / sh) * dh;

  // 接触阴影：离地越高越淡
  const alpha = Math.max(0, 0.35 - player.wy / 800);
  const moonSy = sy(0);
  if (alpha > 0 && moonSy < H + 10) {
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(player.x, moonSy + 6, dw * 0.42, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(player.x, PLAYER_SY);
  if (player.face === 'right') ctx.scale(-1, 1);
  if (squash > 0) ctx.scale(1.12, 0.84); // 踩星瞬间短促压缩
  ctx.drawImage(img, sx0, sy0, sw, sh, -dw / 2, -dh, dw, dh);
  ctx.restore();
}

function drawHud() {
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`得分 ${score}`, 16, 34);
  ctx.fillText(`星星 ${count}`, 16, 60);
  if (mode === 'music' && song) ctx.fillText(`${song.name} ・ 乐句 ${seg}/${song.total} ・ Perfect ${ratings.perfect}`, 16, 86);
}

function drawIdle() {
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = '22px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(mode === 'music'
    ? '移动鼠标飞行，按住加速 · 触碰最亮的星星开始演奏'
    : '单击起跳，移动鼠标接住下一颗星', W / 2, H * 0.4);
}

function drawPaused() {
  ctx.fillStyle = 'rgba(6,11,27,.6)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = '24px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('已暂停 · 点击画面继续', W / 2, H / 2);
}

function drawOver() {
  ctx.fillStyle = 'rgba(6,11,27,.72)';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#16223f';
  ctx.strokeStyle = 'rgba(164,202,255,.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(W / 2 - 190, H / 2 - 130, 380, 250, 14);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff6d8';
  ctx.font = 'bold 30px "Microsoft YaHei", sans-serif';
  ctx.fillText(mode === 'music' ? '演奏完成' : '回到月面', W / 2, H / 2 - 84);

  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.fillText(`总分 ${score} ・ 摘星 ${count} 颗`, W / 2, H / 2 - 56);
  ctx.fillText(`最高纪录 ${best}`, W / 2, H / 2 - 24);
  if (mode === 'music' && song) {
    ctx.fillText(`演奏进度 ${seg} / ${song.total} 乐句`, W / 2, H / 2 + 8);
    ctx.fillText(`Perfect ${ratings.perfect} ・ Good ${ratings.good} ・ 抢拍 ${ratings.rush}`, W / 2, H / 2 + 36);
  }

  ctx.fillStyle = '#3a5b9e';
  ctx.beginPath();
  ctx.roundRect(overBtn.x, overBtn.y, overBtn.w, overBtn.h, 10);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.fillText('再玩一次', W / 2, overBtn.y + 31);
}

let lastTime;
function frame(nowMs) {
  const now = nowMs / 1000;
  const dt = Math.min(now - (lastTime ?? now), 1 / 30);
  lastTime = now;

  update(dt, now);
  drawBackground(nowMs);
  drawStars(now);
  drawParticles();
  drawPlayer();
  drawFloaters();
  drawHud();
  if (state === 'idle') drawIdle();
  if (state === 'over') drawOver();
  if (paused) drawPaused();
  requestAnimationFrame(frame);
}

function loadSprites() {
  for (const [key, sprite] of Object.entries(SPRITES)) {
    const img = new Image();
    img.src = sprite.src;
    images[key] = img;
  }
}

// ---------- 界面 wiring（首页三入口、声音与音乐按钮、设置） ----------
function $(id) { return document.getElementById(id); }

function applySettingsToUi() {
  $('vol').value = Math.round(settings.volume * 100);
  $('reduceFx').checked = settings.reduceFx;
  $('btnMute').textContent = settings.muted ? '声音：关' : '声音：开';
}

const PANELS = {
  help: {
    title: '玩法说明',
    body: '<p>单击画面从月面起跳，空中移动鼠标控制左右。</p>' +
          '<p>踩到星星立即弹起：第 1 颗 100 分，之后每颗多 10 分。</p>' +
          '<p>下落途中碰到星星也能自救弹起。落回月面本局结束。</p>' +
          '<p>音乐模式：移动鼠标飞行，按住加速；触碰最亮的星星为乐句"揭幕"，中间的旋律自动播放。</p>' +
          '<p>切到后台自动暂停，回来点一下画面继续。</p>',
  },
  music: {
    title: '音乐选择',
    body: '<p>内置曲目：卡农（D 大调）</p>' +
          '<p><button id="btnPlayCanon" class="primary" type="button">开始演奏</button></p>' +
          '<p id="musicStatus" style="color:#a8b7d1"></p>',
  },
};

function openPanel(kind) {
  $('panelTitle').textContent = PANELS[kind].title;
  $('panelBody').innerHTML = PANELS[kind].body;
  if (kind === 'music') $('btnPlayCanon').addEventListener('click', startMusic);
  $('panel').classList.remove('hidden');
  if (state === 'play') paused = true;
}

function wireUi() {
  $('btnStart').addEventListener('click', () => $('home').classList.add('hidden'));
  $('btnHelp').addEventListener('click', () => openPanel('help'));
  $('btnMusic').addEventListener('click', () => openPanel('music'));
  $('btnMusicTop').addEventListener('click', () => openPanel('music'));
  $('panelClose').addEventListener('click', () => $('panel').classList.add('hidden'));
  $('btnMute').addEventListener('click', () => {
    settings.muted = !settings.muted;
    applySettingsToUi();
    idbSave();
  });
  $('vol').addEventListener('input', (e) => {
    settings.volume = e.target.value / 100;
    idbSave();
  });
  $('reduceFx').addEventListener('change', (e) => {
    settings.reduceFx = e.target.checked;
    idbSave();
  });
  if (location.protocol === 'file:') $('fileBanner').classList.remove('hidden');
}

// 切到后台自动暂停，恢复时由玩家点击继续；音频上下文一并挂起保持乐曲对齐
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') {
    paused = true;
    if (actx) actx.suspend();
  }
});

canvas.addEventListener('mousemove', pointerMove);
canvas.addEventListener('click', pointerDown);
canvas.addEventListener('mousedown', () => { holding = true; }); // 引航：按住加速
window.addEventListener('mouseup', () => { holding = false; });   // 松开快速减速
window.addEventListener('resize', resize);

(async function boot() {
  resize();
  loadSprites();
  resetGame();
  wireUi();
  await idbOpen();
  await idbLoad();
  applySettingsToUi();
  requestAnimationFrame(frame);
})();
