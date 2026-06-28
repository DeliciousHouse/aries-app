/**
 * Rollout gate for REEL VOICEOVER synthesis via ElevenLabs text-to-speech.
 *
 * When ON, `synthesizeVoiceover` in tts.ts is called during reel composition
 * to generate an mp3 voiceover track from the reel copy (hook/value/cta).
 * When OFF (default) the synthesis step is skipped and the mux phase falls
 * back to the ambient music bed only — reel output is byte-identical to today.
 *
 * Requires ELEVENLABS_API_KEY to be set; if the key is absent the synthesis
 * step returns null regardless of this flag (best-effort, never throws).
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_* env-gate convention.
 * Process-wide; default OFF.
 */
export function isReelVoiceoverEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.ARIES_REEL_VOICEOVER_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
