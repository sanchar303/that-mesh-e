(() => {
  const RTDB_NODES = "https://cloud-db-studio-default-rtdb.firebaseio.com/mesh_e/nodes.json";
  const STALE_MS = 12000;

  const state = {
    mode: "fusion", // fusion | sonar | acoustic
    theme: localStorage.getItem("meshe_theme") || "dark",
    nodes: {},
    positions: JSON.parse(localStorage.getItem("meshe_pos") || "{}"),
    focusPuck: { x: 0.5, y: 0.5 }, // Normalized 0..1 room coordinate
    dragging: null, // nodeId or "FOCUS_PUCK"
    voiceZoom: false,
    chimeEnabled: false,
    audioCtx: null,
    audioNodes: {}, // { [id]: { gainNode, audioEl } }
    rfHistory: new Array(60).fill(0),
    acHistory: new Array(60).fill(0),
    events: [],
    lastAlertMs: 0,
    tdoaBlip: null // { x, y, label, ttl }
  };

  const el = {
    syncLed: document.getElementById("sync-led"),
    syncLabel: document.getElementById("sync-label"),
    themeToggle: document.getElementById("theme-toggle"),
    themeIcon: document.getElementById("theme-icon"),
    mNodes: document.getElementById("m-nodes"),
    mRf: document.getElementById("m-rf"),
    mAudio: document.getElementById("m-audio"),
    mZone: document.getElementById("m-zone"),
    meshCanvas: document.getElementById("mesh-canvas"),
    scopeCanvas: document.getElementById("scope-canvas"),
    btnVoiceZoom: document.getElementById("btn-voice-zoom"),
    btnChime: document.getElementById("btn-chime"),
    btnAutoLayout: document.getElementById("btn-auto-layout"),
    eventFeed: document.getElementById("event-feed"),
    nodesGrid: document.getElementById("nodes-grid")
  };

  // Theme Initialization
  function applyTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    el.themeIcon.textContent = t === "dark" ? "☀" : "☾";
    localStorage.setItem("meshe_theme", t);
  }
  applyTheme(state.theme);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function getActiveNodes() {
    const now = Date.now();
    return Object.values(state.nodes).filter(
      (n) => n && n.url && n.status === "online" && now - (n.lastSeen || 0) <= STALE_MS
    );
  }

  function ensureNodePosition(id, index, total) {
    if (!state.positions[id]) {
      const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
      const radius = total === 1 ? 0 : 0.3;
      state.positions[id] = {
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius
      };
      localStorage.setItem("meshe_pos", JSON.stringify(state.positions));
    }
    return state.positions[id];
  }

  function autoArrangeNodes() {
    const active = getActiveNodes();
    active.forEach((n, idx) => {
      const angle = (idx / Math.max(active.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const radius = active.length === 1 ? 0 : 0.32;
      state.positions[n.id] = {
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius
      };
    });
    localStorage.setItem("meshe_pos", JSON.stringify(state.positions));
  }

  function pushEvent(type, text) {
    const now = new Date();
    const stamp = now.toTimeString().slice(0, 8);
    if (state.events[0] && state.events[0].text === text && Date.now() - state.events[0].ms < 2500) {
      return;
    }
    state.events.unshift({ type, text, stamp, ms: Date.now() });
    if (state.events.length > 24) state.events.pop();

    el.eventFeed.innerHTML = state.events
      .map(
        (ev) => `
        <div class="ev-row">
          <span><span class="ev-tag ${ev.type}">${ev.type === "rf" ? "RF" : "MIC"}</span> ${esc(ev.text)}</span>
          <small style="color:var(--muted)">${ev.stamp}</small>
        </div>`
      )
      .join("");

    if (state.chimeEnabled && Date.now() - state.lastAlertMs > 3000) {
      state.lastAlertMs = Date.now();
      playChime(type === "rf" ? 520 : 780);
    }
  }

  function playChime(freq) {
    try {
      const ctx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      state.audioCtx = ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    } catch {}
  }

  // ============================================================================
  // PHASED-ARRAY BEAMFORMED VOICE ZOOM (WebAudio Spatial Gain + Bandpass Filter)
  // ============================================================================
  function syncAudioBeamforming(active) {
    if (!state.voiceZoom) return;
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const activeIds = new Set(active.map((n) => n.id));
    for (const id of Object.keys(state.audioNodes)) {
      if (!activeIds.has(id)) {
        try {
          state.audioNodes[id].audioEl.pause();
          state.audioNodes[id].audioEl.src = "";
        } catch {}
        delete state.audioNodes[id];
      }
    }

    active.forEach((node, idx) => {
      const pos = ensureNodePosition(node.id, idx, active.length);
      const dx = pos.x - state.focusPuck.x;
      const dy = pos.y - state.focusPuck.y;
      const dist = Math.hypot(dx, dy);

      // Inverse-square spatial weighting toward Focus Puck
      const targetGain = Math.max(0.05, Math.min(1.4, 1.0 / (1.0 + dist * dist * 14.0)));

      if (!state.audioNodes[node.id]) {
        const audioEl = new Audio(`${node.url}/audio_stream`);
        audioEl.crossOrigin = "anonymous";
        const src = state.audioCtx.createMediaElementSource(audioEl);

        // Voice isolation bandpass (300Hz - 3400Hz)
        const hp = state.audioCtx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 280;

        const lp = state.audioCtx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 3400;

        const gainNode = state.audioCtx.createGain();
        gainNode.gain.value = targetGain;

        src.connect(hp).connect(lp).connect(gainNode).connect(state.audioCtx.destination);
        audioEl.play().catch(() => {});
        state.audioNodes[node.id] = { audioEl, gainNode };
      } else {
        state.audioNodes[node.id].gainNode.gain.setTargetAtTime(
          targetGain,
          state.audioCtx.currentTime,
          0.06
        );
      }
    });
  }

  function stopVoiceZoom() {
    for (const id of Object.keys(state.audioNodes)) {
      try {
        state.audioNodes[id].audioEl.pause();
        state.audioNodes[id].audioEl.src = "";
      } catch {}
      delete state.audioNodes[id];
    }
  }

  // ============================================================================
  // RTDB LIVE SYNC + DIRECT TUNNEL FAST POLLING
  // ============================================================================
  function connectRtdb() {
    const sync = async () => {
      try {
        const res = await fetch(RTDB_NODES);
        if (!res.ok) throw new Error();
        const raw = (await res.json()) || {};
        const now = Date.now();

        // Auto-prune ghost nodes if a PC lost power abruptly
        for (const [k, v] of Object.entries(raw)) {
          if (v && v.lastSeen && now - v.lastSeen > STALE_MS * 2) {
            fetch(`https://cloud-db-studio-default-rtdb.firebaseio.com/mesh_e/nodes/${k}.json`, {
              method: "DELETE"
            }).catch(() => {});
            delete raw[k];
          }
        }

        state.nodes = raw;
        el.syncLabel.textContent = "Mesh Live";
        el.syncLed.style.opacity = "1";
        updateMetricsAndCards();
      } catch {
        el.syncLabel.textContent = "Reconnecting";
        el.syncLed.style.opacity = "0.4";
      }
    };

    sync();
    setInterval(sync, 550);

    try {
      const es = new EventSource(RTDB_NODES);
      es.addEventListener("put", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.path === "/") state.nodes = msg.data || {};
        else {
          const k = msg.path.replace(/^\//, "").split("/")[0];
          if (msg.data === null) delete state.nodes[k];
          else state.nodes[k] = msg.data;
        }
        updateMetricsAndCards();
      });
      es.addEventListener("patch", (e) => {
        const msg = JSON.parse(e.data);
        const k = msg.path.replace(/^\//, "").split("/")[0];
        if (k && state.nodes[k] && msg.data) Object.assign(state.nodes[k], msg.data);
        updateMetricsAndCards();
      });
    } catch {}
  }

  function updateMetricsAndCards() {
    const active = getActiveNodes();
    el.mNodes.textContent = String(active.length);

    if (active.length === 0) {
      el.mRf.textContent = "IDLE";
      el.mAudio.innerHTML = `-60 <small>dB</small>`;
      el.mZone.textContent = "—";
      el.nodesGrid.innerHTML = `<div class="neu-panel empty-box">Run ThatMeshE.exe on one or more laptops to initialize the spatial sensor mesh.</div>`;
      return;
    }

    let maxRf = 0;
    let rfState = "CALM";
    let maxDb = -60;
    let maxRms = 0;
    let hottestRfNode = null;
    let loudestAcNode = null;
    let weightedX = 0;
    let weightedY = 0;
    let weightSum = 0;

    active.forEach((n, idx) => {
      const pos = ensureNodePosition(n.id, idx, active.length);
      const rf = n.wifi?.motionEnergy || 0;
      const rms = n.audio?.rms || 0;
      const db = n.audio?.db ?? -60;

      if (rf > maxRf) {
        maxRf = rf;
        rfState = n.wifi?.state || "CALM";
        hottestRfNode = n;
      }
      if (db > maxDb) maxDb = db;
      if (rms > maxRms) {
        maxRms = rms;
        loudestAcNode = n;
      }

      const w = (state.mode !== "acoustic" ? rf : 0) + (state.mode !== "sonar" ? rms : 0) + 0.1;
      weightedX += pos.x * w;
      weightedY += pos.y * w;
      weightSum += w;

      if (n.audio?.spike && state.mode !== "sonar") {
        state.tdoaBlip = {
          x: pos.x,
          y: pos.y,
          label: n.name,
          ttl: 1.0
        };
        pushEvent("ac", `Sound impulse near ${n.name} (${db} dB)`);
      }
    });

    if (maxRf >= 38 && state.mode !== "acoustic" && hottestRfNode) {
      pushEvent("rf", `Through-wall movement near ${hottestRfNode.name}`);
    }

    state.rfHistory.push(maxRf);
    state.rfHistory.shift();
    state.acHistory.push(maxRms);
    state.acHistory.shift();

    el.mRf.textContent = rfState;
    el.mAudio.innerHTML = `${Math.round(maxDb)} <small>dB</small>`;

    if (maxRf >= 14 || maxRms >= 18) {
      const target = maxRf >= maxRms ? hottestRfNode : loudestAcNode;
      el.mZone.textContent = target ? target.name : "Active";
    } else {
      el.mZone.textContent = "Clear";
    }

    if (state.voiceZoom) {
      syncAudioBeamforming(active);
    }

    el.nodesGrid.innerHTML = active
      .map((n) => {
        const w = n.wifi || {};
        const a = n.audio || {};
        return `
          <div class="neu-panel node-card">
            <div class="node-top">
              <div class="node-title">${esc(n.name || n.id)}</div>
              <span class="node-badge">${esc(w.state || "ONLINE")}</span>
            </div>
            <div class="neu-inset node-bars">
              <div class="bar-row">
                <header><span>Wi-Fi Sonar (${w.rssi ?? -55} dBm)</span><span>${(w.motionEnergy || 0).toFixed(0)}%</span></header>
                <div class="meter"><div class="meter-fill rf" style="width:${Math.min(100, w.motionEnergy || 0)}%"></div></div>
              </div>
              <div class="bar-row">
                <header><span>Acoustic Mic (${a.db ?? -60} dB)</span><span>${(a.rms || 0).toFixed(0)}%</span></header>
                <div class="meter"><div class="meter-fill ac" style="width:${Math.min(100, a.rms || 0)}%"></div></div>
              </div>
            </div>
          </div>`;
      })
      .join("");
  }

  // ============================================================================
  // 2D SPATIAL RADAR & ACOUSTIC CAMERA HEATMAP RENDERER (60 FPS)
  // ============================================================================
  function renderLoop() {
    const canvas = el.meshCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const isDark = state.theme === "dark";
    const active = getActiveNodes();
    const now = performance.now() / 1000;

    // Subtle spatial grid
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.045)" : "rgba(15,23,42,0.06)";
    ctx.lineWidth = 1;
    const step = 36;
    for (let x = step; x < W; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = step; y < H; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Cross-node RF tomography links (Wi-Fi Sonar)
    if (state.mode !== "acoustic" && active.length > 1) {
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const p1 = ensureNodePosition(active[i].id, i, active.length);
          const p2 = ensureNodePosition(active[j].id, j, active.length);
          const linkEnergy = ((active[i].wifi?.motionEnergy || 0) + (active[j].wifi?.motionEnergy || 0)) / 2;

          ctx.beginPath();
          ctx.moveTo(p1.x * W, p1.y * H);
          ctx.lineTo(p2.x * W, p2.y * H);
          ctx.strokeStyle =
            linkEnergy > 18
              ? `rgba(56, 189, 248, ${Math.min(0.85, 0.2 + linkEnergy / 90)})`
              : isDark
              ? "rgba(56, 189, 248, 0.14)"
              : "rgba(2, 132, 199, 0.18)";
          ctx.lineWidth = linkEnergy > 18 ? 3 : 1.5;
          ctx.setLineDash([6, 6]);
          ctx.lineDashOffset = -now * 24;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Node RF & Acoustic Radial Fields
    active.forEach((node, idx) => {
      const pos = ensureNodePosition(node.id, idx, active.length);
      const cx = pos.x * W;
      const cy = pos.y * H;
      const rf = node.wifi?.motionEnergy || 0;
      const rms = node.audio?.rms || 0;

      // Wi-Fi Sonar Through-Wall Ripples
      if (state.mode !== "acoustic") {
        const maxR = 45 + rf * 1.45;
        for (let r = 0; r < 3; r++) {
          const phase = ((now * 0.75 + r * 0.33) % 1);
          const rad = 22 + phase * maxR;
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - phase) * (0.18 + rf / 130)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Acoustic Camera Heatmap Glow
      if (state.mode !== "sonar" && rms > 2) {
        const acRad = 36 + rms * 1.7;
        const grad = ctx.createRadialGradient(cx, cy, 6, cx, cy, acRad);
        grad.addColorStop(0, `rgba(52, 211, 153, ${Math.min(0.65, rms / 90)})`);
        grad.addColorStop(1, "rgba(52, 211, 153, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, acRad, 0, Math.PI * 2);
        ctx.fill();
      }

      // Neumorphic Node Puck
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? "#1e2534" : "#eef3fa";
      ctx.shadowColor = isDark ? "rgba(0,0,0,0.75)" : "rgba(140,155,180,0.65)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 4;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rf > 25 ? "#38bdf8" : rms > 20 ? "#34d399" : isDark ? "rgba(255,255,255,0.2)" : "rgba(15,23,42,0.18)";
      ctx.stroke();

      // Label
      ctx.fillStyle = isDark ? "#eef2f8" : "#1b2434";
      ctx.font = "700 12px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(node.name || node.id, cx, cy + 35);
    });

    // TDOA Impulse Blip
    if (state.tdoaBlip && state.tdoaBlip.ttl > 0) {
      const bx = state.tdoaBlip.x * W;
      const by = state.tdoaBlip.y * H;
      ctx.beginPath();
      ctx.arc(bx, by, (1.2 - state.tdoaBlip.ttl) * 70, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(52, 211, 153, ${state.tdoaBlip.ttl})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      state.tdoaBlip.ttl -= 0.025;
    }

    // Beamforming Focus Puck (Acoustic Camera)
    if (state.mode !== "sonar" && active.length > 0) {
      const fx = state.focusPuck.x * W;
      const fy = state.focusPuck.y * H;

      ctx.beginPath();
      ctx.arc(fx, fy, 15, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(244, 114, 182, 0.22)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#f472b6";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(fx, fy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#f472b6";
      ctx.fill();
    }

    ctx.restore();
    renderScope();
    requestAnimationFrame(renderLoop);
  }

  function renderScope() {
    const canvas = el.scopeCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const drawLine = (arr, color) => {
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / (arr.length - 1)) * W;
        const y = H - 12 - (Math.min(100, v) / 100) * (H - 24);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.stroke();
    };

    if (state.mode !== "acoustic") drawLine(state.rfHistory, "#38bdf8");
    if (state.mode !== "sonar") drawLine(state.acHistory, "#34d399");
    ctx.restore();
  }

  // ============================================================================
  // POINTER DRAGGING FOR ROOM NODES & ACOUSTIC FOCUS PUCK
  // ============================================================================
  function pointerPos(e) {
    const rect = el.meshCanvas.getBoundingClientRect();
    return {
      nx: Math.max(0.06, Math.min(0.94, (e.clientX - rect.left) / rect.width)),
      ny: Math.max(0.08, Math.min(0.92, (e.clientY - rect.top) / rect.height)),
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      w: rect.width,
      h: rect.height
    };
  }

  el.meshCanvas.addEventListener("pointerdown", (e) => {
    const p = pointerPos(e);
    const active = getActiveNodes();

    // Check Focus Puck first
    if (state.mode !== "sonar" && active.length > 0) {
      const fdist = Math.hypot(state.focusPuck.x * p.w - p.px, state.focusPuck.y * p.h - p.py);
      if (fdist < 22) {
        state.dragging = "FOCUS_PUCK";
        el.meshCanvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    for (let i = 0; i < active.length; i++) {
      const pos = ensureNodePosition(active[i].id, i, active.length);
      const d = Math.hypot(pos.x * p.w - p.px, pos.y * p.h - p.py);
      if (d < 26) {
        state.dragging = active[i].id;
        el.meshCanvas.setPointerCapture(e.pointerId);
        return;
      }
    }
  });

  el.meshCanvas.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    const p = pointerPos(e);
    if (state.dragging === "FOCUS_PUCK") {
      state.focusPuck = { x: p.nx, y: p.ny };
    } else {
      state.positions[state.dragging] = { x: p.nx, y: p.ny };
      localStorage.setItem("meshe_pos", JSON.stringify(state.positions));
    }
  });

  el.meshCanvas.addEventListener("pointerup", (e) => {
    if (state.dragging) {
      state.dragging = null;
      try {
        el.meshCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    }
  });

  // ============================================================================
  // UI CONTROLS
  // ============================================================================
  document.querySelectorAll("#mode-switch .neu-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#mode-switch .neu-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.mode = pill.dataset.mode;
    });
  });

  el.themeToggle.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });

  el.btnVoiceZoom.addEventListener("click", () => {
    state.voiceZoom = !state.voiceZoom;
    el.btnVoiceZoom.classList.toggle("active", state.voiceZoom);
    el.btnVoiceZoom.textContent = `Voice Zoom: ${state.voiceZoom ? "ON" : "OFF"}`;
    if (state.voiceZoom) syncAudioBeamforming(getActiveNodes());
    else stopVoiceZoom();
  });

  el.btnChime.addEventListener("click", () => {
    state.chimeEnabled = !state.chimeEnabled;
    el.btnChime.classList.toggle("active", state.chimeEnabled);
    el.btnChime.textContent = `Alert Tone: ${state.chimeEnabled ? "ON" : "OFF"}`;
  });

  el.btnAutoLayout.addEventListener("click", autoArrangeNodes);

  connectRtdb();
  requestAnimationFrame(renderLoop);
})();