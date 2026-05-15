// APC Beta — Supabase client config
// Publishable key is safe to expose in browser (RLS enforces access).
window.APC_CONFIG = {
  SUPABASE_URL: "https://uxvnyjasnkdijazilasz.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_A1mAott3YjVXDcJCLhSrjg_ad9HqTH1",
  ADMIN_EMAILS: [
    "dave@algarvepropertycompliance.com",
    "joe@algarvepropertycompliance.com",
    "liam@algarvepropertycompliance.com",
    "hello@algarvepropertycompliance.com",
    "lucy@lockerspace.co.uk"
  ],
  BETA_BUILD: "v0.5.0-beta",
  // Where the magic-link email returns users
  REDIRECT_URL: window.location.origin + window.location.pathname,
  // v0.5.0 Feature flags — controlled rollout of multi-property
  FEATURE_FLAGS: {
    // Whitelist of emails who see the multi-property choice + dashboard.
    // Empty array = feature disabled for everyone. Add emails to roll out.
    multi_property_emails: [
      "dave@algarvepropertycompliance.com",
      "joe@algarvepropertycompliance.com",
      "liam@algarvepropertycompliance.com",
      "lucy@lockerspace.co.uk"
    ]
  }
};

window.APC_CONFIG.hasFeature = function(name, email) {
  const ff = (window.APC_CONFIG.FEATURE_FLAGS || {})[name + "_emails"];
  if (!Array.isArray(ff)) return false;
  return ff.includes((email || "").toLowerCase());
};

window.supabaseClient = window.supabase.createClient(
  window.APC_CONFIG.SUPABASE_URL,
  window.APC_CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit"
    }
  }
);
