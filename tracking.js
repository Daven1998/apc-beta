// APC Beta — tracking + friction-detection helpers
// Centralises: device info, Clarity, custom events, session timeout, friction counters.

(function () {
  const BUILD = "v0.3.4-beta";
  const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;   // 24h inactivity → logout
  const ACTIVITY_PING_MS   = 30 * 1000;             // touch last-activity every 30s of activity

  // ---------- Device + browser ----------
  function getDeviceInfo() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    return {
      ua,
      platform,
      language: navigator.language,
      screen_w: window.screen ? window.screen.width : null,
      screen_h: window.screen ? window.screen.height : null,
      dpr: window.devicePixelRatio || 1,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      is_ios: isIOS,
      is_safari: isSafari,
      is_ios_safari: isIOS && isSafari,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      online: navigator.onLine,
      build: BUILD
    };
  }

  // ---------- Microsoft Clarity (DISABLED placeholder) ----------
  // Paste your Clarity project ID here to enable. Leave blank to keep disabled.
  const CLARITY_PROJECT_ID = ""; // e.g. "abc123xyz"

  function initClarity() {
    if (!CLARITY_PROJECT_ID) return; // disabled by default
    // Standard Clarity snippet
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", CLARITY_PROJECT_ID);
  }

  function clarityEvent(name, props) {
    if (window.clarity) {
      try { window.clarity("event", name); } catch(e){}
      if (props) { try { window.clarity("set", name, JSON.stringify(props)); } catch(e){} }
    }
  }

  // ---------- Friction counters (per-step, in-memory until logged) ----------
  const friction = {
    back_clicks: 0,
    field_edits: 0,
    upload_retries: 0,
    upload_failures: 0,
    rage_clicks: 0,
    dwell_start_ms: Date.now()
  };
  function resetFriction() {
    friction.back_clicks = 0;
    friction.field_edits = 0;
    friction.upload_retries = 0;
    friction.upload_failures = 0;
    friction.rage_clicks = 0;
    friction.dwell_start_ms = Date.now();
  }
  function getFrictionSnapshot() {
    return {
      back_clicks: friction.back_clicks,
      field_edits: friction.field_edits,
      upload_retries: friction.upload_retries,
      upload_failures: friction.upload_failures,
      rage_clicks: friction.rage_clicks,
      dwell_ms: Date.now() - friction.dwell_start_ms
    };
  }

  // Rage-click detection: 4+ clicks in same spot within 1s
  const recentClicks = [];
  document.addEventListener("click", (e) => {
    const now = Date.now();
    recentClicks.push({ t: now, x: e.clientX, y: e.clientY });
    while (recentClicks.length && now - recentClicks[0].t > 1000) recentClicks.shift();
    if (recentClicks.length >= 4) {
      const first = recentClicks[0];
      const sameSpot = recentClicks.every(c => Math.abs(c.x - first.x) < 30 && Math.abs(c.y - first.y) < 30);
      if (sameSpot) {
        friction.rage_clicks++;
        recentClicks.length = 0;
      }
    }
  }, true);

  // Track field edits globally
  document.addEventListener("input", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) {
      friction.field_edits++;
    }
  }, true);

  // ---------- Session timeout ----------
  let lastActivityKey = "apc_last_activity";
  function pingActivity() {
    try { localStorage.setItem(lastActivityKey, String(Date.now())); } catch(e){}
  }
  function checkSessionTimeout(supabaseClient, onTimeout) {
    let last;
    try { last = parseInt(localStorage.getItem(lastActivityKey) || "0", 10); } catch(e){ last = 0; }
    if (last && Date.now() - last > SESSION_TIMEOUT_MS) {
      try { localStorage.removeItem(lastActivityKey); } catch(e){}
      supabaseClient.auth.signOut().then(() => { if (onTimeout) onTimeout(); });
      return true;
    }
    return false;
  }
  // Activity = any interaction
  ["click","keydown","touchstart","scroll"].forEach(ev => {
    document.addEventListener(ev, () => { pingActivity(); }, { passive: true, capture: true });
  });
  pingActivity();

  // ---------- File validation ----------
  // Magic-byte sniffing: PDF, JPEG, PNG
  async function validateUploadFile(file, opts = {}) {
    const maxBytes = opts.maxBytes || 10 * 1024 * 1024;
    const allowed = opts.allowedExt || ["pdf","jpg","jpeg","png"];
    const errors = [];

    if (file.size > maxBytes) errors.push(`File is over ${(maxBytes/1024/1024).toFixed(0)} MB.`);
    if (file.size < 100)      errors.push("File is suspiciously tiny (less than 100 bytes).");

    const lower = file.name.toLowerCase();
    const ext = lower.split(".").pop();
    if (!allowed.includes(ext)) errors.push(`File extension .${ext} not allowed. Use PDF, JPG, or PNG.`);

    // Sniff first 8 bytes
    try {
      const head = await file.slice(0, 8).arrayBuffer();
      const b = new Uint8Array(head);
      const isPDF  = b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46; // %PDF
      const isJPG  = b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF;
      const isPNG  = b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47; // \x89PNG
      const claimedType = file.type || "";
      const isClaimedPDF = ext === "pdf";
      const isClaimedJPG = ext === "jpg" || ext === "jpeg";
      const isClaimedPNG = ext === "png";

      if (isClaimedPDF && !isPDF) errors.push("File extension says PDF but the file isn't a real PDF.");
      if (isClaimedJPG && !isJPG) errors.push("File extension says JPG but the file isn't a real JPEG.");
      if (isClaimedPNG && !isPNG) errors.push("File extension says PNG but the file isn't a real PNG.");

      // Reject obviously dangerous: executables, scripts, archives
      const looksExec = (b[0]===0x4D && b[1]===0x5A)   // MZ (EXE)
                     || (b[0]===0x7F && b[1]===0x45 && b[2]===0x4C && b[3]===0x46) // ELF
                     || (b[0]===0x50 && b[1]===0x4B);  // ZIP / docx / xlsx
      if (looksExec) errors.push("This looks like an executable or archive — not allowed.");

      // Filename safety
      if (/[<>:"|?*\x00-\x1F]/.test(file.name)) errors.push("Filename contains characters that aren't allowed.");
      if (file.name.length > 200) errors.push("Filename is too long.");
    } catch (e) {
      errors.push("Couldn't read the file. Try a different one.");
    }

    return { ok: errors.length === 0, errors };
  }

  // ---------- Help button ----------
  function injectHelpButton(opts = {}) {
    if (document.getElementById("apc-help-fab")) return;
    const fab = document.createElement("div");
    fab.id = "apc-help-fab";
    fab.innerHTML = `
      <button class="help-fab-btn" aria-label="Need help">?</button>
      <div class="help-fab-panel" hidden>
        <strong>Need help?</strong>
        <p style="margin:6px 0 10px;font-size:14px">
          You're in the APC beta. Anything broken or confusing? Drop us a line — we read every message.
        </p>
        <a class="btn btn-primary" href="mailto:hello@algarvepropertycompliance.com?subject=APC%20Beta%20help%20%E2%80%94%20${encodeURIComponent(opts.stepLabel || 'Beta')}">Email APC support</a>
        <button class="btn btn-secondary close-help" type="button">Close</button>
      </div>
    `;
    document.body.appendChild(fab);
    const btn  = fab.querySelector(".help-fab-btn");
    const pnl  = fab.querySelector(".help-fab-panel");
    const close = fab.querySelector(".close-help");
    btn.onclick = () => {
      const open = !pnl.hidden;
      pnl.hidden = open;
      if (!open && window.APC_TRACK) window.APC_TRACK.event("help_opened");
    };
    close.onclick = () => { pnl.hidden = true; };
  }

  // ---------- Public API ----------
  window.APC_TRACK = {
    BUILD,
    getDeviceInfo,
    initClarity,
    event: (name, props) => clarityEvent(name, props),
    pingActivity,
    checkSessionTimeout,
    validateUploadFile,
    injectHelpButton,
    friction: {
      bumpBack:    () => { friction.back_clicks++; },
      bumpRetry:   () => { friction.upload_retries++; },
      bumpFailure: () => { friction.upload_failures++; },
      snapshot:    () => getFrictionSnapshot(),
      reset:       () => resetFriction()
    }
  };

  // Init Clarity (no-op while ID blank) on load
  initClarity();
})();
