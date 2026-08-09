import React, { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";

// ---------- Game constants ----------
const GRID = 20;
const CELL = 20;
const CANVAS_SIZE = GRID * CELL;
const BASE_INTERVAL = 150;
const MIN_INTERVAL = 75;

function randCell(exclude) {
  let c;
  do {
    c = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
  } while (exclude.some((s) => s.x === c.x && s.y === c.y));
  return c;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "baru saja";
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  return `${Math.floor(hr / 24)} hari lalu`;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- Leaderboard data layer (Supabase) ----------
function useLeaderboard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase
      .from("leaderboard")
      .select("*")
      .order("score", { ascending: false })
      .limit(100);
    if (e) setError(e.message);
    else {
      setRows(data || []);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submitScore = async (entry) => {
    const { error: e } = await supabase.from("leaderboard").insert([entry]);
    if (!e) load();
    return !e;
  };

  return { rows, loading, error, load, submitScore };
}

// ---------- Snake canvas game ----------
function SnakeGame({ playerName, onGameOver, paused, setPaused }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const snakeRef = useRef([{ x: 10, y: 10 }]);
  const prevSnakeRef = useRef([{ x: 10, y: 10 }]);
  const dirRef = useRef({ x: 1, y: 0 });
  const nextDirRef = useRef({ x: 1, y: 0 });
  const foodRef = useRef(randCell([{ x: 10, y: 10 }]));
  const scoreRef = useRef(0);
  const aliveRef = useRef(true);
  const pausedRef = useRef(paused);
  const accRef = useRef(0);
  const lastTimeRef = useRef(0);
  const startRef = useRef(Date.now());
  const rafRef = useRef(null);
  const touchStart = useRef(null);

  const [score, setScore] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const getInterval = () => Math.max(MIN_INTERVAL, BASE_INTERVAL - Math.floor(scoreRef.current / 50) * 8);

  const endGame = useCallback(() => {
    if (!aliveRef.current) return;
    aliveRef.current = false;
    cancelAnimationFrame(rafRef.current);
    onGameOver({
      score: scoreRef.current,
      panjang: snakeRef.current.length,
      waktu_detik: Math.floor((Date.now() - startRef.current) / 1000),
    });
  }, [onGameOver]);

  const setDirection = useCallback((dx, dy) => {
    const cur = dirRef.current;
    if (cur.x === -dx && cur.y === -dy) return;
    if (cur.x === dx && cur.y === dy) return;
    nextDirRef.current = { x: dx, y: dy };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const map = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
        W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
      };
      if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
        return;
      }
      if (map[e.key]) {
        e.preventDefault();
        setDirection(...map[e.key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDirection, setPaused]);

  const tick = useCallback(() => {
    dirRef.current = nextDirRef.current;
    const dir = dirRef.current;
    const head = snakeRef.current[0];
    const newHead = { x: head.x + dir.x, y: head.y + dir.y };

    if (newHead.x < 0 || newHead.x >= GRID || newHead.y < 0 || newHead.y >= GRID) {
      endGame();
      return;
    }

    const body = snakeRef.current;
    const willGrow = newHead.x === foodRef.current.x && newHead.y === foodRef.current.y;
    const checkBody = willGrow ? body : body.slice(0, -1);
    if (checkBody.some((s) => s.x === newHead.x && s.y === newHead.y)) {
      endGame();
      return;
    }

    prevSnakeRef.current = body;
    const newSnake = [newHead, ...body];
    if (willGrow) {
      scoreRef.current += 10;
      setScore(scoreRef.current);
      foodRef.current = randCell(newSnake);
    } else {
      newSnake.pop();
    }
    snakeRef.current = newSnake;
  }, [endGame]);

  const draw = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== CANVAS_SIZE * dpr) {
      canvas.width = CANVAS_SIZE * dpr;
      canvas.height = CANVAS_SIZE * dpr;
      ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = "#FFF9F3";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.strokeStyle = "rgba(201,123,135,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL, 0);
      ctx.lineTo(i * CELL, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL);
      ctx.lineTo(CANVAS_SIZE, i * CELL);
      ctx.stroke();
    }

    const f = foodRef.current;
    const pulse = 3 + Math.sin(Date.now() / 220) * 1.5;
    ctx.fillStyle = "#B23A48";
    ctx.beginPath();
    ctx.arc(f.x * CELL + CELL / 2, f.y * CELL + CELL / 2, CELL / 2 - 3 + pulse * 0.15, 0, Math.PI * 2);
    ctx.fill();

    const snake = snakeRef.current;
    const prev = prevSnakeRef.current;
    const n = snake.length;
    for (let i = n - 1; i >= 0; i--) {
      const cur = snake[i];
      const pv = prev[i] || prev[prev.length - 1] || cur;
      const ix = pv.x * CELL + (cur.x - pv.x) * CELL * t;
      const iy = pv.y * CELL + (cur.y - pv.y) * CELL * t;
      const ratio = i / Math.max(1, n - 1);
      const r = Math.round(lerp(178, 232, ratio));
      const g = Math.round(lerp(58, 174, ratio));
      const b = Math.round(lerp(72, 183, ratio));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const size = i === 0 ? CELL - 2 : CELL - 4;
      const off = (CELL - size) / 2;
      ctx.beginPath();
      ctx.roundRect(ix + off, iy + off, size, size, 6);
      ctx.fill();

      if (i === 0) {
        ctx.fillStyle = "#FFF9F3";
        const eyeOff = 5;
        ctx.beginPath();
        ctx.arc(ix + CELL / 2 - eyeOff, iy + CELL / 2 - 2, 2, 0, Math.PI * 2);
        ctx.arc(ix + CELL / 2 + eyeOff, iy + CELL / 2 - 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, []);

  useEffect(() => {
    const loop = (now) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = now - lastTimeRef.current;
      lastTimeRef.current = now;

      if (aliveRef.current && !pausedRef.current) {
        accRef.current += dt;
        const interval = getInterval();
        let guard = 0;
        while (accRef.current >= interval && guard < 5) {
          tick();
          accRef.current -= interval;
          guard++;
        }
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
      const interval = getInterval();
      draw(Math.min(1, accRef.current / interval));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick, draw]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onStart = (e) => {
      const t = e.touches[0];
      touchStart.current = { x: t.clientX, y: t.clientY };
    };
    const onEnd = (e) => {
      if (!touchStart.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.current.x;
      const dy = t.clientY - touchStart.current.y;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      if (Math.abs(dx) > Math.abs(dy)) setDirection(dx > 0 ? 1 : -1, 0);
      else setDirection(0, dy > 0 ? 1 : -1);
      touchStart.current = null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, [setDirection]);

  return (
    <div className="game-wrap" ref={wrapRef}>
      <div className="hud">
        <div className="hud-item">
          <span className="hud-num">{score}</span>
          <span className="hud-label">Skor</span>
        </div>
        <div className="hud-item">
          <span className="hud-num">{snakeRef.current.length}</span>
          <span className="hud-label">Panjang</span>
        </div>
        <div className="hud-item">
          <span className="hud-num">{fmtTime(elapsed)}</span>
          <span className="hud-label">Waktu</span>
        </div>
        <button className="pause-btn" onClick={() => setPaused((p) => !p)}>
          {paused ? "Lanjut" : "Jeda"}
        </button>
      </div>

      <div className="canvas-frame">
        <canvas ref={canvasRef} className="game-canvas" />
        {paused && (
          <div className="pause-overlay">
            <span>Dijeda</span>
          </div>
        )}
      </div>

      <div className="dpad" aria-hidden="true">
        <button className="dpad-btn dpad-up" onClick={() => setDirection(0, -1)}>鈻�</button>
        <div className="dpad-mid">
          <button className="dpad-btn" onClick={() => setDirection(-1, 0)}>鈼€</button>
          <button className="dpad-btn" onClick={() => setDirection(1, 0)}>鈻�</button>
        </div>
        <button className="dpad-btn dpad-down" onClick={() => setDirection(0, 1)}>鈻�</button>
      </div>
      <p className="hint">Panah/WASD di PC, geser atau tap tombol di HP. Spasi buat jeda.</p>
    </div>
  );
}

// ---------- Name gate ----------
function NameGate({ onStart }) {
  const [name, setName] = useState(() => localStorage.getItem("snake-player-name") || "");
  return (
    <div className="panel name-gate">
      <span className="eyebrow-chip">Siap main?</span>
      <h2>Masukin nama kamu</h2>
      <p className="muted">Nama ini bakal muncul di papan peringkat.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          localStorage.setItem("snake-player-name", n);
          onStart(n);
        }}
      >
        <input
          className="name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="cth. Rafi"
          maxLength={20}
          autoFocus
        />
        <button className="cta-btn" type="submit" disabled={!name.trim()}>
          Mulai Main
        </button>
      </form>
    </div>
  );
}

// ---------- Game over card ----------
function GameOverCard({ result, onRestart, onViewBoard }) {
  return (
    <div className="panel gameover-card">
      <span className="eyebrow-chip">Selesai</span>
      <h2>Permainan berakhir</h2>
      <div className="result-row">
        <div className="result-item">
          <span className="result-num">{result.score}</span>
          <span className="result-label">Skor</span>
        </div>
        <div className="result-item">
          <span className="result-num">{result.panjang}</span>
          <span className="result-label">Panjang</span>
        </div>
        <div className="result-item">
          <span className="result-num">{fmtTime(result.waktu_detik)}</span>
          <span className="result-label">Waktu</span>
        </div>
      </div>
      <div className="btn-row">
        <button className="cta-btn" onClick={onRestart}>Main lagi</button>
        <button className="ghost-btn" onClick={onViewBoard}>Lihat papan peringkat</button>
      </div>
    </div>
  );
}

// ---------- Dashboard / leaderboard ----------
function Dashboard({ playerName, rows, loading, error }) {
  const totalGames = rows.length;
  const topScore = rows[0]?.score ?? 0;
  const uniquePlayers = new Set(rows.map((r) => r.nama.trim().toLowerCase())).size;
  const avgScore = totalGames ? Math.round(rows.reduce((a, r) => a + r.score, 0) / totalGames) : 0;

  const mine = rows.filter((r) => r.nama.trim().toLowerCase() === playerName.trim().toLowerCase());
  const myBest = mine.reduce((m, r) => Math.max(m, r.score), 0);
  const myGames = mine.length;
  const myLongest = mine.reduce((m, r) => Math.max(m, r.panjang), 0);
  const myRank = rows.findIndex((r) => r.score === myBest && r.nama.trim().toLowerCase() === playerName.trim().toLowerCase()) + 1;

  return (
    <div className="dashboard">
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{topScore}</span>
          <span className="stat-label">Skor tertinggi</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{totalGames}</span>
          <span className="stat-label">Total permainan</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{uniquePlayers}</span>
          <span className="stat-label">Pemain aktif</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{avgScore}</span>
          <span className="stat-label">Rata-rata skor</span>
        </div>
      </div>

      {myGames > 0 && (
        <div className="me-card">
          <h3>Statistik kamu 路 {playerName}</h3>
          <div className="me-row">
            <div><span className="me-num">{myBest}</span><span className="me-label">Skor terbaik</span></div>
            <div><span className="me-num">{myGames}</span><span className="me-label">Kali main</span></div>
            <div><span className="me-num">{myLongest}</span><span className="me-label">Terpanjang</span></div>
            <div><span className="me-num">{myRank > 0 ? `#${myRank}` : "-"}</span><span className="me-label">Peringkat</span></div>
          </div>
        </div>
      )}

      <div className="panel board-panel">
        <h2>Papan Peringkat</h2>
        {loading ? (
          <div className="empty-state">Memuat data鈥�</div>
        ) : error ? (
          <div className="error-banner">Gagal memuat: {error}</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">Belum ada yang main. Jadilah yang pertama!</div>
        ) : (
          <ul className="board-list">
            {rows.slice(0, 20).map((r, idx) => (
              <li
                key={r.id}
                className={`board-row ${r.nama.trim().toLowerCase() === playerName.trim().toLowerCase() ? "board-row-me" : ""}`}
              >
                <span className="board-rank">{idx + 1}</span>
                <span className="board-name">{r.nama}</span>
                <span className="board-score">{r.score}</span>
                <span className="board-meta">{r.panjang} 路 {timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [playerName, setPlayerName] = useState(() => localStorage.getItem("snake-player-name") || "");
  const [screen, setScreen] = useState(() => (localStorage.getItem("snake-player-name") ? "play" : "gate"));
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState(null);
  const [gameId, setGameId] = useState(0);
  const { rows, loading, error, submitScore } = useLeaderboard();

  const handleGameOver = useCallback(
    async (res) => {
      setResult(res);
      setScreen("gameover");
      await submitScore({ nama: playerName, ...res });
    },
    [playerName, submitScore]
  );

  return (
    <div className="app-root">
      <header className="hero">
        <div className="diamond-field" aria-hidden="true">
          <div className="d d1" /><div className="d d2" /><div className="d d3" />
        </div>
        <div className="hero-inner">
          <div className="brand-row">
            <span className="brand-name">馃悕 ULAR RANKING</span>
            {playerName && (
              <nav className="tabs">
                <button className={`tab-btn ${screen !== "board" ? "active" : ""}`} onClick={() => setScreen("play")}>Main</button>
                <button className={`tab-btn ${screen === "board" ? "active" : ""}`} onClick={() => setScreen("board")}>Peringkat</button>
              </nav>
            )}
          </div>
          <h1>Seberapa jauh kamu bisa tumbuh?</h1>
          <p className="hero-sub">Main, kumpulin skor, dan lihat namamu di papan peringkat bareng semua pemain lain.</p>
        </div>
      </header>

      <main className="main-col">
        {screen === "gate" && <NameGate onStart={(n) => { setPlayerName(n); setScreen("play"); }} />}

        {screen === "play" && playerName && (
          <SnakeGame key={gameId} playerName={playerName} onGameOver={handleGameOver} paused={paused} setPaused={setPaused} />
        )}

        {screen === "gameover" && result && (
          <GameOverCard result={result} onRestart={() => { setPaused(false); setGameId((g) => g + 1); setScreen("play"); }} onViewBoard={() => setScreen("board")} />
        )}

        {screen === "board" && (
          <>
            <Dashboard playerName={playerName} rows={rows} loading={loading} error={error} />
            <button className="cta-btn board-play-btn" onClick={() => { setGameId((g) => g + 1); setScreen("play"); }}>Main lagi</button>
          </>
        )}
      </main>

      <footer className="site-footer">
        <span>Ular Ranking 路 skor tersimpan di server &amp; terlihat semua pemain</span>
      </footer>
    </div>
  );
  }
