// Player analysis: read-only. Reads the signed-in player's review (and, once they've
// submitted, the pod's submitted reviews for comparison). Never writes to the database.
(() => {
  const CFG = window.RF_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const GRADES = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
  const COLORS = [
    { key: "W", label: "White" }, { key: "U", label: "Blue" }, { key: "B", label: "Black" },
    { key: "R", label: "Red" }, { key: "G", label: "Green" }, { key: "M", label: "Gold" }, { key: "C", label: "Colorless" },
  ];
  const WUBRG = ["W", "U", "B", "R", "G"];
  const PAIRS = [
    ["W", "U", "Azorius"], ["U", "B", "Dimir"], ["B", "R", "Rakdos"], ["R", "G", "Gruul"], ["G", "W", "Selesnya"],
    ["W", "B", "Orzhov"], ["U", "R", "Izzet"], ["B", "G", "Golgari"], ["R", "W", "Boros"], ["G", "U", "Simic"],
  ];
  const RARITIES = [
    { key: "common", label: "Common", sw: "#1f1d24" }, { key: "uncommon", label: "Uncommon", sw: "#9fb3c4" },
    { key: "rare", label: "Rare", sw: "#d9b24c" }, { key: "mythic", label: "Mythic", sw: "#e0632b" },
  ];
  const TYPE_ORDER = ["Creature", "Instant", "Sorcery", "Enchantment", "Artifact", "Planeswalker", "Battle", "Land"];
  const AXIS = [[0, "F"], [2, "D"], [5, "C"], [8, "B"], [11, "A"]];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const letter = (v) => (v == null ? "–" : GRADES[Math.max(0, Math.min(12, Math.round(v)))]);
  const gradeColor = (v) => `hsl(${Math.round((v / 12) * 130)}, 55%, 42%)`;
  const chip = (v, cls = "") => `<span class="grade ${cls}" style="background:${gradeColor(v)}">${letter(v)}</span>`;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : null; };
  const pips = (keys) => `<span class="pips">${keys.map((k) => `<span class="sw" style="background:var(--${k})"></span>`).join("")}</span>`;
  const fmt1 = (v) => (v == null ? "–" : v.toFixed(1));
  const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(1);

  let cards = [], byId = {}, me = null, pod = [];   // pod = other players' submitted reviews
  const cmpChoice = {};                               // sectionId -> "" | "pod" | reviewer
  let tierColor = "all";

  // ---------- Data ----------
  async function loadCards() {
    const cacheKey = `rf_cards_an_v1_${CFG.SET_CODE}`;
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (c && Date.now() - c.t < 12 * 3600e3) return c.cards;
    } catch {}
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`set:${CFG.SET_CODE} cn<=${CFG.MAIN_SET_SIZE} -t:basic`)}&unique=prints&order=set`;
    const out = [];
    while (url) {
      const d = await (await fetch(url)).json();
      if (d.object === "error") throw new Error(d.details);
      for (const c of d.data) {
        const faces = c.card_faces || [c];
        const f0 = faces[0], imgs = c.image_uris || f0.image_uris;
        const cols = c.colors ?? [...new Set(faces.flatMap((f) => f.colors || []))];
        const typeLine = f0.type_line || c.type_line || "";
        const types = TYPE_ORDER.filter((t) => typeLine.includes(t));
        const num = (x) => (x != null && /^\d+$/.test(x) ? +x : null);
        out.push({
          id: c.id, name: c.name, cn: parseInt(c.collector_number, 10), rarity: c.rarity, cmc: c.cmc ?? 0,
          colors: cols, color: cols.length === 0 ? "C" : cols.length > 1 ? "M" : cols[0],
          types, type: types[0] || "Other", keywords: c.keywords || [],
          power: num(f0.power), toughness: num(f0.toughness),
          img: imgs.normal, small: imgs.small,
        });
      }
      url = d.has_more ? d.next_page : null;
      if (url) await new Promise((r) => setTimeout(r, 100));
    }
    out.sort((a, b) => a.cn - b.cn);
    try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), cards: out })); } catch {}
    return out;
  }
  async function rest(path) {
    const k = CFG.SUPABASE_ANON_KEY;
    const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: k, ...(k.startsWith("eyJ") ? { Authorization: `Bearer ${k}` } : {}) },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }
  async function loadReviews(reviewer) {
    if (!REMOTE) {
      let all = {}; try { all = JSON.parse(localStorage.getItem("rf_reviews") || "{}"); } catch {}
      const mine = all[reviewer] || null;
      return { mine, others: mine?.submitted ? Object.values(all).filter((r) => r.submitted && r.reviewer !== reviewer) : [] };
    }
    const [mine] = await rest(`reviews?reviewer=eq.${encodeURIComponent(reviewer)}&select=*`);
    // The pod's grades are only fetched once this player has submitted their own.
    const others = mine?.submitted ? await rest(`reviews?submitted=eq.true&reviewer=neq.${encodeURIComponent(reviewer)}&select=*`) : [];
    return { mine: mine || null, others };
  }

  // ---------- Grade helpers ----------
  const g = (grades, c) => grades[c.id];
  const graded = (grades, list = cards) => list.filter((c) => grades[c.id] != null);
  const avgOf = (grades, list) => mean(graded(grades, list).map((c) => grades[c.id]));
  const shareDist = (grades) => {
    const vals = Object.values(grades).filter((v) => v != null);
    const d = Array(13).fill(0); vals.forEach((v) => d[Math.round(v)]++);
    return vals.length ? d.map((x) => x / vals.length) : d;
  };
  // Comparison source for a section: { label, grades, dist }
  function source(choice) {
    if (!choice || !pod.length) return null;
    if (choice === "pod") {
      const grades = {};
      for (const c of cards) { const v = pod.map((r) => r.grades?.[c.id]).filter((x) => x != null); if (v.length) grades[c.id] = mean(v); }
      const dists = pod.map((r) => shareDist(r.grades || {}));
      return { label: `Pod average (${pod.length})`, short: "Pod", grades, dist: dists[0].map((_, i) => mean(dists.map((d) => d[i]))) };
    }
    const r = pod.find((p) => p.reviewer === choice);
    return r ? { label: r.display, short: r.display, grades: r.grades || {}, dist: shareDist(r.grades || {}) } : null;
  }

  // ---------- Tooltip & zoom ----------
  const tip = $("tip");
  function showTip(el, x, y) {
    tip.innerHTML = el.getAttribute("data-tip"); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${y + h + 20 > innerHeight ? y - h - 12 : y + 16}px`;
  }
  document.addEventListener("mouseover", (e) => { const t = e.target.closest("[data-tip]"); if (t) showTip(t, e.clientX, e.clientY); });
  document.addEventListener("mousemove", (e) => { if (!tip.hidden && e.target.closest("[data-tip]")) showTip(e.target.closest("[data-tip]"), e.clientX, e.clientY); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) tip.hidden = true; });
  document.addEventListener("click", (e) => {
    const z = e.target.closest("[data-zoom]");
    if (z) { const c = byId[z.dataset.zoom]; $("zoomImg").src = c.img; $("zoomImg").alt = c.name;
      const v = me.grades[c.id]; $("zoomCap").textContent = `${c.name} · ${v != null ? letter(v) : "ungraded"}`; $("zoom").showModal(); return; }
    if (e.target === $("zoom")) $("zoom").close();
    const t = e.target.closest("[data-tip]"); // tap support on touch screens
    if (t && matchMedia("(hover: none)").matches) showTip(t, e.clientX, e.clientY); else if (!t) tip.hidden = true;
  });

  // ---------- Chart primitives ----------
  // Horizontal bars on the grade scale (or a count scale when opts.max is set).
  function hbars(rows, { max = 12, count = false, cmp = null } = {}) {
    const pct = (v) => `${(Math.max(0, v) / max) * 100}%`;
    const legend = cmp ? `<div class="legend"><span>Bars: you</span><span><i class="lg-cmp"></i>${esc(cmp.label)}</span></div>` : "";
    const body = rows.map((r) => {
      const val = r.v == null ? "–" : count ? `${r.v}` : `${letter(r.v)}<em>${fmt1(r.v)}</em>`;
      const tipTxt = `<b>${esc(r.name || r.label)}</b><br>${count ? `${r.v} cards` : `You: ${letter(r.v)} (${fmt1(r.v)})`}${r.n != null ? ` · ${r.n} graded` : ""}`
        + (r.c != null ? `<br>${esc(cmp.label)}: ${count ? r.c : `${letter(r.c)} (${fmt1(r.c)})`}${!count && r.v != null ? ` · <span class="m">${signed(r.v - r.c)}</span>` : ""}` : "")
        + (r.extra ? `<br><span class="m">${r.extra}</span>` : "");
      return `<div class="hb-lbl">${r.sw ? `<span class="sw" style="background:${r.sw}"></span>` : ""}${r.pips || ""}${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</div>
        <div class="hb-track" data-tip="${esc(tipTxt)}">${r.v != null ? `<div class="hb-bar" style="width:${pct(r.v)};${r.fill ? `background:${r.fill}` : ""}"></div>` : ""}
          ${r.c != null ? `<div class="hb-cmp" style="left:${pct(r.c)}"></div>` : ""}</div>
        <div class="hb-val">${val}</div>`;
    }).join("");
    const axis = count ? "" : `<div></div><div class="hb-axis">${AXIS.map(([v, l]) => `<span style="left:${(v / 12) * 100}%">${l}</span>`).join("")}</div><div></div>`;
    return `${legend}<div class="hb">${body}${axis}</div>`;
  }

  // ---------- Sections ----------
  function secColors(cmp) {
    const rows = COLORS.map(({ key, label }) => {
      const list = cards.filter((c) => c.color === key);
      return { label, sw: `var(--${key})`, fill: `var(--${key})`, v: avgOf(me.grades, list), n: graded(me.grades, list).length,
        c: cmp ? avgOf(cmp.grades, list) : null };
    });
    $("chColors").innerHTML = `<p class="sub-h">Average grade</p>` + hbars(rows, { cmp });
    const deep = (grades, key) => cards.filter((c) => c.color === key && grades[c.id] >= 7).length; // B- or better
    const drows = COLORS.map(({ key, label }) => ({ label, sw: `var(--${key})`, fill: `var(--${key})`, v: deep(me.grades, key), c: cmp ? deep(cmp.grades, key) : null }));
    const max = Math.max(4, ...drows.map((r) => Math.max(r.v, r.c ?? 0)));
    $("chColorDepth").innerHTML = `<p class="sub-h">Cards rated B- or better</p>` + hbars(drows, { max, count: true, cmp });
  }

  function deckStrength(grades, a, b) {
    const pool = cards.filter((c) => grades[c.id] != null && c.colors.every((x) => x === a || x === b));
    const top = pool.map((c) => grades[c.id]).sort((x, y) => y - x).slice(0, 23);
    return { v: mean(top), n: top.length };
  }
  function secArch(cmp) {
    const rows = PAIRS.map(([a, b, name]) => {
      const ds = deckStrength(me.grades, a, b);
      const gold = cards.filter((c) => c.colors.length === 2 && c.colors.includes(a) && c.colors.includes(b));
      const goldAvg = avgOf(me.grades, gold);
      return { label: name, name: `${name} (${a}${b})`, pips: pips([a, b]), v: ds.v, c: cmp ? deckStrength(cmp.grades, a, b).v : null,
        extra: `Best ${ds.n} playables · signpost gold avg ${goldAvg != null ? letter(goldAvg) : "–"}${ds.n < 23 ? " · fewer than 23 graded" : ""}`,
        fill: `linear-gradient(90deg, var(--${a}), var(--${b}))` };
    }).sort((x, y) => (y.v ?? -1) - (x.v ?? -1));
    $("chArch").innerHTML = hbars(rows, { cmp });
  }

  function secDist(cmp) {
    const mine = Array(13).fill(0); Object.values(me.grades).forEach((v) => mine[Math.round(v)]++);
    const n = mine.reduce((a, b) => a + b, 0);
    const other = cmp ? cmp.dist.map((s) => s * n) : null;
    const W = 720, H = 240, L = 34, B = 26, T = 10, cw = (W - L) / 13, max = Math.max(1, ...mine, ...(other || [0]));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const step = max > 20 ? 10 : max > 8 ? 4 : 2;
    let s = `<svg class="svgc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grade distribution">`;
    for (let v = 0; v <= max; v += step) s += `<line class="gridl" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    GRADES.forEach((lab, i) => {
      const x = L + i * cw, bw = cw - 6, h = H - B - y(mine[i]);
      s += `<rect x="${x + 3}" y="${y(mine[i])}" width="${bw}" height="${Math.max(0, h)}" rx="3" fill="${gradeColor(i)}"/>`;
      if (other) s += `<rect x="${x + 3}" y="${y(other[i])}" width="${bw}" height="${Math.max(0, H - B - y(other[i]))}" rx="3" fill="none" stroke="var(--cmp)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      s += `<text x="${x + cw / 2}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
      s += `<rect class="hitcol" x="${x}" y="${T}" width="${cw}" height="${H - B - T}" data-tip="${esc(`<b>${lab}</b><br>You: ${mine[i]} card${mine[i] === 1 ? "" : "s"} (${n ? Math.round((mine[i] / n) * 100) : 0}%)${other ? `<br>${esc(cmp.label)}: ${Math.round(cmp.dist[i] * 100)}% of their grades` : ""}`)}"/>`;
    });
    s += `<line class="axisl" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/></svg>`;
    const legend = cmp ? `<div class="legend"><span><i class="lg-you" style="background:linear-gradient(90deg,${gradeColor(2)},${gradeColor(10)})"></i>You</span><span><i class="lg-cmp-box"></i>${esc(cmp.label)} (scaled to your ${n} cards)</span></div>` : "";
    $("chDist").innerHTML = legend + s;
  }

  function secRarity(cmp) {
    const rows = RARITIES.map(({ key, label, sw }) => {
      const list = cards.filter((c) => c.rarity === key);
      return { label, sw, v: avgOf(me.grades, list), n: graded(me.grades, list).length, c: cmp ? avgOf(cmp.grades, list) : null };
    });
    $("chRarity").innerHTML = hbars(rows, { cmp });
    // Heatmap: color × rarity
    let h = `<div class="heat"><div></div>${RARITIES.map((r) => `<div class="hh">${r.label}</div>`).join("")}`;
    for (const { key, label } of COLORS) {
      h += `<div class="hr"><span class="sw" style="background:var(--${key})"></span>${label}</div>`;
      for (const r of RARITIES) {
        const list = cards.filter((c) => c.color === key && c.rarity === r.key);
        const v = avgOf(me.grades, list), n = graded(me.grades, list).length;
        if (v == null) { h += `<div class="cell na">${list.length ? "–" : ""}</div>`; continue; }
        const cv = cmp ? avgOf(cmp.grades, list) : null;
        const a = (0.1 + 0.85 * (v / 12)).toFixed(2);
        const tipTxt = `<b>${label} ${r.label.toLowerCase()}s</b><br>You: ${letter(v)} (${fmt1(v)}) · ${n} of ${list.length} graded${cv != null ? `<br>${esc(cmp.label)}: ${letter(cv)} (${fmt1(cv)})` : ""}`;
        h += `<div class="cell ${v >= 7 ? "dark-text" : ""}" style="--a:${a}" data-tip="${esc(tipTxt)}">${letter(v)}<small>${cv != null ? signed(v - cv) + " vs " + esc(cmp.short) : `${n} cards`}</small></div>`;
      }
    }
    $("chHeat").innerHTML = h + "</div>";
  }

  function secCurve(cmp) {
    const buckets = [0, 1, 2, 3, 4, 5, 6, 7];
    const inB = (c, b) => (b === 7 ? c.cmc >= 7 : Math.floor(c.cmc) === b);
    const series = (grades) => buckets.map((b) => { const l = cards.filter((c) => inB(c, b)); return { v: avgOf(grades, l), n: graded(grades, l).length, total: l.length }; });
    const mine = series(me.grades), other = cmp ? series(cmp.grades) : null;
    const W = 720, H = 260, L = 34, R = 14, T = 12, B = 44, x = (i) => L + ((W - L - R) * i) / 7, y = (v) => T + (H - T - B) * (1 - v / 12);
    let s = `<svg class="svgc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average grade by mana value">`;
    AXIS.forEach(([v, l]) => (s += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${l}</text>`));
    const path = (ser) => ser.map((p, i) => (p.v == null ? null : `${x(i)},${y(p.v)}`)).filter(Boolean).join(" L");
    if (other) s += `<path d="M${path(other)}" fill="none" stroke="var(--cmp)" stroke-width="2" stroke-dasharray="6 4" opacity=".75"/>`;
    s += `<path d="M${path(mine)}" fill="none" stroke="var(--you)" stroke-width="2.5" stroke-linejoin="round"/>`;
    buckets.forEach((b, i) => {
      const p = mine[i], o = other?.[i];
      if (o?.v != null) s += `<circle cx="${x(i)}" cy="${y(o.v)}" r="4" fill="var(--panel-solid)" stroke="var(--cmp)" stroke-width="2"/>`;
      if (p.v != null) s += `<circle cx="${x(i)}" cy="${y(p.v)}" r="5.5" fill="var(--you)" stroke="var(--panel-solid)" stroke-width="2"/>`;
      s += `<text x="${x(i)}" y="${H - 24}" text-anchor="middle" style="fill:var(--ink)">${b === 7 ? "7+" : b}</text><text x="${x(i)}" y="${H - 8}" text-anchor="middle">${p.n}/${p.total}</text>`;
      const tt = `<b>Mana value ${b === 7 ? "7+" : b}</b><br>You: ${p.v != null ? `${letter(p.v)} (${fmt1(p.v)})` : "–"} · ${p.n} graded${o ? `<br>${esc(cmp.label)}: ${o.v != null ? `${letter(o.v)} (${fmt1(o.v)})` : "–"}` : ""}`;
      s += `<rect class="hitcol" x="${x(i) - (W - L - R) / 14}" y="${T}" width="${(W - L - R) / 7}" height="${H - T - B}" data-tip="${esc(tt)}"/>`;
    });
    s += `</svg>`;
    const legend = `<div class="legend"><span><i class="lg-you"></i>You</span>${cmp ? `<span><i class="lg-cmp-line"></i>${esc(cmp.label)}</span>` : ""}<span>Numbers under each mana value: cards graded / cards in set</span></div>`;
    $("chCurve").innerHTML = legend + s;
  }

  function secTypes(cmp) {
    const rows = TYPE_ORDER.map((t) => {
      const list = cards.filter((c) => c.type === t);
      return list.length ? { label: t, v: avgOf(me.grades, list), n: graded(me.grades, list).length, sub: ` ${list.length}`, c: cmp ? avgOf(cmp.grades, list) : null } : null;
    }).filter(Boolean);
    $("chTypes").innerHTML = hbars(rows, { cmp });
    const kw = {};
    cards.forEach((c) => c.keywords.forEach((k) => (kw[k] ||= []).push(c)));
    const krows = Object.entries(kw).map(([k, list]) => ({ label: k, v: avgOf(me.grades, list), n: graded(me.grades, list).length, c: cmp ? avgOf(cmp.grades, list) : null }))
      .filter((r) => r.n >= 4).sort((a, b) => b.v - a.v).slice(0, 14);
    $("chKeywords").innerHTML = krows.length ? hbars(krows, { cmp }) : `<p class="empty-note">Grade more cards to see keyword trends.</p>`;
  }

  function secBodies() {
    const cr = graded(me.grades, cards.filter((c) => c.type === "Creature" && c.power != null && c.toughness != null));
    if (!cr.length) { $("chBodies").innerHTML = `<p class="empty-note">No graded creatures yet.</p>`; return; }
    const W = 720, H = 300, L = 38, R = 14, T = 12, B = 34;
    const maxX = Math.max(7, ...cr.map((c) => c.cmc)), maxY = Math.max(8, ...cr.map((c) => c.power + c.toughness));
    const x = (v) => L + (W - L - R) * (v / maxX), y = (v) => T + (H - T - B) * (1 - v / maxY);
    let s = `<svg class="svgc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Creature stats by mana value">`;
    for (let v = 0; v <= maxY; v += 2) s += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    for (let v = 0; v <= maxX; v++) s += `<text x="${x(v)}" y="${H - 12}" text-anchor="middle">${v}</text>`;
    s += `<text x="${W - R}" y="${H - 12}" text-anchor="end" style="font-size:10px">mana value →</text><text x="${L}" y="${T - 2}" style="font-size:10px">P+T</text>`;
    // Stable jitter so overlapping bodies stay visible
    const seen = {};
    [...cr].sort((a, b) => me.grades[a.id] - me.grades[b.id]).forEach((c) => {
      const key = `${c.cmc}|${c.power + c.toughness}`, k = (seen[key] = (seen[key] || 0) + 1) - 1;
      const dx = k ? ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * 9) : 0;
      const v = me.grades[c.id];
      s += `<circle cx="${x(c.cmc) + dx}" cy="${y(c.power + c.toughness)}" r="6" fill="${gradeColor(v)}" stroke="var(--panel-solid)" stroke-width="2" data-zoom="${c.id}"
        data-tip="${esc(`<b>${esc(c.name)}</b><br>${c.power}/${c.toughness} for ${c.cmc} · ${letter(v)}`)}" style="cursor:zoom-in"/>`;
    });
    s += `</svg>`;
    const legend = `<div class="legend"><span>Dot color = your grade:</span>${[0, 5, 8, 11].map((v) => `<span><i class="sw" style="background:${gradeColor(v)}"></i>${letter(v)}</span>`).join("")}</div>`;
    $("chBodies").innerHTML = legend + s;
  }

  function cardRow(c, v, { rank, cmp, delta } = {}) {
    const cv = cmp ? cmp.grades[c.id] : null;
    return `<div class="crow">${rank != null ? `<span class="rk">${rank}</span>` : ""}<img src="${c.small}" alt="" loading="lazy" data-zoom="${c.id}">
      <div class="nm">${esc(c.name)}<small>${c.rarity} · ${c.type}</small></div>
      <div class="chips2">${delta != null ? `<span class="delta">${signed(delta)}</span>` : ""}${chip(v)}${cv != null ? `<span class="grade chip-cmp" title="${esc(cmp.label)}">${letter(cv)}</span>` : ""}</div></div>`;
  }
  function secBest(cmp) {
    const list = graded(me.grades).sort((a, b) => me.grades[b.id] - me.grades[a.id] || a.cn - b.cn);
    const legend = cmp ? `<div class="legend" style="grid-column:1/-1"><span>${chip(10)} You</span><span><span class="grade chip-cmp">B</span> ${esc(cmp.label)}</span></div>` : "";
    const col = (title, xs) => `<div><p class="sub-h">${title}</p><div class="clist">${xs.map((c, i) => cardRow(c, me.grades[c.id], { rank: i + 1, cmp })).join("") || `<p class="empty-note">Nothing graded yet.</p>`}</div></div>`;
    $("chBest").innerHTML = legend + col("Top 10", list.slice(0, 10)) + col("Bottom 10", [...list].reverse().slice(0, 10));
  }
  function secTakes(cmp) {
    if (!cmp) { $("chTakes").innerHTML = `<p class="empty-note" style="grid-column:1/-1">Pick something to compare with to see your hot takes.</p>`; return; }
    const both = graded(me.grades).filter((c) => cmp.grades[c.id] != null).map((c) => ({ c, d: me.grades[c.id] - cmp.grades[c.id] }));
    const hi = [...both].sort((a, b) => b.d - a.d).filter((x) => x.d > 0).slice(0, 8);
    const lo = [...both].sort((a, b) => a.d - b.d).filter((x) => x.d < 0).slice(0, 8);
    const col = (title, xs) => `<div><p class="sub-h">${title}</p><div class="clist">${xs.map(({ c, d }) => cardRow(c, me.grades[c.id], { cmp, delta: d })).join("") || `<p class="empty-note">None.</p>`}</div></div>`;
    $("chTakes").innerHTML = `<div class="legend" style="grid-column:1/-1"><span>Number = your grade minus ${esc(cmp.label)}, in grade steps</span></div>`
      + col(`Higher than ${esc(cmp.short)}`, hi) + col(`Lower than ${esc(cmp.short)}`, lo);
  }
  function secCommons(cmp) {
    const cols = COLORS.map(({ key, label }) => {
      const xs = graded(me.grades, cards.filter((c) => c.rarity === "common" && c.color === key)).sort((a, b) => me.grades[b.id] - me.grades[a.id]).slice(0, 5);
      return xs.length ? `<div><h3>${pips([key])}${label}</h3><div class="clist">${xs.map((c) => cardRow(c, me.grades[c.id], { cmp })).join("")}</div></div>` : "";
    }).join("");
    $("chCommons").innerHTML = cols ? `<div class="commons">${cols}</div>` : `<p class="empty-note">No commons graded yet.</p>`;
  }
  function secTier() {
    $("tierColors").innerHTML = [{ key: "all", label: "All" }, ...COLORS].map(({ key, label }) =>
      `<button data-tc="${key}" class="${tierColor === key ? "on" : ""}">${key !== "all" ? `<span class="sw" style="background:var(--${key})"></span>` : ""}${label}</button>`).join("");
    const list = graded(me.grades).filter((c) => tierColor === "all" || c.color === tierColor);
    $("chTier").innerHTML = [...GRADES].reverse().map((lab) => {
      const v = GRADES.indexOf(lab);
      const xs = list.filter((c) => Math.round(me.grades[c.id]) === v).sort((a, b) => a.cn - b.cn);
      return `<div class="tier"><div class="tier-l" style="background:${gradeColor(v)}">${lab}</div><div class="tier-cards">${
        xs.map((c) => `<img src="${c.small}" alt="${esc(c.name)}" loading="lazy" data-zoom="${c.id}" data-tip="${esc(`<b>${esc(c.name)}</b>`)}">`).join("") || `<span class="none">—</span>`}</div></div>`;
    }).join("");
  }

  // ---------- Profile & KPIs ----------
  function renderProfile() {
    const vals = Object.values(me.grades);
    const avg = mean(vals);
    $("pName").textContent = me.display;
    $("pSub").textContent = `${vals.length} of ${cards.length} cards graded · ${me.submitted ? "Review submitted" : "Review in progress"}`;
    $("pGrade").textContent = letter(avg);

    const tags = [];
    const colorAvgs = WUBRG.map((k) => ({ k, v: avgOf(me.grades, cards.filter((c) => c.color === k)) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    if (colorAvgs.length >= 2) {
      tags.push(`Favorite color <b>${COLORS.find((c) => c.key === colorAvgs[0].k).label}</b>`);
      tags.push(`Least favorite <b>${COLORS.find((c) => c.key === colorAvgs.at(-1).k).label}</b>`);
    }
    const best = PAIRS.map(([a, b, name]) => ({ name, ...deckStrength(me.grades, a, b) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v)[0];
    if (best) tags.push(`Best deck <b>${best.name}</b>`);
    const byR = (r) => avgOf(me.grades, cards.filter((c) => c.rarity === r));
    const cu = byR("common"), ra = mean([byR("rare"), byR("mythic")].filter((x) => x != null));
    if (cu != null && ra != null) tags.push(ra - cu >= 2.5 ? `<b>Bomb chaser</b>` : ra - cu <= 1 ? `<b>Commons connoisseur</b>` : `<b>Balanced</b> on rarity`);
    const cheap = avgOf(me.grades, cards.filter((c) => c.cmc <= 2)), big = avgOf(me.grades, cards.filter((c) => c.cmc >= 5));
    if (cheap != null && big != null) tags.push(cheap - big >= 1 ? `<b>Tempo</b>-minded` : big - cheap >= 1 ? `Believes in <b>big spells</b>` : `<b>Even</b> across the curve`);
    const s = sd(vals);
    if (s != null && vals.length >= 10) tags.push(s >= 3 ? `<b>Polarized</b> grader` : s <= 2 ? `<b>Hedges</b> toward the middle` : `<b>Wide</b> grade range`);
    $("pTags").innerHTML = tags.map((t) => `<span class="tag">${t}</span>`).join("");

    const cnt = (f) => vals.filter(f).length;
    const k = [
      [`${vals.length}<small>/${cards.length}</small>`, "Cards graded"],
      [`${letter(avg)} <small>${fmt1(avg)}</small>`, "Mean grade"],
      [`${letter(median(vals))}`, "Median grade"],
      [`${fmt1(s)}`, "Spread (σ, grade steps)"],
      [`${cnt((v) => v >= 10)}`, "Bombs (A- or better)"],
      [`${cnt((v) => v >= 6)}`, "Playables (C+ or better)"],
      [`${cnt((v) => v <= 3)}`, "Chaff (D+ or worse)"],
      [`${Object.keys(me.notes || {}).length}`, "Notes written"],
    ];
    $("kpis").innerHTML = k.map(([b, l]) => `<div class="kpi"><b>${b}</b><span>${l}</span></div>`).join("");
  }

  // ---------- Compare controls ----------
  const SECTIONS = {
    "sec-colors": secColors, "sec-archetypes": secArch, "sec-dist": secDist, "sec-rarity": secRarity, "sec-curve": secCurve,
    "sec-types": secTypes, "sec-creatures": secBodies, "sec-takes": secTakes, "sec-best": secBest, "sec-commons": secCommons, "sec-tier": secTier,
  };
  const NO_COMPARE = new Set(["sec-creatures", "sec-tier"]);
  function renderSection(id) { SECTIONS[id](source(cmpChoice[id])); }
  function mountCompare() {
    for (const id of Object.keys(SECTIONS)) {
      const sec = $(id), header = sec.querySelector("header");
      if (NO_COMPARE.has(id)) continue;
      const box = document.createElement("div"); box.className = "cmp-row";
      if (!me.submitted) {
        box.innerHTML = `<span class="cmp-lock">🔒 Compare with the pod after you <a href="./">submit your review</a></span>`;
      } else if (!pod.length) {
        box.innerHTML = `<span class="cmp-lock">No one else has submitted yet</span>`;
      } else {
        box.innerHTML = `<label for="cmp-${id}">Compare</label><select id="cmp-${id}" data-sec="${id}">
          <option value="">No comparison</option><option value="pod">Pod average (${pod.length})</option>
          ${pod.map((p) => `<option value="${esc(p.reviewer)}">${esc(p.display)}</option>`).join("")}</select>`;
      }
      header.appendChild(box);
    }
    // Hot takes only makes sense with a comparison available
    $("sec-takes").hidden = !(me.submitted && pod.length);
    if (me.submitted && pod.length) { cmpChoice["sec-takes"] = "pod"; $("cmp-sec-takes").value = "pod"; }
  }
  document.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-sec]"); if (!s) return;
    cmpChoice[s.dataset.sec] = s.value; renderSection(s.dataset.sec);
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tc]"); if (!b) return;
    tierColor = b.dataset.tc; secTier();
  });

  function mountJump() {
    const secs = [...document.querySelectorAll(".panel[data-title]")].filter((s) => !s.hidden);
    $("jump").innerHTML = secs.map((s) => `<a href="#${s.id}" data-j="${s.id}">${esc(s.dataset.title)}</a>`).join("");
    const io = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (en.isIntersecting) document.querySelectorAll(".jump a").forEach((a) => a.classList.toggle("on", a.dataset.j === en.target.id));
    }), { rootMargin: "-40% 0px -55% 0px" });
    secs.forEach((s) => io.observe(s));
  }

  // ---------- Boot ----------
  function fail(html) { $("status").innerHTML = html; }
  (async () => {
    let name = null, passOk = false;
    try { name = localStorage.getItem("rf_me"); passOk = !CFG.PASSCODE_SHA256 || localStorage.getItem("rf_pass_ok") === CFG.PASSCODE_SHA256; } catch {}
    if (!passOk || !name) return fail(`Sign in on the <a href="./">review page</a> first, then come back here.`);
    try {
      cards = await loadCards(); cards.forEach((c) => (byId[c.id] = c));
      const { mine, others } = await loadReviews(name.trim().toLowerCase());
      if (!mine || !Object.keys(mine.grades || {}).length) return fail(`No grades yet for <b>${esc(name)}</b>. <a href="./">Grade some cards</a> and your analysis will appear here.`);
      me = { ...mine, grades: mine.grades || {}, notes: mine.notes || {} };
      pod = others.filter((r) => Object.keys(r.grades || {}).length);
    } catch (e) {
      console.error(e); return fail(`Couldn't load data (${esc(e.message)}). Refresh to try again.`);
    }
    $("status").hidden = true; $("report").hidden = false;
    document.title = `${me.display} · Player Analysis`;
    renderProfile();
    mountCompare();
    Object.keys(SECTIONS).forEach(renderSection);
    mountJump();
  })();
})();
