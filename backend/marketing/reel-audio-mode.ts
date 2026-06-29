/**
 * Canonical REEL AUDIO MODE — the user-facing choice of what audio a generated
 * reel carries:
 *   - 'music'     — license-safe music bed only (the safe default)
 *   - 'voiceover' — spoken ElevenLabs voiceover only, no music bed
 *   - 'both'      — voiceover ducked over the music bed
 *
 * Precedence is per-JOB override → per-TENANT default → global default
 * (DEFAULT_REEL_AUDIO_MODE = 'music'). The per-tenant default is set in the
 * Settings screen and governs every reel (including the automated weekly
 * companion). The per-job override is set in the "Create weekly posts" form and
 * wins for that one job.
 *
 * Voiceover capability is still gated at the deployment level by
 * ARIES_REEL_VOICEOVER_ENABLED + ELEVENLABS_API_KEY (see voiceover-env.ts). A
 * mode that asks for voiceover while that capability is OFF/absent degrades to
 * the music bed — never to a silent reel (see resolveReelAudioComposition).
 *
 * This module is pure (no I/O) so the decision logic is exhaustively unit
 * testable without ffmpeg or ElevenLabs.
 */
export type ReelAudioMode = 'music' | 'voiceover' | 'both';

export const DEFAULT_REEL_AUDIO_MODE: ReelAudioMode = 'music';

/**
 * Normalize an arbitrary stored / submitted value to a canonical mode, or null
 * when it is absent / unrecognized. Accepts a few friendly aliases so a value
 * coming from a form, a JSON file, or a legacy field still resolves.
 */
export function parseReelAudioMode(value: unknown): ReelAudioMode | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  switch (v) {
    case 'music':
    case 'music_only':
    case 'music-only':
    case 'musiconly':
      return 'music';
    case 'voiceover':
    case 'voice_over':
    case 'voice-over':
    case 'voice':
    case 'vo':
    case 'voiceover_only':
    case 'voiceover-only':
      return 'voiceover';
    case 'both':
    case 'voiceover_and_music':
    case 'voiceover+music':
    case 'music_and_voiceover':
      return 'both';
    default:
      return null;
  }
}

/** True when the mode wants a spoken voiceover track. */
export function reelAudioModeWantsVoiceover(mode: ReelAudioMode): boolean {
  return mode === 'voiceover' || mode === 'both';
}

/** True when the mode wants the music bed as a (possibly ducked) layer. */
export function reelAudioModeWantsMusic(mode: ReelAudioMode): boolean {
  return mode === 'music' || mode === 'both';
}

/**
 * Resolve the effective mode from the precedence chain. A per-job override wins
 * over the per-tenant default, which wins over the global default. Unparseable
 * values at any level are skipped (treated as "not set").
 */
export function resolveReelAudioMode(opts: {
  jobOverride?: unknown;
  tenantDefault?: unknown;
}): ReelAudioMode {
  return (
    parseReelAudioMode(opts.jobOverride) ??
    parseReelAudioMode(opts.tenantDefault) ??
    DEFAULT_REEL_AUDIO_MODE
  );
}

export interface ReelAudioComposition {
  /** Mux the synthesized voiceover track into the output. */
  useVoiceover: boolean;
  /** Mux the music bed into the output. */
  useMusic: boolean;
  /** When both are used, duck the music under the voiceover. */
  duckMusic: boolean;
}

/**
 * Pure decision for the final audio graph, given the resolved mode and the
 * runtime facts (deployment voiceover gate, key presence, whether synthesis
 * actually succeeded, whether a music bed file exists).
 *
 * Guarantees:
 *  - 'music'                              → music bed only.
 *  - 'voiceover' + VO available + ok      → voiceover only (no music).
 *  - 'voiceover' + VO unavailable/failed  → music bed FALLBACK (never silent).
 *  - 'both' + VO ok                       → voiceover ducked over music.
 *  - 'both' + VO unavailable/failed       → music bed only.
 *  - no music bed on disk                 → whatever audio remains, else silent.
 */
export function resolveReelAudioComposition(input: {
  mode: ReelAudioMode;
  voiceoverEnabled: boolean;
  hasVoiceoverKey: boolean;
  voiceoverSucceeded: boolean;
  musicBedAvailable: boolean;
}): ReelAudioComposition {
  const wantsVo = reelAudioModeWantsVoiceover(input.mode);
  const wantsMusic = reelAudioModeWantsMusic(input.mode);

  const voCapable = wantsVo && input.voiceoverEnabled && input.hasVoiceoverKey;
  const useVoiceover = voCapable && input.voiceoverSucceeded;

  // Include music when the mode asks for it, OR as a fallback when voiceover was
  // wanted but could not be produced (so a 'voiceover'-only reel is never left
  // mute). Either way it only happens if a bed file actually exists.
  const includeMusic = wantsMusic || (wantsVo && !useVoiceover);
  const useMusic = input.musicBedAvailable && includeMusic;

  return {
    useVoiceover,
    useMusic,
    duckMusic: useVoiceover && useMusic,
  };
}
