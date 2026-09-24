(() => {
  const CFG = window.RF_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const GRADES = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"]; // index = score 0..12
  const COLORS = [
    { key: "W", label: "White" }, { key: "U", label: "Blue" }, { key: "B", label: "Black" },
    { key: "R", label: "Red" }, { key: "G", label: "Green" }, { key: "M", label: "Gold" },
    { key: "C", label: "Colorless" },
  ];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gradeColor = (v) => `hsl(${Math.round((v / 12) * 130)}, 55%, 42%)`;
  const gradeChip = (v) => `<span class="grade" style="background:${gradeColor(v)}">${GRADES[Math.round(v)]}</span>`;

  let cards = [], byId = {};
  let me = null;           // { reviewer, display, grades, notes, submitted }
  let allReviews = [];
  let color = "W", view = "review";
  let detailIdx = -1, detailList = [], showBack = false;

  // ---------- Storage ----------
  const store = REMOTE ? {
    async req(path, opts = {}) {
      const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: { apikey: CFG.SUPABASE_ANON_KEY,
          // legacy JWT anon keys also go in Authorization; new sb_publishable_ keys must not
          ...(CFG.SUPABASE_ANON_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}` } : {}),
          "Content-Type": "application/json", ...(opts.headers || {}) },
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const body = await r.text(); // writes come back 201 with an empty body
      return body ? JSON.parse(body) : null;
    },
    async all() { return this.req("reviews?select=*"); },
    async save(row) {
      await this.req("reviews?on_conflict=reviewer", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
      });
    },
  } : {
    read() { try { return JSON.parse(localStorage.getItem("rf_reviews") || "{}"); } catch { return {}; } },
    async all() { return Object.values(this.read()); },
    async save(row) { const d = this.read(); d[row.reviewer] = row; localStorage.setItem("rf_reviews", JSON.stringify(d)); },
  };

  let saveTimer = null, saving = Promise.resolve();
  function queueSave() {
    $("saveState").textContent = "Unsaved…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    const snapshot = JSON.parse(JSON.stringify(me));
    saving = saving.then(() => store.save(snapshot))
      .then(() => { $("saveState").textContent = "Saved"; })
      .catch((e) => { console.error(e); $("saveState").textContent = "Save failed. Check your connection, then change any grade to retry."; });
    return saving;
  }

  // ---------- Cards from Scryfall ----------
  function cardColor(c) {
    const cols = c.colors ?? [...new Set((c.card_faces || []).flatMap((f) => f.colors || []))];
    if (cols.length === 0) return "C";
    return cols.length > 1 ? "M" : cols[0];
  }
  async function loadCards() {
    const cacheKey = `rf_cards_v2_${CFG.SET_CODE}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.t < 12 * 3600e3) return cached.cards;
    } catch {}
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`set:${CFG.SET_CODE} cn<=${CFG.MAIN_SET_SIZE} -t:basic`)}&unique=prints&order=set`;
    const out = [];
    while (url) {
      const d = await (await fetch(url)).json();
      if (d.object === "error") throw new Error(d.details);
      for (const c of d.data) {
        const faces = c.card_faces || [c];
        out.push({
          id: c.id, name: c.name, cn: parseInt(c.collector_number, 10), rarity: c.rarity,
          color: cardColor(c), cmc: c.cmc,
          img: (c.image_uris || faces[0].image_uris).normal,
          small: (c.image_uris || faces[0].image_uris).small,
          art: (c.image_uris || faces[0].image_uris).art_crop, artist: c.artist,
          back: !c.image_uris && faces[1]?.image_uris ? faces[1].image_uris.normal : null,
          type: faces.map((f) => f.type_line).join(" // "),
          text: faces.map((f) => [f.mana_cost, f.oracle_text, f.power != null ? `${f.power}/${f.toughness}` : ""].filter(Boolean).join("\n")).join("\n\n—\n\n"),
        });
      }
      url = d.has_more ? d.next_page : null;
      if (url) await new Promise((r) => setTimeout(r, 100)); // Scryfall asks for 50–100ms between requests
    }
    out.sort((a, b) => a.cn - b.cn);
    try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), cards: out })); } catch {}
    return out;
  }

  // ---------- Filtering ----------
  function filtered({ forReview }) {
    const rar = $("rarityFilter").value, q = $("search").value.trim().toLowerCase();
    const ungraded = forReview && $("ungradedFilter").value === "ungraded";
    return cards.filter((c) =>
      (color === "all" || c.color === color) &&
      (!rar || c.rarity === rar) &&
      (!q || c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)) &&
      (!ungraded || me.grades[c.id] == null));
  }

  function renderTabs() {
    const counts = {};
    cards.forEach((c) => (counts[c.color] = (counts[c.color] || 0) + 1));
    const graded = {};
    cards.forEach((c) => { if (me?.grades[c.id] != null) graded[c.color] = (graded[c.color] || 0) + 1; });
    $("colorTabs").innerHTML = COLORS.map((c) =>
      `<button data-c="${c.key}" class="${color === c.key ? "on" : ""}"><span class="pip" style="background:var(--${c.key})"></span>${c.label}
       <span class="count mono">${view === "review" ? `${graded[c.key] || 0}/` : ""}${counts[c.key] || 0}</span></button>`).join("") +
      `<button data-c="all" class="${color === "all" ? "on" : ""}">All <span class="count mono">${cards.length}</span></button>`;
  }

  // ---------- Review view ----------
  function renderReview() {
    const list = filtered({ forReview: true });
    detailList = list;
    const opts = `<option value="">—</option>` + GRADES.map((g, i) => `<option value="${i}">${g}</option>`).reverse().join("");
    $("grid").innerHTML = list.length ? list.map((c, i) => {
      const g = me.grades[c.id];
      return `<div class="card ${g != null ? "graded" : ""}">
        <img src="${c.img}" alt="${esc(c.name)}" loading="lazy" data-i="${i}">
        <div class="row"><span class="rar ${c.rarity}" title="${c.rarity}"></span><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span>${me.notes[c.id] ? `<span class="has-note" title="Has note">✎</span>` : ""}</div>
        <div class="row"><span class="mono" style="color:var(--muted)">#${c.cn}</span>
          <select data-id="${c.id}" aria-label="Grade for ${esc(c.name)}" ${g != null ? `style="background:${gradeColor(g)};color:#fff"` : ""}>${opts.replace(`value="${g}"`, `value="${g}" selected`)}</select></div>
      </div>`;
    }).join("") : `<p class="empty">No cards match these filters.</p>`;
    renderProgress();
  }
  function renderProgress() {
    const n = cards.filter((c) => me.grades[c.id] != null).length;
    $("progressBar").style.width = `${(n / cards.length) * 100}%`;
    $("progressText").textContent = `${n} / ${cards.length} graded`;
    const btn = $("submitBtn");
    if (me.submitted) { btn.textContent = "Submitted ✓ (click to reopen)"; btn.classList.remove("primary"); }
    else { btn.textContent = n < cards.length ? `Submit review (${cards.length - n} ungraded)` : "Submit review"; btn.classList.add("primary"); }
  }
  function setGrade(id, v) {
    if (v == null || Number.isNaN(v)) delete me.grades[id]; else me.grades[id] = v;
    queueSave();
  }

  // ---------- Detail dialog ----------
  function openDetail(i) {
    detailIdx = i; showBack = false;
    const c = detailList[i]; if (!c) return;
    $("dImg").src = c.img; $("dImg").alt = c.name;
    $("dFlip").hidden = !c.back;
    $("dName").textContent = c.name;
    $("dType").textContent = `${c.type} · ${c.rarity} · #${c.cn}`;
    $("dText").textContent = c.text;
    const editable = view === "review";
    $("dGrades").hidden = !editable; $("dNote").hidden = !editable;
    document.querySelector('label[for="dNote"]').hidden = !editable;
    if (editable) { renderPicker(c); $("dNote").value = me.notes[c.id] || ""; }
    if (!$("detail").open) $("detail").showModal();
  }
  function renderPicker(c) {
    const g = me.grades[c.id];
    $("dGrades").innerHTML = GRADES.map((l, i) => `<button data-g="${i}" class="${g === i ? "on" : ""}" ${g === i ? `style="background:${gradeColor(i)}"` : ""}>${l}</button>`).reverse().join("");
  }
  function commitNote() {
    const c = detailList[detailIdx]; if (!c || view !== "review") return;
    const v = $("dNote").value.trim();
    if ((me.notes[c.id] || "") !== v) { if (v) me.notes[c.id] = v; else delete me.notes[c.id]; queueSave(); }
  }
  function closeDetail() { commitNote(); $("detail").close(); render(); }
  function moveDetail(d) { commitNote(); const n = detailIdx + d; if (n >= 0 && n < detailList.length) openDetail(n); }

  // ---------- Results ----------
  function stats(values) {
    const n = values.length, avg = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
    return { n, avg, sd, spread: Math.max(...values) - Math.min(...values) };
  }
  async function refreshReviews() {
    try { allReviews = await store.all(); } catch (e) { console.error(e); }
  }
  function renderResults() {
    const subOnly = $("submittedOnly").checked;
    const pool = allReviews.filter((r) => !subOnly || r.submitted);
    $("roster").innerHTML = allReviews.map((r) => `<span class="${r.submitted ? "done" : ""}">${esc(r.display)} <span class="mono" style="border:0;padding:0">${Object.keys(r.grades || {}).length}</span></span>`).join("");
    const minSpread = +$("spreadMin").value;
    $("spreadVal").textContent = `${minSpread} steps (e.g. B → ${GRADES[8 - minSpread] || "F"})`;
    const showNames = $("showNames").checked;

    const rows = filtered({ forReview: false }).map((c) => {
      const entries = pool.filter((r) => r.grades?.[c.id] != null).map((r) => ({ who: r.display, g: r.grades[c.id], note: r.notes?.[c.id] }));
      return { c, entries, s: entries.length ? stats(entries.map((e) => e.g)) : null };
    });

    // Per-color summary (always across all colors, respects rarity filter only via current list)
    const byColor = {};
    cards.forEach((c) => {
      const vals = pool.map((r) => r.grades?.[c.id]).filter((v) => v != null);
      if (!vals.length) return;
      const s = stats(vals);
      (byColor[c.color] ||= []).push({ c, s });
    });
    const threshold = minSpread;
    $("colorSummary").innerHTML = COLORS.map((col) => {
      const xs = byColor[col.key] || [];
      if (!xs.length) return "";
      const avg = xs.reduce((a, x) => a + x.s.avg, 0) / xs.length;
      const flags = xs.filter((x) => x.s.n > 1 && x.s.spread >= threshold).length;
      const commons = xs.filter((x) => x.c.rarity === "common").sort((a, b) => b.s.avg - a.s.avg)[0];
      return `<div class="cs" style="--c:var(--${col.key})"><b>${col.label}</b>
        <div class="mono">avg ${GRADES[Math.round(avg)]} · ${flags} flagged</div>
        ${commons ? `<div style="font-size:12px">Top common: ${esc(commons.c.name)}</div>` : ""}</div>`;
    }).join("");

    let list = rows.filter((r) => r.s);
    if ($("divergentOnly").checked) list = list.filter((r) => r.s.n > 1 && r.s.spread >= minSpread);
    const sort = $("sortBy").value;
    list.sort(sort === "avg" ? (a, b) => b.s.avg - a.s.avg : sort === "set" ? (a, b) => a.c.cn - b.c.cn : (a, b) => b.s.spread - a.s.spread || b.s.sd - a.s.sd);
    detailList = list.map((r) => r.c);

    $("resultsList").innerHTML = list.length ? list.map((r, i) => {
      const { c, s, entries } = r;
      const flag = s.n > 1 && s.spread >= minSpread;
      const chips = [...entries].sort((a, b) => b.g - a.g).map((e) => `<span class="chip">${gradeChip(e.g)}${showNames ? `<span class="who-lbl">${esc(e.who)}</span>` : ""}</span>`).join("");
      const notes = entries.filter((e) => e.note).map((e) => `<div>${showNames ? `<b>${esc(e.who)}:</b> ` : "• "}${esc(e.note)}</div>`).join("");
      return `<div class="rrow ${flag ? "flag" : ""}">
        <img src="${c.small}" alt="${esc(c.name)}" loading="lazy" data-i="${i}">
        <div><div class="nm">${esc(c.name)}</div><div class="meta">${c.rarity} · #${c.cn}${flag ? " · <b style='color:var(--bad)'>discuss</b>" : ""}</div></div>
        <div class="stat">average<span class="mono">${GRADES[Math.round(s.avg)]} <small style="color:var(--muted)">${s.avg.toFixed(1)}</small></span></div>
        <div class="stat">spread<span class="mono">${s.spread} · σ${s.sd.toFixed(1)}</span></div>
        <div class="chips">${chips}</div>
        ${notes ? `<div class="notes">${notes}</div>` : ""}
      </div>`;
    }).join("") : `<p class="empty">${pool.length ? "No cards match. Try lowering the spread threshold or clearing filters." : "No submitted reviews yet."}</p>`;
  }

  // Honor-system gate: Results stays disabled until the viewer ticks the box.
  const unlockKey = () => `rf_unlocked_${me.reviewer}`;
  function isUnlocked() { try { return localStorage.getItem(unlockKey()) === "1"; } catch { return false; } }
  function setUnlocked(on) {
    try { on ? localStorage.setItem(unlockKey(), "1") : localStorage.removeItem(unlockKey()); } catch {}
    syncUnlock();
  }
  function syncUnlock() {
    const on = isUnlocked();
    $("unlockResults").checked = on;
    $("resultsBtn").disabled = !on;
    $("resultsBtn").title = on ? "" : "Tick the box to unlock";
    if (!on && view === "results") { view = "review"; render(); }
  }

  function render() {
    renderTabs();
    $("reviewView").hidden = view !== "review";
    $("resultsView").hidden = view !== "results";
    $("ungradedFilter").hidden = view !== "review";
    document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    view === "review" ? renderReview() : renderResults();
  }

  // ---------- Sign in ----------
  async function signIn(name) {
    const display = name.trim().slice(0, 32);
    const reviewer = display.toLowerCase();
    await refreshReviews();
    const existing = allReviews.find((r) => r.reviewer === reviewer);
    me = existing ? { ...existing, grades: { ...existing.grades }, notes: { ...(existing.notes || {}) } }
                  : { reviewer, display, grades: {}, notes: {}, submitted: false };
    try { localStorage.setItem("rf_me", display); } catch {}
    $("whoName").textContent = display;
    $("gate").hidden = true; $("app").hidden = false; $("views").hidden = false; $("who").hidden = false;
    view = "review";
    syncUnlock();
    render();
  }

  // ---------- Events ----------
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const passKey = "rf_pass_ok";
  const hasPass = () => { try { return !CFG.PASSCODE_SHA256 || localStorage.getItem(passKey) === CFG.PASSCODE_SHA256; } catch { return false; } };
  $("gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (CFG.PASSCODE_SHA256 && !hasPass()) {
      if ((await sha256($("passInput").value.trim())) !== CFG.PASSCODE_SHA256) {
        $("gateError").hidden = false; $("passInput").select(); return;
      }
      try { localStorage.setItem(passKey, CFG.PASSCODE_SHA256); } catch {}
    }
    $("gateError").hidden = true;
    signIn($("nameInput").value);
  });
  $("passInput").addEventListener("input", () => { $("gateError").hidden = true; });
  // Browsers that already passed don't need to type it again
  function syncPassField() { const ok = hasPass(); $("passInput").hidden = ok; $("passInput").required = !ok; }
  $("switchUser").addEventListener("click", async () => {
    await flushSave(); try { localStorage.removeItem("rf_me"); } catch {}
    me = null; $("app").hidden = true; $("views").hidden = true; $("who").hidden = true; $("gate").hidden = false; $("nameInput").value = ""; renderLanding(); syncPassField(); scrollTo(0, 0);
  });
  $("views").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    view = b.dataset.view;
    if (view === "results") { await flushSave(); await refreshReviews(); }
    render();
  });
  $("unlockResults").addEventListener("change", (e) => setUnlocked(e.target.checked));
  $("colorTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { color = b.dataset.c; render(); } });
  ["rarityFilter", "ungradedFilter", "sortBy", "divergentOnly", "showNames", "submittedOnly"].forEach((id) => $(id).addEventListener("change", render));
  $("search").addEventListener("input", render);
  $("spreadMin").addEventListener("input", render);

  $("grid").addEventListener("change", (e) => {
    const s = e.target.closest("select[data-id]"); if (!s) return;
    setGrade(s.dataset.id, s.value === "" ? null : +s.value);
    const g = me.grades[s.dataset.id];
    s.style.background = g != null ? gradeColor(g) : ""; s.style.color = g != null ? "#fff" : "";
    s.closest(".card").classList.toggle("graded", g != null);
    renderProgress(); renderTabs();
  });
  $("grid").addEventListener("click", (e) => { const img = e.target.closest("img[data-i]"); if (img) openDetail(+img.dataset.i); });
  $("resultsList").addEventListener("click", (e) => { const img = e.target.closest("img[data-i]"); if (img) openDetail(+img.dataset.i); });

  $("submitBtn").addEventListener("click", async () => {
    me.submitted = !me.submitted;
    renderProgress();
    await flushSave();
    if (me.submitted) { setUnlocked(true); view = "results"; await refreshReviews(); render(); }
  });

  $("dGrades").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-g]"); if (!b) return;
    const c = detailList[detailIdx], v = +b.dataset.g;
    setGrade(c.id, me.grades[c.id] === v ? null : v);
    renderPicker(c); renderProgress();
  });
  $("dFlip").addEventListener("click", () => { const c = detailList[detailIdx]; showBack = !showBack; $("dImg").src = showBack ? c.back : c.img; });
  $("dPrev").addEventListener("click", () => moveDetail(-1));
  $("dNext").addEventListener("click", () => moveDetail(1));
  $("dClose").addEventListener("click", closeDetail);
  $("detail").addEventListener("cancel", (e) => { e.preventDefault(); closeDetail(); });
  $("detail").addEventListener("click", (e) => { if (e.target === $("detail")) closeDetail(); });
  $("detail").addEventListener("keydown", (e) => {
    if (e.target === $("dNote")) return;
    if (e.key === "ArrowLeft") return moveDetail(-1);
    if (e.key === "ArrowRight") return moveDetail(1);
    if (view !== "review") return;
    // a/b/c/d/f set the letter; + / - nudge it
    const c = detailList[detailIdx], base = { a: 11, b: 8, c: 5, d: 2, f: 0 }[e.key.toLowerCase()];
    let v = me.grades[c.id];
    if (base != null) v = base;
    else if ((e.key === "+" || e.key === "=") && v != null) v = Math.min(12, v + 1);
    else if (e.key === "-" && v != null) v = Math.max(0, v - 1);
    else return;
    e.preventDefault(); setGrade(c.id, v); renderPicker(c); renderProgress();
  });
  window.addEventListener("beforeunload", () => { if (me) flushSave(); });

  // ---------- Landing ----------
  function renderLanding() {
    const heroCard = cards.find((c) => /emrakul/i.test(c.name)) || cards.find((c) => c.rarity === "mythic") || cards[0];
    if (heroCard) {
      const img = new Image();
      img.onload = () => { $("heroArt").style.backgroundImage = `url("${heroCard.art}")`; $("heroArt").classList.add("in"); };
      img.src = heroCard.art;
      $("artCredit").textContent = `${heroCard.name} · art by ${heroCard.artist}`;
    }
  }

  // ---------- Particles: drifting prismatic shards ----------
  function startShards() {
    const cv = $("shards"), ctx = cv.getContext("2d");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const hues = [188, 280, 330, 45];
    let W, H, dpr, shards = [];
    const spawn = (y) => ({
      x: Math.random() * W, y: y ?? H + 20, s: 2 + Math.random() * 5, vy: 0.15 + Math.random() * 0.5,
      vx: (Math.random() - 0.5) * 0.2, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.02,
      hue: hues[(Math.random() * hues.length) | 0], a: 0.25 + Math.random() * 0.6, tw: Math.random() * 6.28,
    });
    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
      cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, (W * H) / 16000));
      shards = Array.from({ length: n }, () => spawn(Math.random() * H));
    }
    function frame(t) {
      ctx.clearRect(0, 0, W, H);
      const inApp = !$("app").hidden;
      ctx.globalCompositeOperation = "lighter";
      for (const p of shards) {
        p.y -= p.vy; p.x += p.vx + Math.sin(t / 2000 + p.tw) * 0.15; p.rot += p.vr;
        if (p.y < -20) Object.assign(p, spawn());
        const a = p.a * (0.6 + 0.4 * Math.sin(t / 600 + p.tw)) * (inApp ? 0.35 : 1);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.shadowBlur = 12; ctx.shadowColor = `hsla(${p.hue},100%,70%,${a})`;
        ctx.fillStyle = `hsla(${p.hue},100%,75%,${a})`;
        ctx.beginPath(); ctx.moveTo(0, -p.s * 1.6); ctx.lineTo(p.s * 0.6, 0); ctx.lineTo(0, p.s * 1.2); ctx.lineTo(-p.s * 0.5, p.s * 0.1); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    addEventListener("resize", resize); resize(); requestAnimationFrame(frame);
  }

  // ---------- Boot ----------
  (async () => {
    $("demoBanner").hidden = REMOTE;
    startShards();
    try { cards = await loadCards(); } catch (e) {
      $("gateForm").insertAdjacentHTML("beforeend", `<p class="hint" style="color:var(--bad)">Couldn't load cards from Scryfall (${esc(e.message)}). Refresh to try again.</p>`);
      return;
    }
    cards.forEach((c) => (byId[c.id] = c));
    renderLanding();
    syncPassField();
    let saved = null; try { saved = localStorage.getItem("rf_me"); } catch {}
    if (saved && hasPass()) signIn(saved);
  })();
})();
