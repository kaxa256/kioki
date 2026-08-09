/* =============================================================================
   CACING KAWAII — game.js
   Worm/snake .io-style game, 60fps canvas renderer, live dashboard + leaderboard.

   ─────────────────────────────────────────────────────────────────────────
   INTEGRASI BACKEND — SUPABASE (Realtime + Postgres)
   ─────────────────────────────────────────────────────────────────────────
   Isi CONFIG.SUPABASE_URL & CONFIG.SUPABASE_ANON_KEY di bawah. Arsitekturnya:

   1) POSISI PEMAIN REAL-TIME → Supabase Realtime "Broadcast" (channel room),
      bukan tabel DB — supaya latensinya rendah & tidak membanjiri Postgres.
      Setiap client broadcast posisi sendiri ~15x/detik, dan menerima broadcast
      pemain lain untuk digambar (dengan interpolasi supaya tetap mulus 60fps).

   2) SIAPA YANG ONLINE → Supabase Realtime "Presence" pada channel yang sama.

   3) PAPAN PERINGKAT (PERSISTEN) → tabel Postgres `scores`, di-upsert saat
      pemain mati / skor naik, dan disiarkan ke semua client lewat
      "postgres_changes". Bikin tabelnya di SQL editor Supabase:

        create table scores (
          id text primary key,
          username text not null,
          score int not null default 0,
          updated_at timestamptz default now()
        );
        alter table scores enable row level security;
        create policy "public read"  on scores for select using (true);
        create policy "public write" on scores for insert with check (true);
        create policy "public update" on scores for update using (true);

      Lalu di Database → Replication, aktifkan realtime untuk tabel `scores`.

   4) MAKANAN (food) di-generate deterministik di client (seeded random) jadi
      semua client melihat layout awal yang sama tanpa perlu tabel khusus.
      Saat dimakan, event 'eat' di-broadcast supaya client lain ikut hapus.
      (Kalau mau 100% sinkron termasuk saat banyak pemain, upgrade ke tabel
      `food` + postgres_changes seperti scores di atas.)

   Kalau CONFIG.SUPABASE_URL kosong, game jatuh ke CONFIG.WS_URL (WebSocket
   custom biasa) — dan kalau itu juga kosong, jalan DEMO MODE (bot lokal)
   supaya file ini tetap bisa langsung dibuka & dites tanpa backend apapun.
   ============================================================================= */

const CONFIG = {
  // 🔧 Supabase (rekomendasi — isi ini)
  SUPABASE_URL: "https://epmatlqjhpmzryqdahuf.supabase.co",             // contoh: "https://xxxxx.supabase.co"
  SUPABASE_ANON_KEY: "sb_publishable_VmOBVLB7TLOexeR4l0QoVA__JBzha3s",        // anon/public key dari Project Settings → API
  SUPABASE_ROOM: "worm-arena",  // nama channel realtime (bisa dibuat per-room)
  SUPABASE_LEADERBOARD_TABLE: "scores",

  // 🔧 Alternatif: WebSocket custom kamu sendiri (dipakai kalau Supabase kosong)
  WS_URL: "",                   // contoh: "wss://api.punyakamu.com/ws"

  DEMO_MODE_FALLBACK: true,     // jalankan simulasi lokal kalau semua backend di atas kosong/gagal
  FOOD_SEED: "worm-arena-v1",   // seed layout makanan biar semua client sama
  FOOD_COUNT_LIVE: 300,         // jumlah makanan awal saat pakai Supabase/WebSocket

  WORLD_SIZE: 4200,
  BASE_SPEED: 160,            // px/detik
  BOOST_MULT: 1.85,
  TURN_RATE: 4.2,             // radian/detik
  SEGMENT_SPACING: 9,
  PATH_SAMPLE_DIST: 4,
  BOOST_DRAIN_PER_SEC: 6,
  MIN_SCORE_TO_BOOST: 24,
  FOOD_COUNT_DEMO: 260,
  BOT_COUNT_DEMO: 9,
  INPUT_SEND_HZ: 15,
};

const COLORS = ["#C0524A", "#E3B23C", "#9FC7B8", "#B98BC9", "#E89F8C", "#7FB0D6", "#D6A97A", "#8FBF7F"];

// ---------------------------------------------------------------------------
// Small math utils
// ---------------------------------------------------------------------------
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function angleDiff(target, current) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function samplePathAt(points, targetDist) {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const segLen = dist(a, b);
    if (acc + segLen >= targetDist) {
      const t = segLen === 0 ? 0 : (targetDist - acc) / segLen;
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    }
    acc += segLen;
  }
  return points[points.length - 1] || points[0] || { x: 0, y: 0 };
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}
function randRange(a, b) { return a + Math.random() * (b - a); }

