-- Per-tenant default reel audio mode (music | voiceover | both).
--
-- Backs the Settings-screen "Reel audio" default, which governs every reel for
-- the tenant (the automated weekly companion job + create-form jobs) unless a
-- per-job override is supplied in the create form. Nullable; an unset value
-- falls back to the fixed default ('music') resolved in
-- backend/marketing/reel-audio-mode.ts. Mirrors the inline
-- ADD COLUMN IF NOT EXISTS in scripts/init-db.js (applied on container start).
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS reel_audio_mode TEXT;
