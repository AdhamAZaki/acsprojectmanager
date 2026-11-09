// The private tracker's OWN Supabase project (not the shared ACS one). Both values are designed
// to be public: the data is protected by your login and the database rules
// (supabase/private-setup.sql: one owner only, every row readable by its owner only).
window.PRIVATE_CONFIG = {
  // Supabase → the private project → Project Settings → API → Project URL
  URL: 'https://tvfbdzjsogxintijxsuv.supabase.co',
  // Supabase → the private project → Project Settings → API Keys → Publishable key
  KEY: '',
};
