// Jace's Futuresight. Ranks the pod by how closely each player's grades match live 17lands
// performance, and reveals only the order. Read-only: never writes to the database.
(() => {
  const CFG = window.RF_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const MIN_GAMES = 500;   // ignore cards without enough 17lands games
  const CLIP = 2.5;        // cap z-scores so a few outliers can't dominate
  const $ = (id) => document.getElementById(id);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 150) : ms));

  // ---------- Black hole ----------
  const cv = $("hole"), ctx = cv.getContext("2d");
  let W, H, cx, cy, R, parts = [], mode = "idle", modeT = 0;
  const HUES = [188, 205, 265, 290, 320];
  function spawn(outer) {
    const r = outer ? R * (2.6 + Math.random() * 1.6) : R * (1.15 + Math.random() * 3.2);
    return { r, a: Math.random() * Math.PI * 2, hue: HUES[(Math.random() * HUES.length) | 0], s: 0.6 + Math.random() * 1.8,
      tilt: 0.35 + Math.random() * 0.12, ej: false };
  }
  function eject() { // particles flung off the event horizon
    return { r: R * 1.05, a: Math.random() * Math.PI * 2, hue: 188, s: 1 + Math.random() * 1.5, tilt: 1, ej: true, v: 1.2 + Math.random() * 2.5, life: 1 };
  }
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; cx = W / 2; cy = H / 2;
    R = Math.min(W, H) * 0.13;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(1400, (W * H) / 900));
    parts = Array.from({ length: n }, () => spawn(false));
    ctx.fillStyle = "#04030a"; ctx.fillRect(0, 0, W, H);
  }
  function frame(t) {
    modeT += 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = mode === "suck" ? "rgba(4,3,10,0.12)" : "rgba(4,3,10,0.22)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    const pull = mode === "suck" ? 1 + modeT * 0.035 : 1;
    const dim = mode === "calm" ? 0.35 : 1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.ej) {
        p.r += p.v; p.life -= 0.012;
        if (p.life <= 0) { parts[i] = spawn(true); continue; }
      } else {
        const w = 0.9 * Math.pow(R / p.r, 1.5) * 0.06 * pull;  // Kepler-ish: faster near the center
        p.a += w;
        p.r -= (mode === "suck" ? 0.6 + modeT * 0.05 : 0.05) * (R / p.r) * 2;
        if (p.r < R * 0.98) { parts[i] = mode === "suck" ? spawn(true) : Math.random() < 0.08 ? eject() : spawn(true); continue; }
      }
      const x = cx + Math.cos(p.a) * p.r, y = cy + Math.sin(p.a) * p.r * p.tilt;
      const near = Math.max(0, 1 - (p.r - R) / (R * 3));
      const alpha = (p.ej ? p.life * 0.8 : 0.25 + near * 0.7) * dim;
      ctx.fillStyle = `hsla(${p.hue}, 100%, ${60 + near * 25}%, ${alpha})`;
      ctx.fillRect(x, y, p.s, p.s);
    }
    // Event horizon + photon ring
    ctx.globalCompositeOperation = "source-over";
    const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.25);
    g.addColorStop(0, "#000"); g.addColorStop(0.75, "#000"); g.addColorStop(0.86, `rgba(125,243,255,${0.55 * dim})`); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2); ctx.fill();
    requestAnimationFrame(frame);
  }
  addEventListener("resize", resize); resize();
  if (!reduced) requestAnimationFrame(frame);
  else { ctx.fillStyle = "#04030a"; ctx.fillRect(0, 0, W, H); }

  // ---------- Data ----------
  async function loadCards() {
    const key = `rf_cards_an_v1_${CFG.SET_CODE}`; // shared with the analysis and pod pages
    try { const c = JSON.parse(localStorage.getItem(key) || "null"); if (c && Date.now() - c.t < 12 * 3600e3) return c.cards; } catch {}
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`set:${CFG.SET_CODE} cn<=${CFG.MAIN_SET_SIZE} -t:basic`)}&unique=prints&order=set`;
    const out = [];
    while (url) {
      const d = await (await fetch(url)).json();
      if (d.object === "error") throw new Error(d.details);
      d.data.forEach((c) => out.push({ id: c.id, name: c.name }));
      url = d.has_more ? d.next_page : null;
      if (url) await new Promise((r) => setTimeout(r, 100));
    }
    return out; // minimal shape; not cached so the richer shared cache isn't overwritten
  }
  async function loadPlayers() {
    if (!REMOTE) {
      let all = {}; try { all = JSON.parse(localStorage.getItem("rf_reviews") || "{}"); } catch {}
      return Object.values(all).filter((r) => r.submitted);
    }
    const k = CFG.SUPABASE_ANON_KEY;
    const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/reviews?submitted=eq.true&select=display,grades`, {
      cache: "no-store", headers: { apikey: k, ...(k.startsWith("eyJ") ? { Authorization: `Bearer ${k}` } : {}) },
    });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  async function loadPerformance() {
    const r = await fetch(`https://www.17lands.com/card_ratings/data?expansion=${CFG.SET_CODE.toUpperCase()}&format=PremierDraft`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1; };
  const clip = (z) => Math.max(-CLIP, Math.min(CLIP, z));

  async function divine() {
    const [cards, players, perf] = await Promise.all([loadCards(), loadPlayers(), loadPerformance()]);
    // 17lands lists double-faced cards by their front-face name
    const idByFront = new Map(cards.map((c) => [c.name.split(" // ")[0], c.id]));
    const wr = new Map();
    for (const p of perf) {
      if (p.ever_drawn_win_rate == null || (p.ever_drawn_game_count ?? 0) < MIN_GAMES) continue;
      const id = idByFront.get(p.name.split(" // ")[0]);
      if (id) wr.set(id, p.ever_drawn_win_rate);
    }
    if (wr.size < 20) throw new Error("too little data");
    const ids = [...wr.keys()], wrs = ids.map((id) => wr.get(id));
    const wm = mean(wrs), ws = sd(wrs);
    const zw = new Map(ids.map((id) => [id, clip((wr.get(id) - wm) / ws)]));

    // The 17lands user is excluded: it would be grading against itself
    const ranked = players.filter((pl) => (pl.display || "").toLowerCase() !== "17lands").map((pl) => {
      const g = pl.grades || {};
      const mine = ids.filter((id) => g[id] != null);
      if (mine.length < 20) return null;
      const vals = mine.map((id) => g[id]), m = mean(vals), s = sd(vals);
      const err = mean(mine.map((id) => Math.abs(clip((g[id] - m) / s) - zw.get(id))));
      return { name: pl.display, err };
    }).filter(Boolean).sort((a, b) => a.err - b.err);
    if (ranked.length < 2) throw new Error("too few players");
    return ranked.map((r) => r.name); // only the order leaves this function
  }

  // ---------- Ritual ----------
  const orb = $("reveal"), list = $("list"), msg = $("msg"), again = $("again"), title = $("title");
  async function ritual() {
    orb.disabled = true;
    msg.textContent = "Peering beyond the fracture…";
    const vision = divine().then((v) => ({ v }), (e) => ({ e }));
    mode = "suck"; modeT = 0;
    orb.classList.add("collapse");
    await sleep(2300);
    const res = await vision;
    $("flash").classList.remove("go"); void $("flash").offsetWidth; $("flash").classList.add("go");
    mode = "calm";
    orb.hidden = true;
    if (res.e) {
      console.error(res.e);
      msg.textContent = "The vision is clouded. Try again.";
      again.hidden = false;
      return;
    }
    msg.textContent = "";
    const names = res.v;
    list.innerHTML = names.map((n, i) => `<li class="fs-row ${i === 0 ? "first" : ""}"><span class="pl">${i + 1}</span><span class="nm"></span></li>`).join("");
    list.querySelectorAll(".nm").forEach((el, i) => (el.textContent = names[i]));
    list.hidden = false;
    await sleep(900);
    const rows = [...list.children];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (i === 0) { msg.textContent = "And the one who sees most clearly…"; await sleep(1600); msg.textContent = ""; }
      rows[i].classList.add("in");
      await sleep(i === 0 ? 900 : 1100);
    }
    again.hidden = false;
  }
  function reset() {
    again.hidden = true; list.hidden = true; list.innerHTML = ""; msg.textContent = "";
    orb.hidden = false; orb.disabled = false; orb.classList.remove("collapse");
    mode = "idle"; title.classList.remove("dim");
    orb.focus();
  }
  orb.addEventListener("click", ritual);
  again.addEventListener("click", reset);

  // Same passcode gate as the rest of the site
  let passOk = false;
  try { passOk = !CFG.PASSCODE_SHA256 || localStorage.getItem("rf_pass_ok") === CFG.PASSCODE_SHA256; } catch {}
  if (!passOk) { orb.disabled = true; orb.style.opacity = ".4"; msg.innerHTML = 'Enter the passcode on the <a href="./" style="color:#7df3ff">front page</a> first.'; }
})();
