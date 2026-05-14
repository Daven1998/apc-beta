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

  // ---------- Auth (magic link) ----------
  async function renderSignIn() {
    main().innerHTML = `
      <div class="card">
        <h1>Welcome to APC Beta</h1>
        <p class="muted">
          You're helping us test how the Algarve Property Compliance application service feels for real Algarve property owners.
          No real documents, no real fees — this is a test environment.
        </p>
        <div class="alert alert-info">
          <strong>How sign-in works:</strong> we'll email you a one-time link.
          Tap the link in that email and you'll be signed in. No password.
        </div>

        <label for="email">Your email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email"
               placeholder="you@example.com" />

        <label for="name">Your name</label>
        <input id="name" type="text" autocomplete="name" placeholder="First and last name" />

        <button class="btn btn-primary" id="btn-send">Email me a sign-in link</button>
        <div id="signin-msg"></div>
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
      $("#btn-send").disabled = true;
      $("#btn-send").textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: cfg.REDIRECT_URL }
      });
      if (error) {
        msg.innerHTML = `<div class="alert alert-bad">${escapeHTML(error.message)}</div>`;
        $("#btn-send").disabled = false;
        $("#btn-send").textContent = "Email me a sign-in link";
        return;
      }
      msg.innerHTML = `
        <div class="alert alert-ok">
          <strong>Check your email.</strong>
          We've sent a sign-in link to <strong>${escapeHTML(email)}</strong>.
          Open it on this device.
        </div>`;
      $("#btn-send").textContent = "Link sent ✓";
    };
  }

  // ---------- Tester upsert after sign-in ----------
  async function ensureTester() {
    if (!state.user) return null;
    let pendingName = "";
    try { pendingName = localStorage.getItem("apc_pending_name") || ""; } catch (e) {}

    let { data: existing } = await sb
      .from("testers").select("*").eq("auth_user_id", state.user.id).maybeSingle();

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
      if (e2) { console.error(e2); return null; }
      state.tester = ins;
    }
    try { localStorage.removeItem("apc_pending_name"); } catch (e) {}
    return state.tester;
  }

  async function loadOrCreateApplication() {
    if (!state.tester) return null;
    let { data: apps } = await sb
      .from("beta_applications")
      .select("*")
      .eq("tester_id", state.tester.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (apps && apps.length) {
      state.application = apps[0];
    } else {
      const { data: ins, error } = await sb.from("beta_applications").insert({
        tester_id: state.tester.id,
        status: "in_progress",
        application_progress: 0
      }).select().single();
      if (error) { console.error(error); return null; }
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

      // Save town on the tester
      const { data: tu } = await sb.from("testers")
        .update({ algarve_area: t })
        .eq("id", state.tester.id).select().single();
      if (tu) state.tester = tu;

      // Generate fake property anchored to chosen town if not yet or town changed
      let prop = appPropertyFromRow(state.application);
      if (!prop || prop.town !== t) {
        prop = window.APC_FAKE.generate(t);
        const cols = propertyToColumns(prop);
        const { data: au } = await sb.from("beta_applications")
          .update(cols)
          .eq("id", state.application.id).select().single();
        if (au) state.application = au;
      }
      goStep(3);
    };
  }

  // STEP 3
  function renderReviewProperty() {
    const p = appPropertyFromRow(state.application);
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
        <div class="prop-row"><div class="prop-key">Max guests</div><div class="prop-val">${p.capacity}</div></div>
        <div class="prop-row"><div class="prop-key">Year built</div><div class="prop-val">${p.year_built}</div></div>
        <div class="prop-row"><div class="prop-key">Owner NIF</div><div class="prop-val">${escapeHTML(p.nif)}</div></div>
        <div class="prop-row"><div class="prop-key">AL licence</div><div class="prop-val">${escapeHTML(p.al_licence)}</div></div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-secondary" id="btn-regen">Generate a new one</button>
        </div>
        <button class="btn btn-primary" id="btn-next">Looks good — continue</button>
      </div>
    `;
    $("#btn-back").onclick = () => goStep(2);
    $("#btn-regen").onclick = async () => {
      const newProp = window.APC_FAKE.generate(state.tester.algarve_area);
      const { data } = await sb.from("beta_applications")
        .update(propertyToColumns(newProp))
        .eq("id", state.application.id).select().single();
      if (data) state.application = data;
      renderReviewProperty();
    };
    $("#btn-next").onclick = () => goStep(4);
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
        </select>

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
    $("#btn-next").onclick = async () => {
      const ans = {
        al_registered: $("#q-al").value,
        safety:        $("#q-safety").value,
        licenca:       $("#q-licenca").value,
        fiscal:        $("#q-fiscal").value,
        notes:         $("#q-notes").value.trim()
      };
      if (!ans.al_registered || !ans.safety || !ans.licenca || !ans.fiscal) {
        alert("Please answer all four questions before continuing.");
        return;
      }
      const { data } = await sb.from("beta_applications")
        .update({ compliance_answers: ans })
        .eq("id", state.application.id).select().single();
      if (data) state.application = data;
      goStep(5);
    };
  }

  // STEP 5
  async function renderUpload() {
    const existing = state.application.uploaded_documents || [];
    main().innerHTML = `
      <div class="card">
        ${renderSteps(5)}
        <h2>Upload a test document</h2>
        <p class="muted">
          Upload any PDF, JPG, or PNG you don't mind sharing (under 10 MB).
          This is just to test the upload flow — uploads are private and only visible to the APC team.
        </p>

        <div class="upload-zone">
          <input type="file" id="file-input" accept=".pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf" />
          <div class="muted" style="margin-top:10px">PDF, JPG or PNG · up to 10 MB</div>
        </div>

        <ul class="file-list" id="file-list"></ul>
        <div id="upload-msg"></div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">Back</button>
          <button class="btn btn-primary" id="btn-next">Continue</button>
        </div>
        <p class="muted" style="text-align:center;margin-top:10px">
          You can skip uploads and continue — it's optional for the beta.
        </p>
      </div>
    `;

    function refreshList(items) {
      $("#file-list").innerHTML = items.map(f =>
        `<li><span>${escapeHTML(f.name)}</span><span class="muted">${(f.size/1024).toFixed(0)} KB</span></li>`
      ).join("");
    }
    refreshList(existing);

    $("#file-input").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      logSessionEvent("upload_started", { name: file.name, size: file.size, type: file.type });

      // Strict validation
      const v = await TRACK.validateUploadFile(file, {
        maxBytes: 10*1024*1024,
        allowedExt: ["pdf","jpg","jpeg","png"]
      });
      if (!v.ok) {
        TRACK.friction.bumpFailure();
        $("#upload-msg").innerHTML = `<div class="alert alert-bad">${v.errors.map(escapeHTML).join("<br/>")}</div>`;
        logSessionEvent("upload_failed", { reasons: v.errors });
        $("#file-input").value = "";
        return;
      }

      $("#upload-msg").innerHTML = `<div class="alert alert-info">Uploading…</div>`;
      const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g,"_");
      const path = `${state.user.id}/${state.application.id}/${Date.now()}_${safeName}`;
      const { error: upErr } = await sb.storage.from("beta-documents").upload(path, file, {
        cacheControl: "3600", upsert: false
      });
      if (upErr) {
        TRACK.friction.bumpFailure();
        $("#upload-msg").innerHTML = `<div class="alert alert-bad">${escapeHTML(upErr.message)}</div>`;
        logSessionEvent("upload_failed", { reason: upErr.message });
        return;
      }
      const newItem = { name: file.name, size: file.size, path, type: file.type, uploaded_at: new Date().toISOString() };
      const merged = [...(state.application.uploaded_documents || []), newItem];
      const { data } = await sb.from("beta_applications")
        .update({ uploaded_documents: merged })
        .eq("id", state.application.id).select().single();
      if (data) state.application = data;
      refreshList(merged);
      $("#upload-msg").innerHTML = `<div class="alert alert-ok">Uploaded ✓</div>`;
      logSessionEvent("upload_succeeded", { path });
      $("#file-input").value = "";
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
  async function boot() {
    // 24h inactivity timeout
    if (TRACK && TRACK.checkSessionTimeout(sb, () => window.location.reload())) return;

    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      renderHeader();
      return renderSignIn();
    }
    state.user = session.user;
    await ensureTester();
    await loadOrCreateApplication();

    // Stamp tester with device info + last_seen
    if (state.tester) {
      sb.from("testers").update({
        device_info: TRACK.getDeviceInfo(),
        last_seen_at: new Date().toISOString()
      }).eq("id", state.tester.id);
    }

    // Help button on every screen
    TRACK.injectHelpButton({ stepLabel: STEPS[state.step - 1] });

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
    // (drop-off is also inferable from missing later step_completed events)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" &&
          state.application && state.application.status !== "completed") {
        logSessionEvent("application_abandoned", { left_at_step: state.step });
      }
    });
  }

  sb.auth.onAuthStateChange((_event, session) => {
    if (session && !state.user) {
      state.user = session.user;
      boot();
    }
  });

  boot();
})();
