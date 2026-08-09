import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

// ---------- Data layer (Supabase = server + database beneran) ----------
function useSubmissions() {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ group_name: "KELOMPOK 4", topic: "Pengumpulan Tugas" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e1 } = await supabase
      .from("submissions")
      .select("*")
      .order("waktu", { ascending: false });
    if (e1) setError(e1.message);
    else setItems(data || []);

    const { data: metaRow, error: e2 } = await supabase
      .from("group_meta")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (!e2 && metaRow) setMeta(metaRow);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // dengerin perubahan real-time dari anggota lain
    const channel = supabase
      .channel("submissions-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [load]);

  const addItem = async (item) => {
    const { error: e } = await supabase.from("submissions").insert([item]);
    if (e) setError(e.message);
    else load();
  };

  const removeItem = async (id) => {
    const { error: e } = await supabase.from("submissions").delete().eq("id", id);
    if (e) setError(e.message);
    else load();
  };

  const saveMeta = async (newMeta) => {
    const { error: e } = await supabase
      .from("group_meta")
      .upsert({ id: 1, ...newMeta });
    if (e) setError(e.message);
    else setMeta(newMeta);
  };

  return { items, meta, loading, error, addItem, removeItem, saveMeta };
}

// ---------- Decorative geometry ----------
function DiamondField({ className = "" }) {
  return (
    <div className={`diamond-field ${className}`} aria-hidden="true">
      <div className="d d1" />
      <div className="d d2" />
      <div className="d d3" />
      <div className="d d4" />
    </div>
  );
}

function Gear({ size = 46, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} className="gear-icon">
      <path
        fill="currentColor"
        d="M12 8a4 4 0 100 8 4 4 0 000-8zm9.4 4a7.4 7.4 0 00-.14-1.4l2.1-1.64a.5.5 0 00.12-.64l-2-3.46a.5.5 0 00-.6-.22l-2.48 1a7.6 7.6 0 00-2.42-1.4l-.38-2.64a.5.5 0 00-.5-.42h-4a.5.5 0 00-.5.42l-.38 2.64a7.6 7.6 0 00-2.42 1.4l-2.48-1a.5.5 0 00-.6.22l-2 3.46a.5.5 0 00.12.64l2.1 1.64A7.4 7.4 0 002.6 12c0 .48.05.94.14 1.4L.64 15.04a.5.5 0 00-.12.64l2 3.46a.5.5 0 00.6.22l2.48-1c.72.6 1.53 1.07 2.42 1.4l.38 2.64a.5.5 0 00.5.42h4a.5.5 0 00.5-.42l.38-2.64a7.6 7.6 0 002.42-1.4l2.48 1a.5.5 0 00.6-.22l2-3.46a.5.5 0 00-.12-.64l-2.1-1.64c.09-.46.14-.92.14-1.4z"
      />
    </svg>
  );
}

// ---------- Header / hero ----------
function Hero({ meta, onSave, stats }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meta);

  useEffect(() => setDraft(meta), [meta]);

  return (
    <header className="hero">
      <DiamondField />
      <div className="hero-inner">
        <div className="brand-row">
          <div className="brand-mark">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M4 12l5-7 5 7-5 7-5-7z" fill="#5EE6D0" />
              <path d="M14 12l5-7 5 7-5 7-5-7z" fill="#4C6FFF" opacity="0.85" />
            </svg>
            {editing ? (
              <input
                className="brand-input"
                value={draft.group_name}
                onChange={(e) => setDraft((d) => ({ ...d, group_name: e.target.value.toUpperCase() }))}
                maxLength={28}
              />
            ) : (
              <span className="brand-name">{meta.group_name}</span>
            )}
          </div>
          <div className="gear-cluster">
            <Gear size={34} style={{ color: "#1B2B6B", opacity: 0.9 }} />
            <Gear size={22} style={{ color: "#5EE6D0", marginLeft: -10, marginTop: 14 }} />
          </div>
        </div>

        <div className="hero-main">
          <div className="hero-copy">
            <span className="eyebrow">Ruang Kerja Kelompok</span>
            {editing ? (
              <input
                className="title-input"
                value={draft.topic}
                onChange={(e) => setDraft((d) => ({ ...d, topic: e.target.value }))}
                maxLength={48}
              />
            ) : (
              <h1>{meta.topic}</h1>
            )}
            <p className="hero-sub">
              Satu tempat buat kumpulin tugas, pantau siapa udah setor, dan siapa masih ngutang. Data
              tersimpan di server dan langsung update ke semua anggota.
            </p>

            <button
              className="edit-btn"
              onClick={() => {
                if (editing) onSave(draft);
                setEditing((v) => !v);
              }}
            >
              {editing ? "Simpan nama & topik" : "Ubah nama kelompok / topik"}
            </button>

            <div className="stat-row">
              <div className="stat-card">
                <span className="stat-num">{stats.total}</span>
                <span className="stat-label">Tugas masuk</span>
              </div>
              <div className="stat-card">
                <span className="stat-num">{stats.members}</span>
                <span className="stat-label">Anggota setor</span>
              </div>
              <div className="stat-card">
                <span className="stat-num">{stats.today}</span>
                <span className="stat-label">Masuk hari ini</span>
              </div>
            </div>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="device">
              <div className="device-screen">
                <div className="screen-line l1" />
                <div className="screen-line l2" />
                <div className="screen-line l3" />
                <div className="screen-chip" />
              </div>
              <div className="device-base" />
            </div>
            <div className="orbit-dot od1" />
            <div className="orbit-dot od2" />
            <div className="orbit-dot od3" />
          </div>
        </div>
      </div>
    </header>
  );
}

