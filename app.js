// APC Beta — main app
// Flow: 1 Welcome → 2 Confirm area → 3 Review generated property →
//       4 Compliance Q → 5 Document upload → 6 Compliance summary →
//       7 Feedback → 8 Complete
//
// NOTE: Column names match the live Supabase schema:
//   testers.auth_user_id (not user_id)
//   beta_applications has flat generated_* cols + JSONB add-ons
//   beta_feedback.{clarity_score, trust_score, ease_score, confusion_notes}
//   session_tracking.current_step + event_type/step_name/etc

(function () {
  const sb = window.supabaseClient;
  const cfg = window.APC_CONFIG;
  const TRACK = window.APC_TRACK;
  const STEPS = [
    "Welcome",
    "Confirm area",
    "Your property",
    "Compliance check",
    "Documents",
    "Summary",
    "Feedback",
    "Complete"
  ];

  // ---------- State ----------
  const state = {
    user: null,
    tester: null,
    application: null,
    step: 1,
    sessionStart: Date.now(),
    stepStart: Date.now()
  };

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const main = () => $("#apc-main");

  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    })[c]);
  }

  function renderHeader() {
    const right = $("#header-right");
    if (state.user) {
      right.innerHTML =
        `<span style="margin-right:10px">${escapeHTML(state.user.email)}</span>` +
        `<button class="logout" id="btn-logout">Sign out</button>`;
      $("#btn-logout").onclick = signOut;
    } else {
      right.innerHTML = `<span style="opacity:0.8">Beta · ${cfg.BETA_BUILD}</span>`;
    }
  }

  function renderSteps(n) {
    let pips = "";
    for (let i = 1; i <= STEPS.length; i++) {
      pips += `<div class="step-pip${i <= n ? " active" : ""}"></div>`;
    }
    const pct = Math.round((n / STEPS.length) * 100);
    return `
      <div class="step-label">Step ${n} of ${STEPS.length} · ${STEPS[n-1]} · ${pct}% complete</div>
      <div class="steps">${pips}</div>
    `;
  }

  // Returns the property as the app expects, derived from flat columns
  function appPropertyFromRow(a) {
    if (!a || !a.generated_property_town) return null;
    return {
      town: a.generated_property_town,
      address: a.generated_address,
      postcode: a.generated_postcode,
      property_type: a.generated_property_type,
      bedrooms: a.generated_bedrooms,
      capacity: a.generated_capacity,
      year_built: a.generated_year_built,
      nif: a.generated_nif,
      al_licence: a.generated_al_license,
      compliance_score: a.generated_risk_score,
      doc_flags: a.generated_document_flags || []
    };
  }

  function propertyToColumns(p) {
    return {
      generated_property_town: p.town,
      generated_address: p.address,
      generated_postcode: p.postcode,
      generated_property_type: p.property_type,
      generated_bedrooms: p.bedrooms,
      generated_capacity: p.capacity,
      generated_year_built: p.year_built,
      generated_nif: p.nif,
      generated_al_license: p.al_licence,
      generated_risk_score: p.compliance_score,
      generated_compliance_status: null,
      generated_document_flags: p.doc_flags
    };
  }

  async function logSessionEvent(eventType, extra = {}) {
    if (!state.tester) return;
    const friction = TRACK ? TRACK.friction.snapshot() : {};
    const merged = Object.assign({}, friction, extra);
    try {
      await sb.from("session_tracking").insert({
        tester_id: state.tester.id,
        application_id: state.application ? state.application.id : null,
        current_step: state.step,
        step_name: STEPS[state.step - 1],
        event_type: eventType,
        time_on_step_ms: Date.now() - state.stepStart,
        user_agent: navigator.userAgent,
        device_info: TRACK ? TRACK.getDeviceInfo() : {},
        extra: merged
      });
      if (TRACK) TRACK.event(eventType, merged);
    } catch (e) {
      console.warn("session log failed", e);
    }
  }

  function goStep(n) {
    if (n !== state.step) {
      // Bump back-click counter if moving backwards
      if (n < state.step && TRACK) TRACK.friction.bumpBack();
      logSessionEvent(n > state.step ? "step_completed" : "step_back");
      if (TRACK) TRACK.friction.reset();
      state.step = n;
      state.stepStart = Date.now();
      // Update tester's last_step
      if (state.tester) {
        sb.from("testers")
          .update({ last_step_completed: Math.max(state.tester.last_step_completed || 0, n - 1),
                    completion_percent: Math.round(((n - 1) / STEPS.length) * 100) })
          .eq("id", state.tester.id);
      }
    }
    renderStep();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function signOut() {
    await sb.auth.signOut();
    window.location.reload();
  }

  // ---------- Auth (6-digit code, with magic link as fallback) ----------
  function renderSigningInSpinner() {
    main().innerHTML = `
      <div class="card" style="text-align:center;padding:48px 24px;">
        <div style="font-size:28px;margin-bottom:8px;">🔑</div>
        <h1 style="margin:0 0 8px 0;">Signing you in…</h1>
        <p class="muted">One moment — we're checking your sign-in link.</p>
      </div>`;
  }

  async function renderSignIn() {
    main().innerHTML = `
      <div class="card">
        <h1>Welcome to APC Beta</h1>
        <p class="muted">
          You're helping us test how the Algarve Property Compliance application service feels for real Algarve property owners.
          No real documents, no real fees — this is a test environment.
        </p>
        <div class="alert alert-info">
          <strong>How sign-in works:</strong> enter your email, we'll send you a
          <strong>6-digit code</strong>. Type it in and you're in. No password, no link to chase.
        </div>

        <label for="email">Your email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email"
               placeholder="you@example.com" />

        <label for="name">Your name</label>
        <input id="name" type="text" autocomplete="name" placeholder="First and last name" />

        <button class="btn btn-primary" id="btn-send">Send me my 6-digit code</button>
        <div id="signin-msg"></div>

        <div id="otp-box" style="display:none;margin-top:18px;padding-top:18px;border-top:1px solid #E5E3DC;">
          <label for="otp">Paste the 6-digit code from your email</label>
          <input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code"
                 pattern="[0-9]{6}" maxlength="6"
                 placeholder="123456"
                 style="font-size:24px;letter-spacing:6px;text-align:center;font-family:monospace;" />
          <button class="btn btn-primary" id="btn-verify">Verify and sign in</button>
          <p class="muted" style="font-size:12px;margin-top:8px;">
            Can't find the code? Check spam, or tap the link in the same email — either works.
            Didn't get anything? <a href="#" id="btn-resend">Resend</a>.
          </p>
        </div>
      </div>
      <div class="card">
        <h2>What you'll do in the beta</h2>
        <ol>
          <li>Confirm which Algarve town your (test) property is in</li>
          <li>Review a fake property we'll generate for you</li>
          <li>Answer a few compliance questions</li>
          <li>Upload one or two test documents (PDF/JPG/PNG)</li>
          <li>See your compliance summary</li>
          <li>Give us feedback</li>
        </ol>
        <p class="muted">Takes about 5–7 minutes on a phone.</p>
      </div>
    `;
    let sentEmail = null;

    async function sendCode(emailArg) {
      const msg = $("#signin-msg");
      $("#btn-send").disabled = true;
      $("#btn-send").textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({
        email: emailArg,
        options: { emailRedirectTo: cfg.REDIRECT_URL, shouldCreateUser: true }
      });
      if (error) {
        msg.innerHTML = `<div class="alert alert-bad">${escapeHTML(error.message)}</div>`;
        $("#btn-send").disabled = false;
        $("#btn-send").textContent = "Send me my 6-digit code";
        return false;
      }
      sentEmail = emailArg;
      msg.innerHTML = `
        <div class="alert alert-ok">
          <strong>Sent.</strong> We've emailed a 6-digit code to <strong>${escapeHTML(emailArg)}</strong>.
          Paste it below.
        </div>`;
      $("#btn-send").textContent = "Code sent ✓ (resend)";
      $("#btn-send").disabled = false;
      $("#otp-box").style.display = "block";
      setTimeout(() => { try { $("#otp").focus(); } catch(e){} }, 100);
      return true;
    }

    $("#btn-send").onclick = async () => {
      const email = $("#email").value.trim().toLowerCase();
      const name  = $("#name").value.trim();
      const msg   = $("#signin-msg");
      if (!email || !email.includes("@")) {
        msg.innerHTML = `<div class="alert alert-bad">Please enter a valid email.</div>`;
        return;
      }
      if (!name || name.length < 2) {
        msg.innerHTML = `<div class="alert alert-bad">Please enter your name.</div>`;
        return;
      }
      try { localStorage.setItem("apc_pending_name", name); } catch (e) {}
      await sendCode(email);
    };

    $("#btn-verify").onclick = async () => {
      const token = $("#otp").value.trim();
      const msg = $("#signin-msg");
      if (!sentEmail) {
        msg.innerHTML = `<div class="alert alert-bad">Please send yourself a code first.</div>`;
        return;
      }
      if (!/^\d{6}$/.test(token)) {
        msg.innerHTML = `<div class="alert alert-bad">Enter the 6-digit code from the email.</div>`;
        return;
      }
      $("#btn-verify").disabled = true;
      $("#btn-verify").textContent = "Checking…";
      const { error } = await sb.auth.verifyOtp({ email: sentEmail, token, type: "email" });
      if (error) {
        msg.innerHTML = `<div class="alert alert-bad">${escapeHTML(error.message)}. Codes expire after 1 hour — send a new one if needed.</div>`;
        $("#btn-verify").disabled = false;
        $("#btn-verify").textContent = "Verify and sign in";
        return;
      }
      // onAuthStateChange in boot() will fire and route the user.
      renderSigningInSpinner();
    };

    $("#btn-resend").onclick = async (e) => {
      e.preventDefault();
      if (!sentEmail) return;
      await sendCode(sentEmail);
    };
  }

  // ---------- Tester upsert after sign-in ----------
  async function ensureTester() {
    if (!state.user) return null;
    let pendingName = "";
    try { pendingName = localStorage.getItem("apc_pending_name") || ""; } catch (e) {}

    const { data: existing, error: e1 } = await sb
      .from("testers").select("*").eq("auth_user_id", state.user.id).maybeSingle();
    if (e1) {
      throw new Error("testers SELECT failed: " + (e1.message || JSON.stringify(e1)));
    }

    if (existing) {
      state.tester = existing;
    } else {
      const { data: ins, error: e2 } = await sb.from("testers").insert({
        auth_user_id: state.user.id,
        email: state.user.email,
        full_name: pendingName || state.user.email.split("@")[0],
        onboarding_status: "started",
        completion_percent: 0,
        last_step_completed: 0
      }).select().single();
      if (e2) {
        throw new Error("testers INSERT failed: " + (e2.message || JSON.stringify(e2)));
      }
      state.tester = ins;
    }
    try { localStorage.removeItem("apc_pending_name"); } catch (e) {}
    return state.tester;
  }

  // v0.5.0 — list all applications for this tester (used by dashboard)
  async function loadApplications() {
    if (!state.tester) return [];
    const { data, error } = await sb
      .from("beta_applications")
      .select("*")
      .eq("tester_id", state.tester.id)
      .order("created_at", { ascending: true });
    if (error) throw new Error("beta_applications SELECT failed: " + (error.message || JSON.stringify(error)));
    state.applications = data || [];
    return state.applications;
  }

  // v0.5.0 — create a brand-new application row for an additional property
  async function createNewApplication(label) {
    const { data, error } = await sb.from("beta_applications").insert({
      tester_id: state.tester.id,
      status: "in_progress",
      application_progress: 0,
      property_label: label || null
    }).select().single();
    if (error) {
      if (error.message && error.message.indexOf("APC_PROPERTY_CAP") !== -1) {
        throw new Error("You've reached the 10-property limit on this account. Contact APC for portfolios over 10 properties.");
      }
      throw new Error("Could not create new property: " + error.message);
    }
    state.application = data;
    state.applications = (state.applications || []).concat([data]);
    return data;
  }

  async function loadOrCreateApplication() {
    if (!state.tester) return null;
    const { data: apps, error: e1 } = await sb
      .from("beta_applications")
      .select("*")
      .eq("tester_id", state.tester.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (e1) {
      throw new Error("beta_applications SELECT failed: " + (e1.message || JSON.stringify(e1)));
    }
    if (apps && apps.length) {
      state.application = apps[0];
    } else {
      const { data: ins, error: e2 } = await sb.from("beta_applications").insert({
        tester_id: state.tester.id,
        status: "in_progress",
        application_progress: 0
      }).select().single();
      if (e2) {
        throw new Error("beta_applications INSERT failed: " + (e2.message || JSON.stringify(e2)));
      }
      state.application = ins;
    }
    return state.application;
  }

  // ---------- Step renderer ----------
  function renderStep() {
    renderHeader();
    switch (state.step) {
      case 1: return renderWelcome();
      case 2: return renderConfirmArea();
      case 3: return renderReviewProperty();
      case 4: return renderComplianceQs();
      case 5: return renderUpload();
      case 6: return renderSummary();
      case 7: return renderFeedback();
      case 8: return renderComplete();
    }
  }

  // ============================================================
  // v0.5.0 — First-visit choice + Dashboard (multi-property)
  // Feature-flagged: only renders for whitelisted emails.
  // ============================================================

  function isMultiPropertyEnabled() {
    const email = (state.user && state.user.email) || "";
    return !!(window.APC_CONFIG && window.APC_CONFIG.hasFeature && window.APC_CONFIG.hasFeature("multi_property", email));
  }

  // First-visit: ask single vs multiple
  function renderPropertyModeChoice() {
    const name = state.tester && state.tester.full_name ? state.tester.full_name.split(" ")[0] : "there";
    main().innerHTML = `
      <div class="card">
        <h1>Welcome ${escapeHTML(name)} 👋</h1>
        <p class="muted">Before we start, tell us how many properties you'll be managing with APC. You can change this later.</p>

        <div class="choice-grid" style="display:grid;gap:12px;margin-top:18px;">
          <button class="choice-card" id="mode-single" style="text-align:left;padding:18px;border:2px solid var(--apc-border,#d9d9d9);border-radius:10px;background:#fff;cursor:pointer;">
            <div style="font-size:17px;font-weight:600;margin-bottom:4px;">Just one property</div>
            <div class="muted" style="font-size:14px;">A single villa, apartment or house. Quickest path — we'll take you straight through the 8-step flow.</div>
          </button>
          <button class="choice-card" id="mode-multiple" style="text-align:left;padding:18px;border:2px solid var(--apc-border,#d9d9d9);border-radius:10px;background:#fff;cursor:pointer;">
            <div style="font-size:17px;font-weight:600;margin-bottom:4px;">Multiple properties <span class="muted" style="font-weight:400;font-size:14px;">(up to 10)</span></div>
            <div class="muted" style="font-size:14px;">Portfolio owners, agencies, or anyone managing 2+ Algarve rentals. You'll get a dashboard to track each one.</div>
          </button>
        </div>

        <div class="alert alert-info" style="margin-top:18px;">
          <strong>Tip:</strong> with multiple properties, you only upload owner-level documents (passport, NIF, IBAN) once — they're reused across every property.
        </div>
      </div>
    `;
    $("#mode-single").onclick = async () => { await setPropertyMode("single"); };
    $("#mode-multiple").onclick = async () => { await setPropertyMode("multiple"); };
  }

  async function setPropertyMode(mode) {
    const { data, error } = await sb.from("testers")
      .update({ property_mode: mode })
      .eq("id", state.tester.id)
      .select().maybeSingle();
    if (error) { alert("Could not save choice: " + error.message); return; }
    state.tester = data || { ...state.tester, property_mode: mode };
    logSessionEvent("property_mode_chosen", { mode });
    if (mode === "single") {
      // Ensure single application exists, then jump to Step 1 (welcome)
      await loadOrCreateApplication();
      goStep(1);
    } else {
      // Multi-property — land on dashboard. No app auto-created.
      await loadApplications();
      renderDashboard();
    }
  }

  // Multi-property dashboard hub
  async function renderDashboard() {
    renderHeader();
    await loadApplications();
    const apps = state.applications || [];
    const count = apps.length;
    const cap = 10;
    const atCap = count >= cap;

    const owner = (state.tester && state.tester.owner_documents) || {};
    const ownerSlots = [
      { key: "passport_id", label: "Passport / Government ID" },
      { key: "nif",         label: "NIF — Portuguese Fiscal Number" },
      { key: "iban_bank",   label: "IBAN / Bank Proof" },
      { key: "fiscal_rep",  label: "Fiscal Representative Appointment" }
    ];
    const ownerFilled = ownerSlots.filter(s => owner[s.key] && owner[s.key].status === "uploaded").length;

    const cards = apps.length ? apps.map((a, i) => {
      const label = a.property_label || a.generated_property_town || `Property ${i+1}`;
      const town = a.generated_property_town ? ` · ${escapeHTML(a.generated_property_town)}` : "";
      const upl = a.uploaded_docs_count || 0;
      const pen = a.pending_docs_count || 0;
      const mis = a.missing_docs_count || 0;
      const pill = a.status === "completed"
        ? `<span class="status-pill status-good">✅ Complete</span>`
        : (a.provisional_compliance === false
            ? `<span class="status-pill status-good">✅ Compliant</span>`
            : `<span class="status-pill status-warn">🟡 Provisional</span>`);
      return `
        <div class="property-card" data-app-id="${a.id}" style="border:1px solid var(--apc-border,#d9d9d9);border-radius:10px;padding:16px;margin-bottom:12px;cursor:pointer;background:#fff;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
            <div>
              <div style="font-size:16px;font-weight:600;">${escapeHTML(label)}${town}</div>
              <div class="muted" style="font-size:13px;margin-top:4px;">Docs: ${upl} uploaded · ${pen} pending · ${mis} APC follow-up</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              ${pill}
              <button class="btn btn-secondary btn-continue" data-app-id="${a.id}">Continue →</button>
            </div>
          </div>
        </div>
      `;
    }).join("") : `
      <div class="alert alert-info">
        No properties yet. Add your first one to get started.
      </div>
    `;

    main().innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div>
            <h1 style="margin-bottom:4px;">Your properties</h1>
            <p class="muted">${count} of ${cap} properties · portfolio dashboard</p>
          </div>
          <button class="btn btn-primary" id="btn-add-property"${atCap ? " disabled title='Contact APC for portfolios over 10 properties'" : ""}>+ Add ${count ? "another" : "your first"} property</button>
        </div>

        ${atCap ? `<div class="alert alert-warn" style="margin-top:12px;"><strong>Portfolio cap reached.</strong> You've added the maximum 10 properties. Contact <a href="mailto:hello@algarvepropertycompliance.com">hello@algarvepropertycompliance.com</a> for larger portfolios.</div>` : ""}

        <div style="margin-top:18px;">${cards}</div>

        <div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--apc-border,#e5e5e5);">
          <h3 style="margin-bottom:6px;">Owner documents</h3>
          <p class="muted" style="font-size:14px;margin-bottom:10px;">Uploaded once · shared across all your properties</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;">
            ${ownerSlots.map(s => {
              const st = (owner[s.key] && owner[s.key].status) || null;
              const icon = st === "uploaded" ? "✅" : (st === "missing" ? "❌" : "—");
              return `<div style="font-size:14px;">${icon} ${escapeHTML(s.label)}</div>`;
            }).join("")}
          </div>
          <p class="muted" style="font-size:13px;margin-top:10px;">${ownerFilled}/${ownerSlots.length} owner docs uploaded. <em>Owner-doc management coming in v0.5.1.</em></p>
        </div>
      </div>
    `;

    // wire up events
    const addBtn = $("#btn-add-property");
    if (addBtn && !atCap) {
      addBtn.onclick = async () => {
        try {
          const label = window.prompt("Give this property a short label (e.g. 'Carvoeiro villa'):", `Property ${count+1}`);
          if (label === null) return;
          await createNewApplication(label.trim() || `Property ${count+1}`);
          logSessionEvent("property_added", { count_after: count + 1 });
          goStep(1);
        } catch (err) {
          alert(err.message);
        }
      };
    }
    document.querySelectorAll(".btn-continue, .property-card").forEach(el => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const id = el.getAttribute("data-app-id") || el.closest(".property-card").getAttribute("data-app-id");
        const app = apps.find(a => a.id === id);
        if (!app) return;
        state.application = app;
        // resume at correct step (mirror boot() logic)
        let step = 1;
        if (app.status === "completed") step = 8;
        else if (app.feedback_data && Object.keys(app.feedback_data).length) step = 7;
        else if (app.compliance_answers && Object.keys(app.compliance_answers).length) step = 5;
        else if (app.generated_property_town) step = 3;
        else if (state.tester.algarve_area) step = 2;
        goStep(step);
      };
    });
  }

  // STEP 1
  function renderWelcome() {
    const name = state.tester && state.tester.full_name ? state.tester.full_name.split(" ")[0] : "there";
    main().innerHTML = `
      <div class="card">
        ${renderSteps(1)}
        <h1>Hello ${escapeHTML(name)} 👋</h1>
        <p>Thanks for helping test the APC application flow.</p>
        <p class="muted">
          In the next 8 steps we'll walk through how a real Algarve property
          owner would apply for compliance support. Everything you see is
          test data — no real filings will be made.
        </p>
        <div class="alert alert-info">
          You can stop at any step and come back later. Your progress is saved.
        </div>
        <button class="btn btn-primary" id="btn-next">Start</button>
      </div>
    `;
    $("#btn-next").onclick = () => goStep(2);
  }

  // STEP 2
  function renderConfirmArea() {
    const towns = window.APC_FAKE.TOWNS;
    const current = state.tester.algarve_area || "";
    main().innerHTML = `
      <div class="card">
        ${renderSteps(2)}
        <h2>Where's your property?</h2>
        <p class="muted">Pick the Algarve town closest to your property. We'll use this to generate a realistic test address for you.</p>

        <label for="town">Town</label>
        <select id="town">
          <option value="">— Choose a town —</option>
          ${towns.map(t => `<option value="${t}"${current===t?" selected":""}>${t}</option>`).join("")}
        </select>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Continue</button>
        </div>
      </div>
    `;
    $("#btn-back").onclick = () => goStep(1);
    $("#btn-next").onclick = async () => {
      const t = $("#town").value;
      if (!t) { alert("Please choose a town."); return; }

      // Save town on the tester (v0.4.4: maybeSingle, merge locally on null)
      const { data: tu, error: tuErr } = await sb.from("testers")
        .update({ algarve_area: t })
        .eq("id", state.tester.id).select().maybeSingle();
      if (tuErr) { alert("Could not save town: " + tuErr.message); return; }
      state.tester = tu || { ...state.tester, algarve_area: t };

      // Generate fake property anchored to chosen town if not yet or town changed
      let prop = appPropertyFromRow(state.application);
      if (!prop || prop.town !== t) {
        prop = window.APC_FAKE.generate(t);
        const cols = propertyToColumns(prop);
        const { data: au, error: auErr } = await sb.from("beta_applications")
          .update(cols)
          .eq("id", state.application.id).select().maybeSingle();
        if (auErr) { alert("Could not save property: " + auErr.message); return; }
        state.application = au || { ...state.application, ...cols };
      }
      goStep(3);
    };
  }

  // STEP 3
  // Capacity-band → compliance path classifier (Art. 13 DL128/2014, DL76/2024)
  const CAPACITY_BANDS = [
    { id: "1_4",     label: "1–4 guests",   sub: "Small villa or apartment",        path: "standard_AL", scie: false },
    { id: "5_10",    label: "5–10 guests",  sub: "Mid-size property — most common", path: "standard_AL", scie: false },
    { id: "11_plus", label: "11+ guests",   sub: "Larger property or hostel",       path: "SCIE_review", scie: true  }
  ];
  function bandForCapacity(cap) {
    if (cap == null) return null;
    if (cap <= 4)  return "1_4";
    if (cap <= 10) return "5_10";
    return "11_plus";
  }

  function renderReviewProperty() {
    const p = appPropertyFromRow(state.application);
    const app = state.application;
    const selectedBand = app.guest_capacity_band || bandForCapacity(p.capacity);
    const scie = (app.scie_details && typeof app.scie_details === "object") ? app.scie_details : {};

    main().innerHTML = `
      <div class="card">
        ${renderSteps(3)}
        <h2>Your (test) property</h2>
        <p class="muted">This is the fake property we've generated for your test. In a real application, you'd enter your own details here.</p>

        <div class="prop-row"><div class="prop-key">Town</div><div class="prop-val">${escapeHTML(p.town)}</div></div>
        <div class="prop-row"><div class="prop-key">Address</div><div class="prop-val">${escapeHTML(p.address)}</div></div>
        <div class="prop-row"><div class="prop-key">Postcode</div><div class="prop-val">${escapeHTML(p.postcode)}</div></div>
        <div class="prop-row"><div class="prop-key">Property type</div><div class="prop-val">${escapeHTML(p.property_type)}</div></div>
        <div class="prop-row"><div class="prop-key">Bedrooms</div><div class="prop-val">${p.bedrooms}</div></div>
        <div class="prop-row"><div class="prop-key">Max guests (suggested)</div><div class="prop-val">${p.capacity}</div></div>
        <div class="prop-row"><div class="prop-key">Year built</div><div class="prop-val">${p.year_built}</div></div>
        <div class="prop-row"><div class="prop-key">Owner NIF</div><div class="prop-val">${escapeHTML(p.nif)}</div></div>
        <div class="prop-row"><div class="prop-key">AL licence</div><div class="prop-val">${escapeHTML(p.al_licence)}</div></div>

        <div class="cap-gate">
          <h3 class="cap-gate-title">How many guests will the property accommodate?</h3>
          <p class="muted cap-gate-help">This determines which compliance rules apply.</p>
          <div class="cap-card-grid" id="cap-card-grid">
            ${CAPACITY_BANDS.map(b => `
              <button type="button"
                      class="cap-card${selectedBand===b.id?" selected":""}${b.scie?" cap-card-scie":""}"
                      data-band="${b.id}"
                      aria-pressed="${selectedBand===b.id}">
                <div class="cap-card-label">${b.label}</div>
                <div class="cap-card-sub">${b.sub}</div>
                ${b.scie ? '<div class="cap-card-badge">Enhanced review</div>' : ''}
              </button>
            `).join("")}
          </div>

          <div id="cap-helper-standard" class="cap-helper cap-helper-ok" style="display:${selectedBand && selectedBand!=="11_plus"?"block":"none"}">
            <strong>Standard Alojamento Local path.</strong>
            Under Article 13(2) of Decreto-Lei 128/2014, properties up to 10 guests need: 1× extinguisher, 1× fire blanket, first-aid kit, visible 112 emergency information.
          </div>

          <div id="cap-helper-scie" class="cap-helper cap-helper-scie" style="display:${selectedBand==="11_plus"?"block":"none"}">
            <div class="cap-helper-title">Larger property — enhanced compliance review</div>
            <p>Properties accommodating more than 10 guests may require enhanced fire safety compliance review under Portuguese SCIE regulations (DL 220/2008 + Portaria 1532/2008).</p>
            <p class="muted">A few extra details below help us prepare the right review and supplier quotes.</p>
          </div>

          <div id="scie-fields" class="scie-fields" style="display:${selectedBand==="11_plus"?"block":"none"}">
            <h4 class="scie-fields-title">Property details for SCIE review</h4>
            <div class="scie-grid">
              <label class="scie-field">Total floor area (m²)
                <input type="number" min="0" id="scie-area" value="${scie.floor_area_sqm ?? ""}" placeholder="e.g. 220">
              </label>
              <label class="scie-field">Number of floors
                <input type="number" min="1" id="scie-floors" value="${scie.floors ?? ""}" placeholder="e.g. 2">
              </label>
              <label class="scie-field">Existing extinguisher count
                <input type="number" min="0" id="scie-extcount" value="${scie.existing_extinguisher_count ?? ""}" placeholder="e.g. 3">
              </label>
              <label class="scie-field">Existing fire alarm system
                <select id="scie-alarm">
                  <option value="">— Select —</option>
                  <option value="yes"      ${scie.existing_alarm==="yes"?"selected":""}>Yes</option>
                  <option value="partial"  ${scie.existing_alarm==="partial"?"selected":""}>Partial / unsure</option>
                  <option value="no"       ${scie.existing_alarm==="no"?"selected":""}>No</option>
                </select>
              </label>
              <label class="scie-field">Emergency lighting present
                <select id="scie-lighting">
                  <option value="">— Select —</option>
                  <option value="yes" ${scie.emergency_lighting==="yes"?"selected":""}>Yes</option>
                  <option value="no"  ${scie.emergency_lighting==="no"?"selected":""}>No</option>
                </select>
              </label>
              <label class="scie-field">Existing evacuation plan
                <select id="scie-evac">
                  <option value="">— Select —</option>
                  <option value="yes" ${scie.evacuation_plan==="yes"?"selected":""}>Yes</option>
                  <option value="no"  ${scie.evacuation_plan==="no"?"selected":""}>No</option>
                </select>
              </label>
              <label class="scie-field">Existing safety signage
                <select id="scie-signage">
                  <option value="">— Select —</option>
                  <option value="yes"     ${scie.existing_signage==="yes"?"selected":""}>Yes</option>
                  <option value="partial" ${scie.existing_signage==="partial"?"selected":""}>Partial</option>
                  <option value="no"      ${scie.existing_signage==="no"?"selected":""}>No</option>
                </select>
              </label>
              <label class="scie-field">Maintenance certificates in date
                <select id="scie-certs">
                  <option value="">— Select —</option>
                  <option value="yes"     ${scie.maintenance_certs==="yes"?"selected":""}>Yes</option>
                  <option value="expired" ${scie.maintenance_certs==="expired"?"selected":""}>Expired</option>
                  <option value="no"      ${scie.maintenance_certs==="no"?"selected":""}>No / unsure</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-secondary" id="btn-regen">Generate a new one</button>
        </div>
        <button class="btn btn-primary" id="btn-next" ${selectedBand?"":"disabled"}>Looks good — continue</button>
      </div>
    `;

    let currentBand = selectedBand;

    function applyBand(bandId) {
      currentBand = bandId;
      document.querySelectorAll("#cap-card-grid .cap-card").forEach(el => {
        const on = el.getAttribute("data-band") === bandId;
        el.classList.toggle("selected", on);
        el.setAttribute("aria-pressed", on ? "true" : "false");
      });
      const isScie = bandId === "11_plus";
      const hStd  = document.getElementById("cap-helper-standard");
      const hScie = document.getElementById("cap-helper-scie");
      const fScie = document.getElementById("scie-fields");
      if (hStd)  hStd.style.display  = (bandId && !isScie) ? "block" : "none";
      if (hScie) hScie.style.display = isScie ? "block" : "none";
      if (fScie) fScie.style.display = isScie ? "block" : "none";
      const next = document.getElementById("btn-next");
      if (next) next.disabled = !bandId;
      try { TRACK && TRACK.event && TRACK.event("capacity_band_selected", { band: bandId, scie: isScie }); } catch(_) {}
    }

    document.querySelectorAll("#cap-card-grid .cap-card").forEach(el => {
      el.onclick = () => applyBand(el.getAttribute("data-band"));
    });

    $("#btn-back").onclick = () => goStep(2);
    $("#btn-regen").onclick = async () => {
      const newProp = window.APC_FAKE.generate(state.tester.algarve_area);
      const cols = propertyToColumns(newProp);
      const { data, error } = await sb.from("beta_applications")
        .update(cols)
        .eq("id", state.application.id).select().maybeSingle();
      if (error) { alert("Could not regenerate property: " + error.message); return; }
      state.application = data || { ...state.application, ...cols };
      renderReviewProperty();
    };
    $("#btn-next").onclick = async () => {
      if (!currentBand) { alert("Please choose a capacity band before continuing."); return; }
      const bandDef = CAPACITY_BANDS.find(b => b.id === currentBand);
      const scieDetails = currentBand === "11_plus" ? {
        floor_area_sqm:               numOrNull($("#scie-area").value),
        floors:                       numOrNull($("#scie-floors").value),
        existing_extinguisher_count:  numOrNull($("#scie-extcount").value),
        existing_alarm:               $("#scie-alarm").value || null,
        emergency_lighting:           $("#scie-lighting").value || null,
        evacuation_plan:              $("#scie-evac").value || null,
        existing_signage:             $("#scie-signage").value || null,
        maintenance_certs:            $("#scie-certs").value || null,
        captured_at:                  new Date().toISOString()
      } : {};
      const update = {
        guest_capacity_band:     currentBand,
        compliance_path:         bandDef.path,
        manual_review_required:  bandDef.scie,
        scie_flag:               bandDef.scie,
        scie_details:            scieDetails
      };
      // v0.4.4 — don't rely on .single() returning a row (RLS read can race the write).
      // Just commit and merge locally; the write is what matters.
      const { error } = await sb.from("beta_applications")
        .update(update).eq("id", state.application.id);
      if (error) { alert("Could not save capacity classification: " + error.message); return; }
      state.application = { ...state.application, ...update };
      goStep(4);
    };
  }

  function numOrNull(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // STEP 4
  function renderComplianceQs() {
    const a = state.application.compliance_answers || {};
    main().innerHTML = `
      <div class="card">
        ${renderSteps(4)}
        <h2>A few quick questions</h2>
        <p class="muted">Answer as if this were your real property.</p>

        <label>Is the property already registered for Alojamento Local (AL)?</label>
        <select id="q-al">
          <option value="">— Select —</option>
          <option value="yes" ${a.al_registered==="yes"?"selected":""}>Yes</option>
          <option value="no" ${a.al_registered==="no"?"selected":""}>No</option>
          <option value="not_sure" ${a.al_registered==="not_sure"?"selected":""}>Not sure</option>
        </select>

        <label>Do you have a working smoke detector & fire extinguisher?</label>
        <select id="q-safety">
          <option value="">— Select —</option>
          <option value="yes" ${a.safety==="yes"?"selected":""}>Yes, both</option>
          <option value="partial" ${a.safety==="partial"?"selected":""}>One but not the other</option>
          <option value="no" ${a.safety==="no"?"selected":""}>No</option>
          <option value="need_help" ${a.safety==="need_help"?"selected":""}>No — I need someone to carry out the work</option>
        </select>
        <div id="safety-help-msg" class="helper-note" style="display:${a.safety==="need_help"?"block":"none"};margin-top:-6px;margin-bottom:14px;padding:10px 12px;background:#eef4ff;border-left:3px solid #2456c9;border-radius:4px;font-size:13px;color:#1d2a45">We can help connect you with a trusted local compliance professional after your application is submitted.</div>

        <label>Is the Licença de Utilização (habitation licence) for tourist use?</label>
        <select id="q-licenca">
          <option value="">— Select —</option>
          <option value="yes" ${a.licenca==="yes"?"selected":""}>Yes</option>
          <option value="no" ${a.licenca==="no"?"selected":""}>No</option>
          <option value="not_sure" ${a.licenca==="not_sure"?"selected":""}>Not sure</option>
        </select>

        <label>Do you have a fiscal representative in Portugal (if non-resident)?</label>
        <select id="q-fiscal">
          <option value="">— Select —</option>
          <option value="yes" ${a.fiscal==="yes"?"selected":""}>Yes</option>
          <option value="no" ${a.fiscal==="no"?"selected":""}>No</option>
          <option value="resident" ${a.fiscal==="resident"?"selected":""}>I'm a Portuguese resident</option>
        </select>

        <label>Anything else we should know? (optional)</label>
        <textarea id="q-notes" placeholder="Optional notes">${escapeHTML(a.notes || "")}</textarea>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Continue</button>
        </div>
      </div>
    `;
    $("#btn-back").onclick = () => goStep(3);
    // Toggle helper note when user picks the "need help" option on fire safety
    $("#q-safety").addEventListener("change", (e) => {
      const note = document.getElementById("safety-help-msg");
      if (note) note.style.display = (e.target.value === "need_help") ? "block" : "none";
    });
    $("#btn-next").onclick = async () => {
      const ans = {
        al_registered: $("#q-al").value,
        safety:        $("#q-safety").value,
        licenca:       $("#q-licenca").value,
        fiscal:        $("#q-fiscal").value,
        notes:         $("#q-notes").value.trim(),
        // Lightweight flag for downstream visibility — captured at the answer level.
        // service_category is set to "fire_safety" when the safety dropdown asks for help.
        service_help_requested: $("#q-safety").value === "need_help",
        service_help_categories: $("#q-safety").value === "need_help" ? ["fire_safety"] : []
      };
      if (!ans.al_registered || !ans.safety || !ans.licenca || !ans.fiscal) {
        alert("Please answer all four questions before continuing.");
        return;
      }
      const { data, error } = await sb.from("beta_applications")
        .update({ compliance_answers: ans })
        .eq("id", state.application.id).select().maybeSingle();
      if (error) { alert("Could not save answers: " + error.message); return; }
      state.application = data || { ...state.application, compliance_answers: ans };
      if (ans.service_help_requested) {
        logSessionEvent("service_help_requested", { source: "step4_safety", category: "fire_safety", application_id: state.application.id, property_id: state.application.property_id || null });
      }
      goStep(5);
    };
  }

  // STEP 5 — Document Status Workflow (v0.4.2)
  // Each slot has 3 possible states: uploaded | pending | missing
  // v0.4.3 — Full DL 76/2024 + Welcome Pack compliance doc set
  const DOC_SLOTS = [
    // ── Identity & Fiscal ──
    { section: "Identity & Fiscal",          slot: "passport_id",          title: "Passport / Government ID",            helper: "Photo or scan of passport or government-issued ID." },
    { section: "Identity & Fiscal",          slot: "nif",                  title: "NIF — Portuguese Fiscal Number",      helper: "Cartão de Contribuinte or Finanças NIF document." },
    { section: "Identity & Fiscal",          slot: "iban_bank",            title: "IBAN / Bank Proof",                   helper: "Bank statement or IBAN confirmation for tourist tax remittance and fees." },
    { section: "Identity & Fiscal",          slot: "fiscal_rep",           title: "Fiscal Representative Appointment",   helper: "Required if owner is non-EU resident. Mark 'don't have it' if EU resident." },

    // ── Property & Title ──
    { section: "Property & Title",            slot: "property_ownership",   title: "Property Ownership Deed (Escritura)", helper: "Escritura, land registry extract (Certidão Predial) or ownership deed." },
    { section: "Property & Title",            slot: "caderneta_predial",    title: "Caderneta Predial Urbana",            helper: "Tax record extract from Finanças (separate from the deed)." },
    { section: "Property & Title",            slot: "licenca_utilizacao",   title: "Licença de Utilização",               helper: "Use Licence issued by the local Câmara Municipal." },
    { section: "Property & Title",            slot: "floor_plan",           title: "Floor Plan / Property Layout",        helper: "Approved floor plan or architectural layout document." },

    // ── AL Operations & Safety ──
    { section: "AL Operations & Safety",      slot: "al_licence",           title: "Existing AL Licence (RNAL)",          helper: "Your current Alojamento Local licence / RNAL registration." },
    { section: "AL Operations & Safety",      slot: "inicio_atividade",     title: "Início de Atividade (CAE 55204)",     helper: "Finanças business-start declaration for AL activity." },
    { section: "AL Operations & Safety",      slot: "energy_certificate",   title: "Energy Certificate (DGEG)",           helper: "Certificado Energético — required for AL listings." },
    { section: "AL Operations & Safety",      slot: "gas_safety",           title: "Gas Safety Certificate",              helper: "Certificado de Inspeção de Gás. Mark 'don't have it' if property has no gas supply." },
    { section: "AL Operations & Safety",      slot: "electrical_safety",    title: "Electrical Safety Certificate",       helper: "Certificado de Instalação Elétrica (CIE)." },
    { section: "AL Operations & Safety",      slot: "fire_safety",          title: "Fire Safety Documentation",           helper: "Extinguisher, smoke detector, and fire safety inspection records." },
    { section: "AL Operations & Safety",      slot: "insurance",            title: "Property & Public Liability Insurance", helper: "Public liability and property insurance covering AL activity." },
    { section: "AL Operations & Safety",      slot: "livro_reclamacoes",    title: "Livro de Reclamações Registration",   helper: "Complaints Book registration (physical or electronic)." },
  ];
  const ADDITIONAL_SLOT = "additional";

  const MISSING_REASONS = [
    { code: "previous_owner",        label: "Previous owner has it" },
    { code: "professional",          label: "Accountant / lawyer has it" },
    { code: "request_council",       label: "Need to request from council" },
    { code: "never_issued",          label: "Never received one" },
    { code: "unsure_exists",         label: "Not sure if it exists" },
    { code: "will_upload",           label: "Will upload later" },
    { code: "service_help_requested", label: "I need someone to carry out the work" },
    { code: "other",                 label: "Other" },
  ];

  async function renderUpload() {
    // ---------- read current state ----------
    const items = state.application.uploaded_documents || [];
    const bySlot = {};
    items.forEach(it => {
      const key = it.slot || "_legacy";
      (bySlot[key] = bySlot[key] || []).push(it);
    });
    const statusMap = state.application.doc_status_records || {};

    // Derive per-slot status: uploaded (file present) wins, else read explicit status
    const slotState = (slotKey) => {
      const rec = statusMap[slotKey] || {};
      const hasFile = (bySlot[slotKey] || []).length > 0;
      if (hasFile) return { status: "uploaded", rec, file: bySlot[slotKey][0] };
      if (rec.status === "pending" || rec.status === "missing") return { status: rec.status, rec, file: null };
      return { status: "unchosen", rec, file: null };
    };

    // Counters
    const counters = { uploaded: 0, pending: 0, missing: 0, unchosen: 0 };
    DOC_SLOTS.forEach(d => { counters[slotState(d.slot).status]++; });

    const sections = {};
    DOC_SLOTS.forEach(d => { (sections[d.section] = sections[d.section] || []).push(d); });

    // ---------- card HTML ----------
    const slotCardHTML = (d) => {
      const s = slotState(d.slot);
      const reasonRec = s.rec || {};
      const cls =
        s.status === "uploaded" ? " doc-card-done" :
        s.status === "pending"  ? " doc-card-pending" :
        s.status === "missing"  ? " doc-card-missing" : "";
      const badge =
        s.status === "uploaded" ? `<span class="doc-badge doc-badge-uploaded">✅ Uploaded</span>` :
        s.status === "pending"  ? `<span class="doc-badge doc-badge-pending">⏳ Pending upload</span>` :
        s.status === "missing"  ? `<span class="doc-badge doc-badge-missing">📩 APC follow-up</span>` :
                                  `<span class="doc-badge doc-badge-required">REQUIRED</span>`;

      // Body varies per state
      let body = "";
      if (s.status === "uploaded") {
        const u = s.file;
        body = `
          <div class="doc-card-status">
            <div class="doc-uploaded-row">
              <span class="doc-tick">✅ Uploaded</span>
              <span class="doc-filename">${escapeHTML(u.name)}</span>
            </div>
            <div class="doc-uploaded-meta muted">${new Date(u.uploaded_at).toLocaleString()} · ${(u.size/1024).toFixed(0)} KB</div>
            <div class="doc-actions">
              <button type="button" class="btn btn-secondary btn-sm doc-replace" data-slot="${d.slot}">Replace</button>
              <button type="button" class="btn btn-link btn-sm doc-remove" data-slot="${d.slot}">Remove</button>
            </div>
          </div>`;
      } else if (s.status === "pending") {
        body = `
          <div class="doc-state-block doc-state-pending">
            <div class="doc-state-msg"><strong>We'll remind you to upload this later.</strong> No rush — keep moving and add it when you have it to hand.</div>
            <div class="doc-actions">
              <button type="button" class="btn btn-secondary btn-sm doc-action-upload" data-slot="${d.slot}">Upload now</button>
              <button type="button" class="btn btn-link btn-sm doc-action-clear" data-slot="${d.slot}">Change answer</button>
            </div>
          </div>`;
      } else if (s.status === "missing") {
        const reasonLabel = (MISSING_REASONS.find(r => r.code === reasonRec.reason_code) || {}).label || "Reason not given";
        const showOther = reasonRec.reason_code === "other" && reasonRec.reason_text;
        body = `
          <div class="doc-state-block doc-state-missing">
            <div class="doc-state-msg"><strong>APC will follow up.</strong> We'll help you obtain or replace this document. Reason: <em>${escapeHTML(reasonLabel)}</em>${showOther ? ` — “${escapeHTML(reasonRec.reason_text)}”` : ""}</div>
            <div class="doc-actions">
              <button type="button" class="btn btn-secondary btn-sm doc-action-upload" data-slot="${d.slot}">Upload now</button>
              <button type="button" class="btn btn-link btn-sm doc-action-clear" data-slot="${d.slot}">Change answer</button>
            </div>
          </div>`;
      } else {
        // unchosen — show 3 options
        body = `
          <div class="doc-choice-row">
            <button type="button" class="doc-choice doc-choice-upload" data-slot="${d.slot}" data-action="upload">
              <span class="doc-choice-icon">⬆︎</span><span class="doc-choice-label">Upload now</span>
            </button>
            <button type="button" class="doc-choice doc-choice-missing" data-slot="${d.slot}" data-action="missing">
              <span class="doc-choice-icon">✕</span><span class="doc-choice-label">I don't have it</span>
            </button>
            <button type="button" class="doc-choice doc-choice-pending" data-slot="${d.slot}" data-action="pending">
              <span class="doc-choice-icon">⏰</span><span class="doc-choice-label">Have it, not here now</span>
            </button>
          </div>
          <input type="file" id="file-${d.slot}" class="doc-file-input hidden" data-slot="${d.slot}" accept=".pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf" />
          <div class="doc-reason-panel hidden" id="reason-${d.slot}">
            <label for="reason-select-${d.slot}">Why don't you have this document?</label>
            <select id="reason-select-${d.slot}" class="doc-reason-select" data-slot="${d.slot}">
              <option value="">— Select a reason —</option>
              ${MISSING_REASONS.map(r => `<option value="${r.code}">${escapeHTML(r.label)}</option>`).join("")}
            </select>
            <input type="text" id="reason-other-${d.slot}" class="doc-reason-other hidden" maxlength="160" placeholder="Please tell us a bit more…" />
            <div class="doc-reason-help hidden" id="reason-help-${d.slot}" style="margin-top:8px;padding:10px 12px;background:#eef4ff;border-left:3px solid #2456c9;border-radius:4px;font-size:13px;color:#1d2a45">We can help connect you with a trusted local compliance professional after your application is submitted.</div>
            <div class="doc-actions">
              <button type="button" class="btn btn-primary btn-sm doc-reason-confirm" data-slot="${d.slot}">Confirm</button>
              <button type="button" class="btn btn-link btn-sm doc-reason-cancel" data-slot="${d.slot}">Cancel</button>
            </div>
          </div>`;
      }

      return `
        <div class="doc-card${cls}" data-slot="${d.slot}">
          <div class="doc-card-head">
            <div class="doc-card-title">${escapeHTML(d.title)}</div>
            ${badge}
          </div>
          <div class="doc-card-helper">${escapeHTML(d.helper)}</div>
          <div class="doc-card-types muted">Accepts: PDF, JPG or PNG · up to 10 MB</div>
          ${body}
          <div class="doc-card-msg" id="msg-${d.slot}"></div>
        </div>`;
    };

    const additionalItems = (bySlot[ADDITIONAL_SLOT] || []);
    const additionalListHTML = additionalItems.map((u, idx) => `
      <li class="doc-additional-item">
        <div class="doc-additional-head">
          <span class="doc-tick">✅</span>
          <strong>${escapeHTML(u.label || 'Additional document')}</strong>
        </div>
        ${u.description ? `<div class="muted">${escapeHTML(u.description)}</div>` : ''}
        <div class="muted">${escapeHTML(u.name)} · ${(u.size/1024).toFixed(0)} KB · ${new Date(u.uploaded_at).toLocaleString()}</div>
        <button type="button" class="btn btn-link btn-sm doc-remove-additional" data-idx="${idx}">Remove</button>
      </li>
    `).join('');

    // ---------- provisional summary block ----------
    const total = DOC_SLOTS.length;
    const provisional = (counters.pending + counters.missing + counters.unchosen) > 0;
    const summaryHTML = `
      <div class="doc-summary ${provisional ? "doc-summary-provisional" : "doc-summary-complete"}">
        <div class="doc-summary-head">
          <span class="doc-summary-pill">${provisional ? "🟡 Provisional" : "🟢 Complete"}</span>
          <span class="doc-summary-text">${provisional
            ? "Some documents are still missing or pending review — APC will help you complete these."
            : "All required documents have been provided."}</span>
        </div>
        <div class="doc-summary-tiles">
          <div class="doc-tile doc-tile-uploaded"><div class="doc-tile-num">${counters.uploaded}</div><div class="doc-tile-lbl">Uploaded</div></div>
          <div class="doc-tile doc-tile-pending"><div class="doc-tile-num">${counters.pending}</div><div class="doc-tile-lbl">Pending upload</div></div>
          <div class="doc-tile doc-tile-missing"><div class="doc-tile-num">${counters.missing}</div><div class="doc-tile-lbl">APC follow-up</div></div>
          <div class="doc-tile doc-tile-unchosen"><div class="doc-tile-num">${counters.unchosen}</div><div class="doc-tile-lbl">Not answered</div></div>
        </div>
      </div>`;

    let html = `
      <div class="card">
        ${renderSteps(5)}
        <h2>Required Documents</h2>
        <p class="muted">For each document, tell us if you have it. If you don't, that's fine — APC will help you obtain it. We just need a clear picture.</p>

        ${summaryHTML}

        <details class="doc-why">
          <summary>Why we ask for documents</summary>
          <p class="muted">These documents help us assess which compliance requirements apply to your property and produce an accurate compliance picture. We never share them outside the APC team.</p>
        </details>
    `;

    Object.keys(sections).forEach(secName => {
      html += `<h3 class="doc-section-title">${escapeHTML(secName)}</h3>`;
      html += `<div class="doc-section-grid">${sections[secName].map(slotCardHTML).join('')}</div>`;
    });

    html += `
        <h3 class="doc-section-title">Additional Documents</h3>
        <div class="doc-card doc-card-additional">
          <div class="doc-card-helper">Got another supporting document? Label it first, then upload. Examples: PAT Certificate, Alarm Service Record, Inspection Photos.</div>
          <label for="add-label">Document label <span class="req">*</span></label>
          <input type="text" id="add-label" maxlength="80" placeholder="e.g. PAT Certificate" />
          <label for="add-desc">Short description (optional)</label>
          <input type="text" id="add-desc" maxlength="160" placeholder="e.g. Tested 2025-09-14" />
          <label class="btn btn-secondary doc-upload-btn disabled" id="add-upload-label" for="add-file">Choose file</label>
          <input type="file" id="add-file" class="doc-file-input" disabled accept=".pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf" />
          <div class="doc-card-types muted">Accepts: PDF, JPG or PNG · up to 10 MB</div>
          <div class="doc-card-msg" id="msg-additional"></div>
          ${additionalItems.length ? `<ul class="doc-additional-list">${additionalListHTML}</ul>` : ''}
        </div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Continue</button>
        </div>
        <p class="muted" style="text-align:center;margin-top:10px">You can answer all seven items now — upload, mark missing, or come back later. APC will pick up the rest.</p>
      </div>
    `;

    main().innerHTML = html;

    // ---------- doc-status persistence ----------
    async function persistStatus(slot, patch) {
      const current = state.application.doc_status_records || {};
      const next = { ...current, [slot]: { ...(current[slot]||{}), ...patch, updated_at: new Date().toISOString() } };
      // Recompute counters
      let upl=0, pen=0, mis=0;
      DOC_SLOTS.forEach(d => {
        const hasFile = (state.application.uploaded_documents||[]).some(it => it.slot === d.slot);
        const recStatus = (next[d.slot]||{}).status;
        if (hasFile) upl++;
        else if (recStatus === "pending") pen++;
        else if (recStatus === "missing") mis++;
      });
      const provisional = (upl < DOC_SLOTS.length) || (pen + mis > 0);
      const chase = mis > 0 || pen > 0;
      const updatePatch = {
        doc_status_records: next,
        uploaded_docs_count: upl,
        pending_docs_count: pen,
        missing_docs_count: mis,
        provisional_compliance: provisional,
        apc_chase_required: chase
      };
      const { data, error } = await sb.from("beta_applications")
        .update(updatePatch).eq("id", state.application.id).select().maybeSingle();
      if (error) throw new Error("Save failed: " + error.message);
      state.application = data || { ...state.application, ...updatePatch };
    }

    // ---- helpers ----
    async function persistItems(newItems) {
      const { data, error } = await sb.from("beta_applications")
        .update({ uploaded_documents: newItems })
        .eq("id", state.application.id).select().maybeSingle();
      if (error) throw new Error("Save failed: " + error.message);
      state.application = data || { ...state.application, uploaded_documents: newItems };
    }

    async function doUpload(file, meta, msgEl) {
      logSessionEvent("upload_started", { slot: meta.slot, name: file.name, size: file.size, type: file.type });
      const v = await TRACK.validateUploadFile(file, { maxBytes: 10*1024*1024, allowedExt: ["pdf","jpg","jpeg","png"] });
      if (!v.ok) {
        TRACK.friction.bumpFailure();
        msgEl.innerHTML = `<div class="alert alert-bad">${v.errors.map(escapeHTML).join("<br/>")}</div>`;
        logSessionEvent("upload_failed", { slot: meta.slot, reasons: v.errors });
        return false;
      }
      msgEl.innerHTML = `<div class="alert alert-info">Uploading…</div>`;
      const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g,"_");
      const path = `${state.user.id}/${state.application.id}/${meta.slot}/${Date.now()}_${safeName}`;
      const { error: upErr } = await sb.storage.from("beta-documents").upload(path, file, { cacheControl: "3600", upsert: false });
      if (upErr) {
        TRACK.friction.bumpFailure();
        msgEl.innerHTML = `<div class="alert alert-bad">${escapeHTML(upErr.message)}</div>`;
        logSessionEvent("upload_failed", { slot: meta.slot, reason: upErr.message });
        return false;
      }
      const newItem = {
        slot: meta.slot,
        label: meta.label || null,
        description: meta.description || null,
        name: file.name, size: file.size, type: file.type, path,
        uploaded_at: new Date().toISOString()
      };
      const current = state.application.uploaded_documents || [];
      let next;
      if (meta.slot !== ADDITIONAL_SLOT) {
        // single file per named slot — replace existing
        next = current.filter(it => (it.slot || "_legacy") !== meta.slot).concat([newItem]);
      } else {
        next = current.concat([newItem]);
      }
      await persistItems(next);
      logSessionEvent("upload_succeeded", { slot: meta.slot, path, label: meta.label || null });
      return true;
    }

    async function removeItem(predicate, slotForLog) {
      const current = state.application.uploaded_documents || [];
      const next = current.filter(it => !predicate(it));
      await persistItems(next);
      logSessionEvent("upload_removed", { slot: slotForLog });
    }

    // ---- wire 3-state choice buttons ----
    document.querySelectorAll(".doc-choice").forEach(btn => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        const action = btn.dataset.action;
        if (action === "upload") {
          document.getElementById("file-" + slot)?.click();
        } else if (action === "pending") {
          await persistStatus(slot, { status: "pending", reason_code: null, reason_text: null });
          logSessionEvent("doc_status_set", { slot, status: "pending" });
          renderUpload();
        } else if (action === "missing") {
          // Reveal the reason panel inline
          document.getElementById("reason-" + slot)?.classList.remove("hidden");
          btn.closest(".doc-choice-row")?.classList.add("hidden");
        }
      };
    });

    // ---- wire reason dropdowns ----
    document.querySelectorAll(".doc-reason-select").forEach(sel => {
      sel.onchange = () => {
        const slot = sel.dataset.slot;
        const other = document.getElementById("reason-other-" + slot);
        if (other) other.classList.toggle("hidden", sel.value !== "other");
        const help = document.getElementById("reason-help-" + slot);
        if (help) help.classList.toggle("hidden", sel.value !== "service_help_requested");
      };
    });
    document.querySelectorAll(".doc-reason-confirm").forEach(btn => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        const sel = document.getElementById("reason-select-" + slot);
        const other = document.getElementById("reason-other-" + slot);
        const msgEl = document.getElementById("msg-" + slot);
        const code = sel.value;
        if (!code) {
          msgEl.innerHTML = `<div class="alert alert-bad">Please select a reason.</div>`;
          return;
        }
        const text = code === "other" ? (other.value || "").trim() : null;
        if (code === "other" && text.length < 3) {
          msgEl.innerHTML = `<div class="alert alert-bad">Please tell us a bit more.</div>`;
          return;
        }
        await persistStatus(slot, { status: "missing", reason_code: code, reason_text: text });
        logSessionEvent("doc_status_set", { slot, status: "missing", reason_code: code });
        if (code === "service_help_requested") {
          logSessionEvent("service_help_requested", { source: "step5_doc", category: slot, application_id: state.application.id, property_id: state.application.property_id || null });
        }
        renderUpload();
      };
    });
    document.querySelectorAll(".doc-reason-cancel").forEach(btn => {
      btn.onclick = () => {
        const slot = btn.dataset.slot;
        document.getElementById("reason-" + slot)?.classList.add("hidden");
        btn.closest(".doc-card")?.querySelector(".doc-choice-row")?.classList.remove("hidden");
      };
    });

    // ---- wire 'Upload now' / 'Change answer' on pending/missing cards ----
    document.querySelectorAll(".doc-action-upload").forEach(btn => {
      btn.onclick = () => {
        const slot = btn.dataset.slot;
        const tmp = document.createElement("input");
        tmp.type = "file";
        tmp.accept = ".pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf";
        tmp.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const msgEl = document.getElementById("msg-" + slot);
          const ok = await doUpload(file, { slot }, msgEl);
          if (ok) {
            // Clear any prior pending/missing status
            await persistStatus(slot, { status: null, reason_code: null, reason_text: null });
            renderUpload();
          }
        };
        tmp.click();
      };
    });
    document.querySelectorAll(".doc-action-clear").forEach(btn => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        await persistStatus(slot, { status: null, reason_code: null, reason_text: null });
        logSessionEvent("doc_status_cleared", { slot });
        renderUpload();
      };
    });

    // ---- wire named-slot inputs (the hidden file inputs used by 'Upload now') ----
    document.querySelectorAll(".doc-file-input[data-slot]").forEach(inp => {
      inp.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const slot = inp.dataset.slot;
        const msgEl = document.getElementById("msg-" + slot);
        const ok = await doUpload(file, { slot }, msgEl);
        if (ok) {
          // upload supersedes any prior status
          await persistStatus(slot, { status: null, reason_code: null, reason_text: null });
          renderUpload();
        } else e.target.value = "";
      };
    });

    // ---- wire replace / remove ----
    document.querySelectorAll(".doc-replace").forEach(btn => {
      btn.onclick = () => {
        const slot = btn.dataset.slot;
        // recreate hidden file input and trigger
        const tmp = document.createElement("input");
        tmp.type = "file";
        tmp.accept = ".pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf";
        tmp.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const msgEl = document.getElementById("msg-" + slot);
          const ok = await doUpload(file, { slot }, msgEl);
          if (ok) renderUpload();
        };
        tmp.click();
      };
    });
    document.querySelectorAll(".doc-remove").forEach(btn => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        await removeItem(it => (it.slot || "_legacy") === slot, slot);
        renderUpload();
      };
    });
    document.querySelectorAll(".doc-remove-additional").forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const current = state.application.uploaded_documents || [];
        // map idx within additional subset back to global index
        const additionals = current.map((it, i) => ({ it, i })).filter(x => (x.it.slot || "_legacy") === ADDITIONAL_SLOT);
        const target = additionals[idx];
        if (!target) return;
        const next = current.filter((_, i) => i !== target.i);
        await persistItems(next);
        logSessionEvent("upload_removed", { slot: ADDITIONAL_SLOT, label: target.it.label });
        renderUpload();
      };
    });

    // ---- wire additional (label-first gate) ----
    const addLabel = document.getElementById("add-label");
    const addDesc = document.getElementById("add-desc");
    const addFile = document.getElementById("add-file");
    const addBtn  = document.getElementById("add-upload-label");
    const updateGate = () => {
      const has = (addLabel.value || "").trim().length >= 2;
      addFile.disabled = !has;
      addBtn.classList.toggle("disabled", !has);
    };
    addLabel.addEventListener("input", updateGate);
    updateGate();
    addFile.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const label = (addLabel.value || "").trim();
      const description = (addDesc.value || "").trim();
      if (label.length < 2) {
        document.getElementById("msg-additional").innerHTML = `<div class="alert alert-bad">Please add a document label first.</div>`;
        e.target.value = "";
        return;
      }
      const msgEl = document.getElementById("msg-additional");
      const ok = await doUpload(file, { slot: ADDITIONAL_SLOT, label, description }, msgEl);
      if (ok) renderUpload();
      else e.target.value = "";
    };

    $("#btn-back").onclick = () => goStep(4);
    $("#btn-next").onclick = () => goStep(6);
  }

  // STEP 6
  async function renderSummary() {
    const p = appPropertyFromRow(state.application);
    const a = state.application.compliance_answers || {};

    let score = p.compliance_score; // base
    if (a.al_registered === "yes") score = Math.min(100, score + 5);
    if (a.al_registered === "no")  score = Math.max(0,   score - 10);
    if (a.safety === "yes")        score = Math.min(100, score + 4);
    if (a.safety === "no")         score = Math.max(0,   score - 8);
    if (a.licenca === "yes")       score = Math.min(100, score + 4);
    if (a.licenca === "no")        score = Math.max(0,   score - 6);
    if (a.fiscal  === "no")        score = Math.max(0,   score - 5);

    const band =
      score >= 85 ? "Submission-ready" :
      score >= 65 ? "Almost there" :
      score >= 45 ? "Needs work" : "Significant gaps";

    const docs = p.doc_flags || [];
    const missing = docs.filter(d => !d.present).length;
    const present = docs.length - missing;

    await sb.from("beta_applications").update({
      final_compliance_score: score, final_compliance_band: band
    }).eq("id", state.application.id);

    main().innerHTML = `
      <div class="card">
        ${renderSteps(6)}
        <h2>Your compliance summary</h2>
        <div class="score-block">
          <div>Your test compliance score</div>
          <div class="score-num">${score}</div>
          <div class="score-out">out of 100</div>
          <div class="score-band">${band}</div>
        </div>

        <p>
          Based on your answers and a quick scan of the test documents,
          here's where you'd stand if this were a real application.
        </p>

        <h3 style="color:var(--apc-green);margin-bottom:6px">Documents on file (test)</h3>
        <p class="muted" style="margin-top:0">${present} present · ${missing} missing</p>
        ${docs.map(d => `
          <div class="doc-row">
            <div class="doc-label">${escapeHTML(d.label)}</div>
            <div class="doc-status ${d.present ? "ok" : "bad"}">${d.present ? "Present ✓" : "Missing ✗"}</div>
          </div>
        `).join("")}

        <div class="watermark">FOR BETA TESTING ONLY — NOT VALID FOR LEGAL OR COMPLIANCE USE</div>

        <div class="alert alert-warn" style="margin-top:18px">
          <strong>Reminder:</strong> this is a beta test. No filing has been made.
          In a real application, APC would help you collect the missing items and submit on your behalf.
        </div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Give feedback</button>
        </div>
      </div>
    `;
    $("#btn-back").onclick = () => goStep(5);
    $("#btn-next").onclick = () => goStep(7);
  }

  // STEP 7
  function renderFeedback() {
    const f = state.application.feedback_data || {};
    function ratingHTML(field, label) {
      const cur = f[field];
      let html = `<label>${label}</label><div class="rating" data-field="${field}">`;
      for (let i = 1; i <= 5; i++) {
        html += `<button type="button" data-val="${i}" class="${cur===i?"selected":""}">${i}</button>`;
      }
      html += `</div>`;
      return html;
    }
    main().innerHTML = `
      <div class="card">
        ${renderSteps(7)}
        <h2>How was that?</h2>
        <p class="muted">Honest feedback helps us build something genuinely useful. Won't take more than a minute.</p>

        ${ratingHTML("clarity", "How clear was the process? (1 = very confusing, 5 = very clear)")}
        ${ratingHTML("trust", "How much would you trust APC with a real application? (1 = not at all, 5 = completely)")}
        ${ratingHTML("ease", "How easy was it to complete on this device? (1 = very hard, 5 = very easy)")}

        <label>What confused you, if anything?</label>
        <textarea id="fb-confusion" placeholder="Anything that made you pause or look twice…">${escapeHTML(f.confusion || "")}</textarea>

        <label>What would make this more useful?</label>
        <textarea id="fb-improve" placeholder="Features, info, reassurances…">${escapeHTML(f.improve || "")}</textarea>

        <label>Would you pay for this service? (one line is fine)</label>
        <textarea id="fb-pay" placeholder="Why / why not, what price range feels fair…">${escapeHTML(f.pay || "")}</textarea>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Submit feedback</button>
        </div>
      </div>
    `;
    document.querySelectorAll(".rating").forEach(group => {
      group.querySelectorAll("button").forEach(btn => {
        btn.onclick = () => {
          group.querySelectorAll("button").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
        };
      });
    });

    $("#btn-back").onclick = () => goStep(6);
    $("#btn-next").onclick = async () => {
      function getRating(field) {
        const sel = document.querySelector(`.rating[data-field="${field}"] button.selected`);
        return sel ? parseInt(sel.dataset.val, 10) : null;
      }
      const feedback = {
        clarity:   getRating("clarity"),
        trust:     getRating("trust"),
        ease:      getRating("ease"),
        confusion: $("#fb-confusion").value.trim(),
        improve:   $("#fb-improve").value.trim(),
        pay:       $("#fb-pay").value.trim()
      };
      if (!feedback.clarity || !feedback.trust || !feedback.ease) {
        alert("Please rate all three: clarity, trust, ease.");
        return;
      }

      const completedAt = new Date().toISOString();
      await sb.from("beta_applications").update({
        feedback_data: feedback,
        status: "completed",
        completed_at: completedAt,
        application_progress: 100,
        submitted_at: completedAt
      }).eq("id", state.application.id);

      await sb.from("testers").update({
        feedback_score: feedback.clarity + feedback.trust + feedback.ease,
        completion_percent: 100,
        onboarding_status: "completed",
        last_step_completed: 7
      }).eq("id", state.tester.id);

      await sb.from("beta_feedback").insert({
        tester_id: state.tester.id,
        application_id: state.application.id,
        clarity_score: feedback.clarity,
        trust_score: feedback.trust,
        ease_score: feedback.ease,
        confusion_notes: feedback.confusion,
        improvement_text: feedback.improve,
        would_pay_text: feedback.pay,
        bugs_found: null
      });

      logSessionEvent("feedback_submitted", feedback);
      goStep(8);
    };
  }

  // STEP 8
  function renderComplete() {
    main().innerHTML = `
      <div class="card">
        ${renderSteps(8)}
        <div class="complete-tick">✓</div>
        <h2 style="text-align:center">Thanks, you're done</h2>
        <p style="text-align:center">
          Your feedback has been recorded. You've helped shape the real APC product.
        </p>
        <div class="alert alert-info">
          <strong>What happens next:</strong> Dave or someone from the APC team may reach out for
          a quick follow-up. Anything you flagged as confusing will be reviewed before launch.
        </div>
        <p class="muted" style="text-align:center">
          You can close this tab — there's nothing else to do.
        </p>
        <button class="btn btn-secondary" id="btn-restart">Run through it again</button>
      </div>
    `;
    $("#btn-restart").onclick = async () => {
      const { data } = await sb.from("beta_applications").insert({
        tester_id: state.tester.id,
        status: "in_progress",
        application_progress: 0
      }).select().single();
      if (data) state.application = data;
      goStep(1);
    };
    logSessionEvent("flow_complete", {
      total_time_ms: Date.now() - state.sessionStart
    });
  }

  // ---------- Boot ----------
  // If session is missing or boot hangs, fall back to sign-in.
  // If session exists but something later breaks, show an error — do NOT
  // bounce back to sign-in (that creates the infinite magic-link loop).
  function safeFallbackToSignIn(reason) {
    try { console.warn("APC boot fallback (no session):", reason); } catch (e) {}
    try { renderHeader(); } catch (e) {}
    try { renderSignIn(); } catch (e) {
      const m = document.getElementById("apc-main");
      if (m) m.innerHTML =
        '<div class="card"><h1>Welcome to APC Beta</h1>' +
        '<p>Something didn\u2019t load on this device. Please try a hard refresh, ' +
        'or open this page in a different browser.</p></div>';
    }
  }

  function showPostAuthError(err) {
    try { console.error("APC post-auth error:", err); } catch (e) {}
    try { renderHeader(); } catch (e) {}
    const m = document.getElementById("apc-main");
    const msg = (err && err.message) ? err.message : String(err);
    if (m) m.innerHTML =
      '<div class="card">' +
        '<h1>You\u2019re signed in \u2014 but something went wrong loading your data</h1>' +
        '<p class="muted">No need to request another sign-in link \u2014 you are signed in. ' +
        'Please send the message below to dave@algarvepropertycompliance.com and we\u2019ll fix it.</p>' +
        '<pre style="background:#f3f5f7;padding:12px;border-radius:8px;overflow:auto;font-size:13px;">' +
          escapeHTML(msg) +
        '</pre>' +
        '<button class="btn btn-secondary" onclick="location.reload()">Try again</button> ' +
        '<button class="btn" id="btn-force-signout">Sign out</button>' +
      '</div>';
    const so = document.getElementById("btn-force-signout");
    if (so) so.onclick = () => sb.auth.signOut().then(() => location.reload());
  }

  async function boot() {
    // 24h inactivity timeout (outside try — will sign user out cleanly)
    if (TRACK && TRACK.checkSessionTimeout(sb, () => window.location.reload())) return;

    // If the URL carries a magic-link payload, show the spinner and wait
    // for supabase-js to finish the exchange via onAuthStateChange.
    const urlHasAuth =
      /[?&]code=/.test(window.location.search) ||
      /access_token=|refresh_token=|type=magiclink/.test(window.location.hash);
    if (urlHasAuth) {
      renderSigningInSpinner();
      // Wait up to 8s for the session to materialise, then clean the URL.
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const { data: { session: s } } = await sb.auth.getSession();
        if (s) break;
        await new Promise(r => setTimeout(r, 250));
      }
      // Strip the auth params from the URL so a reload doesn't try to reuse them.
      try {
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (e) {}
    }

    // PHASE 1: get session. If this hangs or fails, fall back to sign-in.
    let session = null;
    try {
      const sessionPromise = sb.auth.getSession();
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ data: { session: null }, __timedOut: true }), 4000)
      );
      const result = await Promise.race([sessionPromise, timeoutPromise]);
      session = (result && result.data && result.data.session) || null;
      if (result && result.__timedOut) {
        console.warn("APC boot: getSession() timed out, defaulting to sign-in");
      }
    } catch (err) {
      return safeFallbackToSignIn((err && err.message) || String(err));
    }

    if (!session) {
      renderHeader();
      return renderSignIn();
    }

    // PHASE 2: we have a real session. Any failure from here is NOT an auth
    // failure — show an explicit error so the user doesn\u2019t loop back to magic-link.
    try {
      state.user = session.user;
      const tester = await ensureTester();
      if (!tester) {
        throw new Error("Could not create or load your tester profile (ensureTester returned null). Check Supabase logs and RLS/NOT-NULL constraints on the testers table.");
      }
      const app = await loadOrCreateApplication();
      if (!app) {
        throw new Error("Could not create or load your application (loadOrCreateApplication returned null). Check Supabase logs and constraints on beta_applications.");
      }

    // Stamp tester with device info + last_seen
    if (state.tester) {
      sb.from("testers").update({
        device_info: TRACK.getDeviceInfo(),
        last_seen_at: new Date().toISOString()
      }).eq("id", state.tester.id);
    }

    // Help button on every screen
    TRACK.injectHelpButton({ stepLabel: STEPS[state.step - 1] });

    // v0.5.0 — Multi-property routing (feature-flagged, Dave-only for now)
    if (isMultiPropertyEnabled()) {
      // 1. No property_mode set yet → first-visit choice screen
      if (!state.tester.property_mode) {
        state.stepStart = Date.now();
        renderHeader();
        renderPropertyModeChoice();
        logSessionEvent("session_start");
        return;
      }
      // 2. Multiple-property mode → dashboard hub (skip auto-resume into a single app)
      if (state.tester.property_mode === "multiple") {
        state.stepStart = Date.now();
        renderHeader();
        await renderDashboard();
        logSessionEvent("session_start");
        return;
      }
      // 3. Single-property mode → fall through to legacy resume logic
    }

    if (state.application.status === "completed") {
      state.step = 8;
    } else if (state.application.feedback_data && Object.keys(state.application.feedback_data).length) {
      state.step = 7;
    } else if (state.application.compliance_answers && Object.keys(state.application.compliance_answers).length) {
      state.step = 5;
    } else if (state.application.generated_property_town) {
      state.step = 3;
    } else if (state.tester.algarve_area) {
      state.step = 2;
    } else {
      state.step = 1;
    }
      state.stepStart = Date.now();
      renderStep();
      logSessionEvent("session_start");

      // application_abandoned: log on visibility change while flow is open
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" &&
            state.application && state.application.status !== "completed") {
          logSessionEvent("application_abandoned", { left_at_step: state.step });
        }
      });
    } catch (err) {
      showPostAuthError(err);
    }
  }

  sb.auth.onAuthStateChange((_event, session) => {
    if (session && !state.user) {
      state.user = session.user;
      boot();
    }
  });

  boot();
})();
