import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_REEL_AUDIO_MODE,
  parseReelAudioMode,
  reelAudioModeWantsMusic,
  reelAudioModeWantsVoiceover,
  resolveReelAudioComposition,
  resolveReelAudioMode,
} from '../../backend/marketing/reel-audio-mode';

/**
 * Unit tests for the reel audio mode (music | voiceover | both) decision logic.
 *
 * Pure + deterministic — no ffmpeg, ElevenLabs, filesystem, or network. These
 * lock the user-facing guarantee: a tenant/job can choose voiceover, music, or
 * both, and a voiceover choice never yields a silent reel when the deployment
 * voiceover capability is off/absent (it degrades to the music bed).
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/reel-audio-mode.test.ts
 */

test('parseReelAudioMode normalizes canonical values + friendly aliases', () => {
  assert.equal(parseReelAudioMode('music'), 'music');
  assert.equal(parseReelAudioMode('MUSIC'), 'music');
  assert.equal(parseReelAudioMode('  music_only '), 'music');
  assert.equal(parseReelAudioMode('voiceover'), 'voiceover');
  assert.equal(parseReelAudioMode('vo'), 'voiceover');
  assert.equal(parseReelAudioMode('voice-over'), 'voiceover');
  assert.equal(parseReelAudioMode('both'), 'both');
  assert.equal(parseReelAudioMode('voiceover+music'), 'both');
});

test('parseReelAudioMode returns null for absent / unrecognized values', () => {
  assert.equal(parseReelAudioMode(''), null);
  assert.equal(parseReelAudioMode('   '), null);
  assert.equal(parseReelAudioMode('loud'), null);
  assert.equal(parseReelAudioMode(null), null);
  assert.equal(parseReelAudioMode(undefined), null);
  assert.equal(parseReelAudioMode(3), null);
  assert.equal(parseReelAudioMode({}), null);
});

test('wants-helpers map each mode to the right layers', () => {
  assert.equal(reelAudioModeWantsVoiceover('music'), false);
  assert.equal(reelAudioModeWantsVoiceover('voiceover'), true);
  assert.equal(reelAudioModeWantsVoiceover('both'), true);

  assert.equal(reelAudioModeWantsMusic('music'), true);
  assert.equal(reelAudioModeWantsMusic('voiceover'), false);
  assert.equal(reelAudioModeWantsMusic('both'), true);
});

test('resolveReelAudioMode applies job-override > tenant-default > global-default', () => {
  // Global default when nothing is set.
  assert.equal(resolveReelAudioMode({}), DEFAULT_REEL_AUDIO_MODE);
  assert.equal(resolveReelAudioMode({}), 'music');

  // Tenant default applies when there is no job override.
  assert.equal(resolveReelAudioMode({ tenantDefault: 'voiceover' }), 'voiceover');

  // Job override wins over the tenant default.
  assert.equal(
    resolveReelAudioMode({ jobOverride: 'both', tenantDefault: 'voiceover' }),
    'both',
  );

  // Unparseable values at a level are skipped, not treated as a choice.
  assert.equal(
    resolveReelAudioMode({ jobOverride: 'garbage', tenantDefault: 'voiceover' }),
    'voiceover',
  );
  assert.equal(
    resolveReelAudioMode({ jobOverride: '', tenantDefault: 'bogus' }),
    'music',
  );
});

test('composition: music mode is always music bed only (no VO synthesis path)', () => {
  const plan = resolveReelAudioComposition({
    mode: 'music',
    voiceoverEnabled: true,
    hasVoiceoverKey: true,
    voiceoverSucceeded: false,
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: false, useMusic: true, duckMusic: false });
});

test('composition: voiceover mode + VO available + ok => voiceover only', () => {
  const plan = resolveReelAudioComposition({
    mode: 'voiceover',
    voiceoverEnabled: true,
    hasVoiceoverKey: true,
    voiceoverSucceeded: true,
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: true, useMusic: false, duckMusic: false });
});

test('composition: voiceover mode falls back to music when capability is OFF', () => {
  const plan = resolveReelAudioComposition({
    mode: 'voiceover',
    voiceoverEnabled: false, // deployment flag off
    hasVoiceoverKey: true,
    voiceoverSucceeded: false,
    musicBedAvailable: true,
  });
  // Never silent: a wanted-but-unavailable voiceover degrades to the music bed.
  assert.deepEqual(plan, { useVoiceover: false, useMusic: true, duckMusic: false });
});

test('composition: voiceover mode falls back to music when the key is absent', () => {
  const plan = resolveReelAudioComposition({
    mode: 'voiceover',
    voiceoverEnabled: true,
    hasVoiceoverKey: false,
    voiceoverSucceeded: false,
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: false, useMusic: true, duckMusic: false });
});

test('composition: voiceover mode falls back to music when synthesis fails', () => {
  const plan = resolveReelAudioComposition({
    mode: 'voiceover',
    voiceoverEnabled: true,
    hasVoiceoverKey: true,
    voiceoverSucceeded: false, // ElevenLabs returned null / errored
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: false, useMusic: true, duckMusic: false });
});

test('composition: both mode + VO ok => voiceover ducked over music', () => {
  const plan = resolveReelAudioComposition({
    mode: 'both',
    voiceoverEnabled: true,
    hasVoiceoverKey: true,
    voiceoverSucceeded: true,
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: true, useMusic: true, duckMusic: true });
});

test('composition: both mode + VO unavailable => music bed only', () => {
  const plan = resolveReelAudioComposition({
    mode: 'both',
    voiceoverEnabled: false,
    hasVoiceoverKey: true,
    voiceoverSucceeded: false,
    musicBedAvailable: true,
  });
  assert.deepEqual(plan, { useVoiceover: false, useMusic: true, duckMusic: false });
});

test('composition: no music bed on disk => voiceover-only when VO ok, else silent', () => {
  // VO succeeded but no bed => voiceover only.
  assert.deepEqual(
    resolveReelAudioComposition({
      mode: 'both',
      voiceoverEnabled: true,
      hasVoiceoverKey: true,
      voiceoverSucceeded: true,
      musicBedAvailable: false,
    }),
    { useVoiceover: true, useMusic: false, duckMusic: false },
  );

  // music mode but no bed on disk => nothing to mux (silent video, caller keeps it).
  assert.deepEqual(
    resolveReelAudioComposition({
      mode: 'music',
      voiceoverEnabled: false,
      hasVoiceoverKey: false,
      voiceoverSucceeded: false,
      musicBedAvailable: false,
    }),
    { useVoiceover: false, useMusic: false, duckMusic: false },
  );
});
