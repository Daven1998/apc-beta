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
  BETA_BUILD: "v0.4.0-beta",
  // Where the magic-link email returns users
  REDIRECT_URL: window.location.origin + window.location.pathname
};

window.supabaseClient = window.supabase.createClient(
  window.APC_CONFIG.SUPABASE_URL,
  window.APC_CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce"
    }
  }
);
