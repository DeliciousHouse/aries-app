/**
 * ElevenLabs text-to-speech client for reel voiceover synthesis.
 *
 * Best-effort / never-throw: any failure (missing key, network error, non-2xx,
 * timeout) is console.warn'd and returns null so the mux phase can fall back
 * to the ambient music bed without breaking the publish flow.
 *
 * Dependency-free — uses global fetch + node:fs/promises only.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ElevenLabsVoiceoverArgs {
  /** The VO script text to synthesise. */
  text: string;
  /** Absolute path where the mp3 should be written. */
  outPath: string;
  /** ElevenLabs voice id. Defaults to ELEVENLABS_VOICE_ID env var or "Sarah". */
  voiceId?: string;
  /** ElevenLabs model id. Defaults to eleven_turbo_v2_5. */
  modelId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ElevenLabs "Sarah" stock voice — available on all free/paid plans. */
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
const TTS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// synthesizeVoiceover
// ---------------------------------------------------------------------------

/**
 * Calls the ElevenLabs TTS API and writes the mp3 bytes to `args.outPath`.
 *
 * Returns `args.outPath` on success, or `null` on any failure.
 * Never throws — the caller falls back to a music bed.
 */
export async function synthesizeVoiceover(
  args: ElevenLabsVoiceoverArgs,
): Promise<string | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.warn(
      '[elevenlabs] ELEVENLABS_API_KEY not set — skipping voiceover synthesis',
    );
    return null;
  }

  const voiceId =
    args.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const modelId = args.modelId ?? DEFAULT_MODEL_ID;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${TTS_BASE_URL}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: args.text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(
        `[elevenlabs] TTS request failed — HTTP ${res.status} ${res.statusText}`,
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1024) {
      console.warn('[elevenlabs] empty/too-small audio body — skipping VO');
      return null;
    }
    await mkdir(dirname(args.outPath), { recursive: true });
    await writeFile(args.outPath, buffer);
    return args.outPath;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : String(err);
    console.warn(`[elevenlabs] TTS synthesis error — ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// fitCopyToDuration
// ---------------------------------------------------------------------------

/**
 * Assembles a VO script from reel copy fields (hook / value proposition / CTA)
 * and trims it to fit within `seconds` at an average speaking rate of ~2.6
 * words-per-second, so the synthesised voiceover stays within the clip length.
 *
 * Priority: the CTA is the most important spoken line and is always preserved
 * when non-empty. If hook+cta alone meet or exceed the budget, only the hook
 * is trimmed (CTA is never dropped). Otherwise the remaining word budget is
 * filled with as much of VALUE as fits, placed between hook and cta.
 *
 * Parts are joined with '. ' and trailing clause-continuation punctuation
 * (comma, semicolon, colon) is stripped so the TTS engine does not end
 * mid-phrase.
 *
 * Pure function — no I/O, safe to call in tests without any setup.
 */
export function fitCopyToDuration(
  copy: { hook?: string; value?: string; cta?: string },
  seconds: number,
): string {
  const clean = (s?: string) => (typeof s === 'string' ? s.trim() : '');
  const hook = clean(copy.hook);
  const value = clean(copy.value);
  const cta = clean(copy.cta);

  // Nothing to speak — bail fast.
  if (!hook && !value && !cta) return '';

  const targetWords = Math.max(1, Math.round(seconds * 2.6));

  // If all parts fit within the budget, return as-is.
  const allParts = [hook, value, cta].filter(Boolean).join('. ');
  const allWords = allParts.split(/\s+/).filter(Boolean);
  if (allWords.length <= targetWords) return allParts;

  // CTA is the highest priority — always preserved when non-empty.
  const hookWords = hook ? hook.split(/\s+/).filter(Boolean) : [];
  const ctaWords = cta ? cta.split(/\s+/).filter(Boolean) : [];
  const mandatoryCount = hookWords.length + ctaWords.length;

  // If hook + cta already meet or exceed the budget, trim the hook to leave
  // room for the CTA. The CTA is never dropped.
  if (mandatoryCount >= targetWords) {
    const hookBudget = Math.max(0, targetWords - ctaWords.length);
    const trimmedHook = hookWords.slice(0, hookBudget).join(' ');
    return [trimmedHook, cta].filter(Boolean).join('. ').replace(/[,;:]+$/, '');
  }

  // Fill the remaining budget with as much of VALUE as fits, placed between
  // hook and cta. Strip trailing clause-break punctuation so the TTS engine
  // produces a natural sentence ending.
  const valueBudget = targetWords - mandatoryCount;
  const valueWords = value ? value.split(/\s+/).filter(Boolean) : [];
  const trimmedValue = valueWords.slice(0, valueBudget).join(' ');
  return [hook, trimmedValue, cta].filter(Boolean).join('. ').replace(/[,;:]+$/, '');
}