// ---------- Submission form ----------
function SubmitForm({ onAdd }) {
  const [nama, setNama] = useState("");
  const [judul, setJudul] = useState("");
  const [tautan, setTautan] = useState("");
  const [catatan, setCatatan] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!nama.trim() || !judul.trim()) return;
    setBusy(true);
    await onAdd({
      nama: nama.trim(),
      judul: judul.trim(),
      tautan: tautan.trim() || null,
      catatan: catatan.trim() || null,
      waktu: new Date().toISOString(),
    });
    setBusy(false);
    setNama("");
    setJudul("");
    setTautan("");
    setCatatan("");
    setDone(true);
    setTimeout(() => setDone(false), 2200);
  };

  return (
    <section className="panel form-panel" id="setor">
      <div className="panel-head">
        <span className="panel-index">01</span>
        <div>
          <h2>Setor tugas</h2>
          <p>Isi data di bawah, tugas langsung tercatat buat semua anggota kelompok.</p>
        </div>
      </div>

      <form onSubmit={submit} className="form-grid">
        <label className="field">
          <span>Nama kamu</span>
          <input value={nama} onChange={(e) => setNama(e.target.value)} placeholder="cth. Rafi" required />
        </label>
        <label className="field">
          <span>Judul tugas</span>
          <input value={judul} onChange={(e) => setJudul(e.target.value)} placeholder="cth. Laporan Bab 3" required />
        </label>
        <label className="field field-wide">
          <span>Tautan file (opsional)</span>
          <input value={tautan} onChange={(e) => setTautan(e.target.value)} placeholder="link Google Drive / Docs" type="url" />
        </label>
        <label className="field field-wide">
          <span>Catatan (opsional)</span>
          <textarea value={catatan} onChange={(e) => setCatatan(e.target.value)} placeholder="cth. bagian 1-3 udah, tinggal revisi" rows={2} />
        </label>

        <button className="submit-btn" type="submit" disabled={busy}>
          {busy ? "Menyimpan鈥�" : "Kumpulkan tugas"}
        </button>
        {done && <span className="done-note">Tersimpan 鉁�</span>}
      </form>
    </section>
  );
}

// ---------- List ----------
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "baru saja";
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  return `${day} hari lalu`;
}

function SubmissionList({ items, loading, onRemove }) {
  return (
    <section className="panel list-panel">
      <div className="panel-head">
        <span className="panel-index">02</span>
        <div>
          <h2>Daftar setoran</h2>
          <p>Urut dari yang paling baru dikumpulkan.</p>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Memuat data鈥�</div>
      ) : items.length === 0 ? (
        <div className="empty-state">Belum ada tugas yang masuk. Jadilah yang pertama setor.</div>
      ) : (
        <ul className="entry-list">
          {items.map((it, idx) => (
            <li key={it.id} className="entry" style={{ "--i": idx }}>
              <div className="entry-avatar">{it.nama.trim().charAt(0).toUpperCase() || "?"}</div>
              <div className="entry-body">
                <div className="entry-top">
                  <span className="entry-title">{it.judul}</span>
                  <button className="remove-btn" onClick={() => onRemove(it.id)} title="Hapus setoran ini">
                    脳
                  </button>
                </div>
                <div className="entry-meta">
                  <span className="entry-name">{it.nama}</span>
                  <span className="dot">鈥�</span>
                  <span>{timeAgo(it.waktu)}</span>
                </div>
                {it.catatan && <p className="entry-note">{it.catatan}</p>}
                {it.tautan && (
                  <a className="entry-link" href={it.tautan} target="_blank" rel="noreferrer">
                    Buka tautan file 鈫�
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- App ----------
export default function App() {
  const { items, meta, loading, error, addItem, removeItem, saveMeta } = useSubmissions();

  const stats = {
    total: items.length,
    members: new Set(items.map((i) => i.nama.trim().toLowerCase())).size,
    today: items.filter((i) => new Date(i.waktu).toDateString() === new Date().toDateString()).length,
  };

  return (
    <div className="app-root">
      <Hero meta={meta} onSave={saveMeta} stats={stats} />

      <main className="main-col">
        {error && (
          <div className="error-banner">
            Gagal konek ke server: {error}. Cek pengaturan Supabase (URL/key) dan tabelnya.
          </div>
        )}
        <SubmitForm onAdd={addItem} />
        <SubmissionList items={items} loading={loading} onRemove={removeItem} />
      </main>

      <footer className="site-footer">
        <span>{meta.group_name} 路 data tersimpan di server &amp; terlihat oleh semua anggota</span>
      </footer>
    </div>
  );
}
