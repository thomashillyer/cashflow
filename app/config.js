// DO NOT COMMIT real values here. Cloudflare Pages publishes app/ as committed, including every PR preview.
// Set live values only in your local copy, or in the host's own config for a private deployment.
// Point the app at the team's API. Leave empty to run the built-in preview with sample businesses.
// You can also pass ?api=http://localhost:8787 in the URL.
window.NERI_API_BASE = "";

// Real sign-in (Supabase Auth, one-time code by email). The anon key is public by design; the database's
// row-level security decides what a signed-in user can see. Never put the service-role key here.
window.NERI_SUPABASE_URL = "";
window.NERI_SUPABASE_ANON_KEY = "";

// Lock the screen after this many idle minutes (0 turns it off).
window.NERI_LOCK_MINUTES = 15;