// Seeded PRNG (mulberry32) — dipakai supaya semua client generate layout
// makanan awal yang identik tanpa perlu round-trip ke server.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
function generateDeterministicFood(seedStr, n) {
  const rnd = mulberry32(hashSeed(seedStr));
  const food = new Map();
  for (let i = 0; i < n; i++) {
    const id = "f" + i;
    food.set(id, {
      id,
      x: (rnd() - 0.5) * CONFIG.WORLD_SIZE,
      y: (rnd() - 0.5) * CONFIG.WORLD_SIZE,
      color: COLORS[Math.floor(rnd() * COLORS.length)],
      value: rnd() < 0.12 ? 4 : 1,
    });
  }
  return food;
}

// ---------------------------------------------------------------------------
// Worm entity — shared by local player and other players (bots or real)
// ---------------------------------------------------------------------------
class Worm {
  constructor(id, username, color, x, y, isLocal) {
    this.id = id;
    this.username = username || "Tamu";
    this.color = color || COLORS[Math.floor(Math.random() * COLORS.length)];
    this.x = x; this.y = y;
    this.angle = Math.random() * Math.PI * 2;
    this.targetAngle = this.angle;
    this.boosting = false;
    this.score = 12;
    this.kills = 0;
    this.alive = true;
    this.isLocal = !!isLocal;
    this.path = [{ x, y }];
    this.segments = [];
    this.spawnTime = performance.now();
    // remote-only smoothing targets
    this.netX = x; this.netY = y; this.netAngle = this.angle;
  }
  get length() { return Math.max(5, Math.floor(this.score / 1.6)); }
  get radius() { return clamp(7 + this.length * 0.11, 7, 30); }

  pushPath() {
    const last = this.path[0];
    if (!last || dist(last, { x: this.x, y: this.y }) > CONFIG.PATH_SAMPLE_DIST) {
      this.path.unshift({ x: this.x, y: this.y });
      const maxLen = Math.ceil((this.length * CONFIG.SEGMENT_SPACING) / CONFIG.PATH_SAMPLE_DIST) + 30;
      if (this.path.length > maxLen) this.path.length = maxLen;
    }
  }
  buildSegments() {
    const points = [{ x: this.x, y: this.y }, ...this.path];
    const segs = [];
    for (let i = 0; i < this.length; i++) {
      segs.push(samplePathAt(points, i * CONFIG.SEGMENT_SPACING));
    }
    this.segments = segs;
  }

  // Local player: full client physics, driven by input target angle
  updateLocal(dt, targetAngle, boosting) {
    this.targetAngle = targetAngle;
    const diff = angleDiff(this.targetAngle, this.angle);
    const maxTurn = CONFIG.TURN_RATE * dt;
    this.angle += clamp(diff, -maxTurn, maxTurn);
    this.boosting = boosting && this.score > CONFIG.MIN_SCORE_TO_BOOST;
    const spd = CONFIG.BASE_SPEED * (this.boosting ? CONFIG.BOOST_MULT : 1);
    this.x += Math.cos(this.angle) * spd * dt;
    this.y += Math.sin(this.angle) * spd * dt;
    if (this.boosting) this.score = Math.max(10, this.score - CONFIG.BOOST_DRAIN_PER_SEC * dt);
    this.pushPath();
    this.buildSegments();
  }

  // Remote player: smoothly chase the latest network snapshot every frame,
  // so rendering stays 60fps smooth even if server ticks slower.
  updateRemote(dt) {
    const followRate = 10; // higher = snappier catch-up to server truth
    const t = 1 - Math.exp(-followRate * dt);
    this.x = lerp(this.x, this.netX, t);
    this.y = lerp(this.y, this.netY, t);
    this.angle += angleDiff(this.netAngle, this.angle) * t;
    this.pushPath();
    this.buildSegments();
  }

  setNetworkTarget(x, y, angle) {
    this.netX = x; this.netY = y; this.netAngle = angle;
  }
}

// ---------------------------------------------------------------------------
// NetworkManager — thin WebSocket wrapper w/ reconnect + ping
// ---------------------------------------------------------------------------
class NetworkManager {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.lastPingSent = 0;
    this.ping = 0;
    this.handlers = {};
    this.pingTimer = null;
  }
  on(event, cb) { this.handlers[event] = cb; }
  emit(event, data) { if (this.handlers[event]) this.handlers[event](data); }

  connect() {
    if (!CONFIG.WS_URL) { this.emit("fail"); return; }
    try {
      this.ws = new WebSocket(CONFIG.WS_URL);
    } catch (e) { this.emit("fail"); return; }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit("open");
      this.pingTimer = setInterval(() => {
        if (this.connected) { this.lastPingSent = performance.now(); this.send({ type: "ping", t: this.lastPingSent }); }
      }, 2000);
    };
    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.emit("close");
      this.scheduleReconnect();
    };
    this.ws.onerror = () => { this.emit("fail"); };
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "pong") { this.ping = Math.round(performance.now() - this.lastPingSent); return; }
      this.emit(msg.type, msg);
    };
  }
  send(obj) { if (this.connected && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  scheduleReconnect() {
    if (!CONFIG.WS_URL) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * this.reconnectAttempts, 8000);
    setTimeout(() => this.connect(), delay);
  }
}

// ---------------------------------------------------------------------------
// SupabaseNetwork — Realtime Broadcast (posisi) + Presence (online) +
// Postgres `scores` table (leaderboard persisten). Sama API (on/emit/send)
// dengan NetworkManager supaya kelas Game tidak perlu tahu bedanya.
// ---------------------------------------------------------------------------
class SupabaseNetwork {
  constructor() {
    this.connected = false;
    this.handlers = {};
    this.channel = null;
    this.lbChannel = null;
    this.client = null;
    this.ping = 0;
    this.myId = null;
    this.username = "Tamu";
    this.color = "#C0524A";
    this.remoteState = new Map(); // id -> pemain lain (dari broadcast)
    this.pingTimer = null;
  }
  on(event, cb) { this.handlers[event] = cb; }
  emit(event, data) { if (this.handlers[event]) this.handlers[event](data); }

  connect() {
    if (!window.supabase || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) { this.emit("fail"); return; }
    if (!this.myId) this.myId = "p" + Math.random().toString(36).slice(2);
    this.client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

    this.channel = this.client.channel(CONFIG.SUPABASE_ROOM, {
      config: { broadcast: { self: false }, presence: { key: this.myId } },
    });

    this.channel.on("broadcast", { event: "input" }, ({ payload }) => {
      this.remoteState.set(payload.id, payload);
      this.emit("state", { players: [...this.remoteState.values()] });
    });
    this.channel.on("broadcast", { event: "eat" }, ({ payload }) => this.emit("foodEaten", payload));
    this.channel.on("broadcast", { event: "died" }, ({ payload }) => this.emit("death", payload));
    this.channel.on("broadcast", { event: "ping" }, ({ payload }) => {
      if (payload.from !== this.myId) this.channel.send({ type: "broadcast", event: "pong", payload: { to: payload.from, t: payload.t } });
    });
    this.channel.on("broadcast", { event: "pong" }, ({ payload }) => {
      if (payload.to === this.myId) this.ping = Math.round(performance.now() - payload.t);
    });
    this.channel.on("presence", { event: "leave" }, ({ key }) => {
      this.remoteState.delete(key);
      this.emit("state", { players: [...this.remoteState.values()] });
    });

    this.channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        this.connected = true;
        await this.channel.track({ username: this.username, online_at: Date.now() });
        this.emit("open");
        this.pingTimer = setInterval(() => {
          this.channel.send({ type: "broadcast", event: "ping", payload: { from: this.myId, t: performance.now() } });
        }, 3000);
        this.subscribeLeaderboard();
        this.fetchLeaderboard();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        this.connected = false; this.emit("fail");
      } else if (status === "CLOSED") {
        this.connected = false; clearInterval(this.pingTimer); this.emit("close");
      }
    });
  }

  send(obj) {
    if (obj.type === "join") { this.username = obj.username; return; }
    if (!this.connected || !this.channel) return;
    if (obj.type === "input") {
      this.channel.send({ type: "broadcast", event: "input", payload: {
        id: this.myId, username: this.username, color: this.color,
        x: obj.x, y: obj.y, angle: obj.angle, score: obj.score, length: obj.length,
        boosting: obj.boosting, alive: true,
      }});
    } else if (obj.type === "eat") {
      this.channel.send({ type: "broadcast", event: "eat", payload: { foodId: obj.foodId } });
    } else if (obj.type === "died") {
      this.channel.send({ type: "broadcast", event: "died", payload: { id: this.myId, finalScore: obj.finalScore } });
      this.pushScore(obj.finalScore);
    }
  }

  async pushScore(score) {
    if (!this.client) return;
    await this.client.from(CONFIG.SUPABASE_LEADERBOARD_TABLE)
      .upsert({ id: this.myId, username: this.username, score, updated_at: new Date().toISOString() });
  }

  subscribeLeaderboard() {
    this.lbChannel = this.client.channel("leaderboard-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: CONFIG.SUPABASE_LEADERBOARD_TABLE }, () => this.fetchLeaderboard())
      .subscribe();
  }

  async fetchLeaderboard() {
    const { data, error } = await this.client
      .from(CONFIG.SUPABASE_LEADERBOARD_TABLE)
      .select("username,score")
      .order("score", { ascending: false })
      .limit(10);
    if (!error && data) this.emit("leaderboard", { list: data });
  }
}

// ---------------------------------------------------------------------------
// DemoEngine — local bot simulation used only when no real backend is wired.
// Feeds the exact same "state"/"leaderboard" shapes a real server would send,
// so swapping in CONFIG.WS_URL later requires zero changes elsewhere.
// ---------------------------------------------------------------------------
class DemoEngine {
  constructor(onState, onLeaderboard) {
    this.onState = onState;
    this.onLeaderboard = onLeaderboard;
    this.bots = [];
    this.food = [];
    this.tickHandle = null;
  }
  spawnFood(n) {
    for (let i = 0; i < n; i++) {
      this.food.push({
        id: "f" + Math.random().toString(36).slice(2),
        x: randRange(-CONFIG.WORLD_SIZE / 2, CONFIG.WORLD_SIZE / 2),
        y: randRange(-CONFIG.WORLD_SIZE / 2, CONFIG.WORLD_SIZE / 2),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        value: Math.random() < 0.12 ? 4 : 1,
      });
    }
  }
  start() {
    const names = ["Momo", "Kuma", "Beruang", "Sakura", "Mochi", "Yuki", "Bubu", "Choco", "Neko", "Boba"];
    for (let i = 0; i < CONFIG.BOT_COUNT_DEMO; i++) {
      const w = new Worm(
        "bot" + i,
        names[i % names.length] + (i > 9 ? i : ""),
        COLORS[i % COLORS.length],
        randRange(-1500, 1500), randRange(-1500, 1500),
        false
      );
      w.score = randRange(20, 260);
      w._wanderT = randRange(0, 10);
      this.bots.push(w);
    }
    this.spawnFood(CONFIG.FOOD_COUNT_DEMO);
    let last = performance.now();
    this.tickHandle = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      for (const b of this.bots) {
        b._wanderT -= dt;
        if (b._wanderT <= 0) {
          b.targetAngle = b.angle + randRange(-1.4, 1.4);
          b._wanderT = randRange(1.2, 3);
        }
        // steer away from world border
        const r = Math.hypot(b.x, b.y);
        if (r > CONFIG.WORLD_SIZE / 2 - 200) {
          b.targetAngle = Math.atan2(-b.y, -b.x) + randRange(-0.3, 0.3);
        }
        b.updateLocal(dt, b.targetAngle, Math.random() < 0.01);
        // eat nearby food
        for (let i = this.food.length - 1; i >= 0; i--) {
          if (dist(b, this.food[i]) < b.radius + 6) {
            b.score += this.food[i].value * 3;
            this.food.splice(i, 1);
          }
        }
      }
      if (this.food.length < CONFIG.FOOD_COUNT_DEMO * 0.8) this.spawnFood(20);

      const playersPayload = this.bots.map(b => ({
        id: b.id, username: b.username, x: b.x, y: b.y, angle: b.angle,
        score: b.score, length: b.length, color: b.color, alive: true, kills: b.kills,
      }));
      this.onState({ players: playersPayload, food: this.food });
      const list = [...playersPayload].sort((a, b2) => b2.score - a.score).map(p => ({ id: p.id, username: p.username, score: Math.floor(p.score) }));
      this.onLeaderboard({ list });
    }, 66); // ~15Hz simulated server tick — client still renders at 60fps via interpolation
  }
  stop() { clearInterval(this.tickHandle); }
}

// ---------------------------------------------------------------------------
// Game — orchestrates input, physics, rendering, network, UI
// ---------------------------------------------------------------------------
class Game {
  constructor() {
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.miniCanvas = document.getElementById("minimapCanvas");
    this.miniCtx = this.miniCanvas.getContext("2d");

    this.players = new Map();     // id -> Worm
    this.food = new Map();        // id -> {id,x,y,color,value}
    this.localId = "p" + Math.random().toString(36).slice(2);
    this.leaderboardData = [];
    this.online = 1;

    this.pointer = { x: 0, y: 0, active: false };
    this.boosting = false;
    this.joystickVec = { x: 0, y: 0, active: false };

    this.running = false;
    this.lastFrame = performance.now();
    this.fps = 60;
    this.lastInputSend = 0;

    // Pilih backend: Supabase kalau diisi, kalau tidak coba WebSocket custom,
    // kalau keduanya kosong nanti jatuh ke demo mode (lihat DOMContentLoaded).
    if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
      this.backendType = "supabase";
      this.net = new SupabaseNetwork();
      this.net.myId = this.localId;
      this.net.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    } else {
      this.backendType = CONFIG.WS_URL ? "websocket" : "none";
      this.net = new NetworkManager();
    }
    this.demo = null;
    this.usingDemo = false;

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.setupInput();
    this.setupNetworkHandlers();
    this.setupUI();
  }

  // ---- setup -------------------------------------------------------------
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;

    const miniSize = this.miniCanvas.clientWidth || 110;
    this.miniCanvas.width = miniSize * dpr;
    this.miniCanvas.height = miniSize * dpr;
    this.miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setupInput() {
    const cvs = this.canvas;
    cvs.addEventListener("mousemove", (e) => {
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.active = true;
    });
    window.addEventListener("mousedown", (e) => { if (e.target.closest("#boost-btn")) return; this.boosting = true; });
    window.addEventListener("mouseup", () => { this.boosting = false; });
    window.addEventListener("keydown", (e) => { if (e.code === "Space" || e.code === "ShiftLeft") this.boosting = true; });
    window.addEventListener("keyup", (e) => { if (e.code === "Space" || e.code === "ShiftLeft") this.boosting = false; });

    // --- mobile joystick ---
    const zone = document.getElementById("joystick-zone");
    const base = document.getElementById("joystick-base");
    const stick = document.getElementById("joystick-stick");
    let touchId = null, baseX = 0, baseY = 0;
    const maxR = 42;

    const startTouch = (x, y) => {
      touchId = touchId ?? true;
      baseX = x; baseY = y;
      base.style.left = x + "px"; base.style.top = y + "px";
      base.style.display = "block";
      this.joystickVec.active = true;
    };
    const moveTouch = (x, y) => {
      let dx = x - baseX, dy = y - baseY;
      const d = Math.hypot(dx, dy);
      const clampedD = Math.min(d, maxR);
      const ang = Math.atan2(dy, dx);
      const sx = Math.cos(ang) * clampedD, sy = Math.sin(ang) * clampedD;
      stick.style.left = "50%"; stick.style.top = "50%";
      stick.style.transform = `translate(${sx}px, ${sy}px) translate(-50%,-50%)`;
      this.joystickVec = { x: dx / (maxR), y: dy / (maxR), active: true, mag: clampedD / maxR, angle: ang };
    };
    const endTouch = () => {
      touchId = null;
      base.style.display = "none";
      stick.style.transform = "translate(-50%,-50%)";
      this.joystickVec.active = false;
    };

    zone.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      startTouch(t.clientX, t.clientY);
      moveTouch(t.clientX, t.clientY);
    }, { passive: true });
    zone.addEventListener("touchmove", (e) => {
      if (!this.joystickVec.active) return;
      const t = e.changedTouches[0];
      moveTouch(t.clientX, t.clientY);
    }, { passive: true });
    zone.addEventListener("touchend", endTouch);
    zone.addEventListener("touchcancel", endTouch);

    const boostBtn = document.getElementById("boost-btn");
    const setBoost = (v) => (e) => { e.preventDefault(); this.boosting = v; };
    boostBtn.addEventListener("touchstart", setBoost(true), { passive: false });
    boostBtn.addEventListener("touchend", setBoost(false), { passive: false });
    boostBtn.addEventListener("mousedown", setBoost(true));
    boostBtn.addEventListener("mouseup", setBoost(false));
  }

  setupNetworkHandlers() {
    this.net.on("open", () => {
      this.usingDemo = false;
      document.getElementById("conn-dot").classList.remove("offline");
      document.getElementById("server-dot").style.background = "#9FC7B8";
      document.getElementById("server-status-text").textContent = "Terhubung ke server";
      this.net.send({ type: "join", username: this.username });
    });
    this.net.on("close", () => {
      document.getElementById("conn-dot").classList.add("offline");
    });
    this.net.on("fail", () => {
      document.getElementById("server-dot").style.background = "#C08552";
      document.getElementById("server-status-text").textContent = CONFIG.DEMO_MODE_FALLBACK
        ? "Server offline — mode demo aktif"
        : "Gagal terhubung ke server";
      if (CONFIG.DEMO_MODE_FALLBACK && !this.usingDemo) this.startDemoMode();
    });
    this.net.on("welcome", (msg) => { if (msg.id) this.localId = msg.id; });
    this.net.on("state", (msg) => this.applyServerState(msg));
    this.net.on("leaderboard", (msg) => { this.leaderboardData = msg.list || []; });
    this.net.on("death", (msg) => {
      if (msg.id === this.localId) { this.onLocalDeath(msg); return; }
      const w = this.players.get(msg.id);
      if (w) w.alive = false; // pemain lain mati — hilang dari render, tetap muncul sebentar di leaderboard
    });
    this.net.on("foodEaten", (msg) => { if (msg.foodId) this.food.delete(msg.foodId); });
  }

  startDemoMode() {
    this.usingDemo = true;
    this.demo = new DemoEngine(
      (state) => this.applyServerState(state),
      (lb) => { this.leaderboardData = lb.list || []; }
    );
    this.demo.start();
  }

  applyServerState(state) {
    const seen = new Set();
    for (const p of state.players || []) {
      if (p.id === this.localId) continue; // local player is client-authoritative
      seen.add(p.id);
      let w = this.players.get(p.id);
      if (!w) {
        w = new Worm(p.id, p.username, p.color, p.x, p.y, false);
        this.players.set(p.id, w);
      }
      w.username = p.username; w.score = p.score; w.kills = p.kills || 0; w.alive = p.alive !== false;
      w.setNetworkTarget(p.x, p.y, p.angle || 0);
    }
    for (const id of [...this.players.keys()]) {
      if (id !== this.localId && !seen.has(id)) this.players.delete(id);
    }
    // Beberapa backend (mis. Supabase broadcast) tidak mengirim food di tiap
    // 'state' — makanan diurus lokal (deterministik) + event 'eat'/'foodEaten'.
    // Hanya timpa this.food kalau backend memang menyertakan array food.
    if (state.food) {
      this.food.clear();
      for (const f of state.food) this.food.set(f.id, f);
    }
    this.online = (state.players ? state.players.length : 0) + 1;
  }

  setupUI() {
    document.getElementById("play-btn").addEventListener("click", () => this.startGame());
    document.getElementById("respawn-btn").addEventListener("click", () => this.startGame());
    document.getElementById("username-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startGame();
    });
  }

  startGame() {
    const input = document.getElementById("username-input");
    this.username = (input.value || "").trim().slice(0, 14) || "Tamu" + Math.floor(Math.random() * 999);
    document.getElementById("hud-username").textContent = this.username;
    this.net.username = this.username; // dipakai saat presence.track() / broadcast

    const myColor = this.net.color || "#C0524A";
    const local = new Worm(this.localId, this.username, myColor, randRange(-500, 500), randRange(-500, 500), true);
    this.players.set(this.localId, local);

    if (!this.usingDemo && this.food.size === 0 && this.backendType !== "none") {
      this.food = generateDeterministicFood(CONFIG.FOOD_SEED, CONFIG.FOOD_COUNT_LIVE);
    }

    document.getElementById("start-screen").classList.add("hidden");
    document.getElementById("death-screen").classList.add("hidden");

    if (!this.running) {
      this.running = true;
      requestAnimationFrame((t) => this.loop(t));
    }
    if (!this.net.connected && !this.usingDemo) this.net.connect();
  }

  onLocalDeath(msg) {
    const local = this.players.get(this.localId);
    if (!local) return;
    local.alive = false;
    document.getElementById("death-title").textContent = "Kamu Kalah!";
    document.getElementById("death-score").textContent = Math.floor(local.score);
    document.getElementById("death-length").textContent = local.length;
    document.getElementById("death-rank").textContent = (msg && msg.rank) || this.myRank();
    document.getElementById("death-time").textContent = fmtTime((performance.now() - local.spawnTime) / 1000);
    document.getElementById("death-screen").classList.remove("hidden");
  }

  localDies() {
    const local = this.players.get(this.localId);
    if (!local || !local.alive) return;
    local.alive = false;
    this.net.send({ type: "died", finalScore: Math.floor(local.score) });
    this.onLocalDeath({ rank: this.myRank() });
  }

  myRank() {
    const local = this.players.get(this.localId);
    if (!local) return "-";
    const all = [...this.players.values(), ].map(w => w.score);
    const sorted = [...all].sort((a, b) => b - a);
    return sorted.indexOf(local.score) + 1;
  }

  // ---- main loop -----------------------------------------------------
  loop(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fps = lerp(this.fps, 1 / Math.max(dt, 0.0001), 0.08);

    const local = this.players.get(this.localId);
    if (local && local.alive) {
      this.updateLocalInput(local, dt);
      this.checkFoodCollision(local);
      this.checkWorldBounds(local);
      this.checkWormCollisions(local);
      this.maybeSendInput(now, local);
      this.maybeTopUpFood();
    }
    for (const w of this.players.values()) {
      if (w.id === this.localId) continue;
      w.updateRemote(dt);
    }

    this.render();
    this.renderMinimap();
    this.updateUI();

    if (this.running) requestAnimationFrame((t) => this.loop(t));
  }

  updateLocalInput(local, dt) {
    let targetAngle = local.angle;
    let boosting = this.boosting;
    if (this.joystickVec.active && this.joystickVec.mag > 0.15) {
      targetAngle = this.joystickVec.angle;
    } else if (this.pointer.active) {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      targetAngle = Math.atan2(this.pointer.y - cy, this.pointer.x - cx);
    }
    local.updateLocal(dt, targetAngle, boosting);
  }

  maybeSendInput(now, local) {
    const interval = 1000 / CONFIG.INPUT_SEND_HZ;
    if (now - this.lastInputSend < interval) return;
    this.lastInputSend = now;
    this.net.send({
      type: "input", angle: local.angle, boosting: local.boosting,
      x: local.x, y: local.y, score: Math.floor(local.score), length: local.length,
    });
  }

  maybeTopUpFood() {
    if (this.usingDemo || this.backendType === "none") return; // DemoEngine handles its own
    if (this.food.size >= CONFIG.FOOD_COUNT_LIVE * 0.5) return;
    const now = Date.now();
    if (this._lastTopUp && now - this._lastTopUp < 4000) return;
    this._lastTopUp = now;
    // Top-up lokal (tidak disiarkan) — cukup untuk casual play; kalau butuh
    // makanan 100% identik di semua client, pindahkan ke tabel `food` + realtime.
    for (let i = 0; i < 40; i++) {
      const id = "f" + this.food.size + "-" + Math.random().toString(36).slice(2, 6);
      this.food.set(id, {
        id,
        x: randRange(-CONFIG.WORLD_SIZE / 2, CONFIG.WORLD_SIZE / 2),
        y: randRange(-CONFIG.WORLD_SIZE / 2, CONFIG.WORLD_SIZE / 2),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        value: Math.random() < 0.12 ? 4 : 1,
      });
    }
  }

  checkFoodCollision(local) {
    for (const [id, f] of this.food) {
      if (dist(local, f) < local.radius + 6) {
        local.score += (f.value || 1) * 3;
        this.food.delete(id);
        this.net.send({ type: "eat", foodId: id });
      }
    }
  }

  checkWorldBounds(local) {
    const r = Math.hypot(local.x, local.y);
    if (r > CONFIG.WORLD_SIZE / 2) this.localDies();
  }

  checkWormCollisions(local) {
    for (const w of this.players.values()) {
      if (w.id === local.id || !w.alive) continue;
      for (let i = 0; i < w.segments.length; i += 2) {
        if (dist(local, w.segments[i]) < local.radius * 0.55 + w.radius * 0.55) {
          this.localDies();
          return;
        }
      }
    }
    // self collision (skip segments near the head)
    for (let i = 14; i < local.segments.length; i += 2) {
      if (dist(local, local.segments[i]) < local.radius * 0.5) { this.localDies(); return; }
    }
  }

  // ---- rendering -------------------------------------------------------
  render() {
    const ctx = this.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const local = this.players.get(this.localId);
    const camX = local ? local.x : 0, camY = local ? local.y : 0;
    const zoom = local ? clamp(1.05 - local.length * 0.0025, 0.62, 1.05) : 1;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);

    this.drawGrid(ctx, camX, camY, w, h, zoom);
    this.drawBorder(ctx);

    for (const [, f] of this.food) {
      ctx.beginPath();
      ctx.fillStyle = f.color || "#E3B23C";
      const r = (f.value || 1) > 2 ? 6.5 : 4;
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.arc(f.x - r * 0.3, f.y - r * 0.3, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    const sorted = [...this.players.values()].sort((a, b) => a.length - b.length);
    for (const worm of sorted) this.drawWorm(ctx, worm, worm.id === this.localId);

    ctx.restore();
  }

  drawGrid(ctx, camX, camY, w, h, zoom) {
    const spacing = 60;
    ctx.strokeStyle = "rgba(146,90,84,0.07)";
    ctx.lineWidth = 1 / zoom;
    const left = camX - w / 2 / zoom - spacing, right = camX + w / 2 / zoom + spacing;
    const top = camY - h / 2 / zoom - spacing, bottom = camY + h / 2 / zoom + spacing;
    ctx.beginPath();
    for (let x = Math.floor(left / spacing) * spacing; x < right; x += spacing) {
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / spacing) * spacing; y < bottom; y += spacing) {
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  drawBorder(ctx) {
    ctx.beginPath();
    ctx.arc(0, 0, CONFIG.WORLD_SIZE / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(192,82,74,0.35)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  drawWorm(ctx, worm, isLocal) {
    if (!worm.alive || worm.segments.length === 0) return;
    const segs = worm.segments;

    // body
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = worm.color;
    ctx.lineWidth = worm.radius * 1.7;
    ctx.beginPath();
    ctx.moveTo(worm.x, worm.y);
    for (const s of segs) ctx.lineTo(s.x, s.y);
    ctx.stroke();

    // soft highlight stripe
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = worm.radius * 0.6;
    ctx.beginPath();
    ctx.moveTo(worm.x, worm.y);
    for (const s of segs) ctx.lineTo(s.x, s.y);
    ctx.stroke();

    // bear-ear head (matches the plush charm reference)
    const earR = worm.radius * 0.42;
    const earOffset = worm.radius * 0.62;
    const perp = worm.angle + Math.PI / 2;
    for (const side of [-1, 1]) {
      const ex = worm.x + Math.cos(perp) * earOffset * side - Math.cos(worm.angle) * worm.radius * 0.3;
      const ey = worm.y + Math.sin(perp) * earOffset * side - Math.sin(worm.angle) * worm.radius * 0.3;
      ctx.beginPath();
      ctx.fillStyle = worm.color;
      ctx.arc(ex, ey, earR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = worm.color;
    ctx.arc(worm.x, worm.y, worm.radius, 0, Math.PI * 2);
    ctx.fill();

    // face
    const eyeOffset = worm.radius * 0.42;
    const eyeFwd = worm.radius * 0.35;
    for (const side of [-1, 1]) {
      const ex = worm.x + Math.cos(worm.angle) * eyeFwd + Math.cos(perp) * eyeOffset * side;
      const ey = worm.y + Math.sin(worm.angle) * eyeFwd + Math.sin(perp) * eyeOffset * side;
      ctx.beginPath(); ctx.fillStyle = "#FFFDFB"; ctx.arc(ex, ey, worm.radius * 0.26, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = "#4A3238"; ctx.arc(ex + Math.cos(worm.angle) * 1.5, ey + Math.sin(worm.angle) * 1.5, worm.radius * 0.13, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = "#4A3238";
    const nx = worm.x + Math.cos(worm.angle) * worm.radius * 0.85, ny = worm.y + Math.sin(worm.angle) * worm.radius * 0.85;
    ctx.arc(nx, ny, worm.radius * 0.16, 0, Math.PI * 2);
    ctx.fill();

    // nametag
    ctx.font = "600 11px Quicksand, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = isLocal ? "#9C3A34" : "rgba(74,50,56,0.75)";
    ctx.fillText(worm.username, worm.x, worm.y - worm.radius - 10);
  }

  renderMinimap() {
    const ctx = this.miniCtx;
    const size = this.miniCanvas.clientWidth || 110;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(243,217,214,0.4)";
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.fill();

    const scale = size / CONFIG.WORLD_SIZE;
    for (const w of this.players.values()) {
      if (!w.alive) continue;
      const mx = size / 2 + w.x * scale, my = size / 2 + w.y * scale;
      ctx.beginPath();
      ctx.fillStyle = w.id === this.localId ? "#C0524A" : w.color;
      ctx.arc(mx, my, w.id === this.localId ? 3.4 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- dashboard / UI ---------------------------------------------------
  updateUI() {
    const local = this.players.get(this.localId);
    if (local) {
      document.getElementById("stat-score").textContent = Math.floor(local.score);
      document.getElementById("stat-length").textContent = local.length;
      document.getElementById("stat-rank").textContent = this.myRank();
      document.getElementById("stat-time").textContent = fmtTime((performance.now() - local.spawnTime) / 1000);
      document.getElementById("stat-kills").textContent = local.kills || 0;
    }
    document.getElementById("stat-fps").textContent = Math.round(this.fps);
    document.getElementById("stat-ping").textContent = this.usingDemo ? "demo" : (this.net.connected ? this.net.ping : "--");
    document.getElementById("stat-online").textContent = this.online;

    this.renderLeaderboard();
  }

  renderLeaderboard() {
    const listEl = document.getElementById("leaderboard-list");
    let data = this.leaderboardData;
    if (!data || data.length === 0) {
      data = [...this.players.values()].map(w => ({ id: w.id, username: w.username, score: Math.floor(w.score) }));
    }
    const sorted = [...data].sort((a, b) => b.score - a.score).slice(0, 10);
    listEl.innerHTML = sorted.map((p, i) => {
      const w = this.players.get(p.id);
      const color = w ? w.color : "#C0524A";
      const isMe = p.id === this.localId;
      return `<li class="lb-row${isMe ? " me" : ""}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-avatar" style="background:${color}"></span>
        <span class="lb-name">${escapeHtml(p.username)}</span>
        <span class="lb-score">${p.score}</span>
      </li>`;
    }).join("");
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  const game = new Game();
  // Koneksi sebenarnya baru dimulai di startGame() (setelah username diisi) —
  // di sini cukup tampilkan status awal yang sesuai.
  if (game.backendType === "supabase") {
    document.getElementById("server-status-text").textContent = "Siap terhubung ke Supabase";
  } else if (game.backendType === "websocket") {
    document.getElementById("server-status-text").textContent = "Siap terhubung ke server";
  } else if (CONFIG.DEMO_MODE_FALLBACK) {
    document.getElementById("server-dot").style.background = "#C08552";
    document.getElementById("server-status-text").textContent = "Mode demo (backend belum diisi)";
    game.startDemoMode();
  }
});
