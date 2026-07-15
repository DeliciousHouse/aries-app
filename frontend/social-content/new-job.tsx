"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { isValidWebsiteUrl } from "@/lib/api/marketing";
import { humanizeMarketingCreateMessage } from "@/lib/marketing-create-errors";
import { normalizeWebsiteUrlInput } from "@/frontend/marketing/new-job";

const DEFAULT_FORBIDDEN_VISUAL_PATTERNS = [
  "split-screen",
  "before/after",
  "side-by-side comparison",
  "two-panel layout",
  "old way vs new way",
  "generic stock office",
  "fake UI screenshot",
  "garbled text",
  "extra logos",
] as const;

const DEFAULT_PLATFORMS = ["meta", "instagram"] as const;

/**
 * Field-error keys this form renders inline (red box + one-line message under
 * the input). A server fieldError for any other key falls back to the
 * top-level alert so it is never silently dropped (AA-131).
 */
const RENDERED_FIELD_KEYS = new Set(["websiteUrl", "businessType", "weeklyGoal", "competitorUrl"]);

const INPUT_BASE_CLASSNAME =
  "w-full rounded-2xl border px-4 py-3 text-white placeholder:text-white/30 focus:outline-none";

/** Red box treatment for an input that needs the operator's attention. */
function inputClassName(hasError: boolean): string {
  return hasError
    ? `${INPUT_BASE_CLASSNAME} border-red-500/60 bg-red-500/10 focus:border-red-400`
    : `${INPUT_BASE_CLASSNAME} border-white/10 bg-white/5 focus:border-primary/50`;
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readServerFieldErrors(body: unknown): Record<string, string> {
  const fieldErrors = (body as { fieldErrors?: unknown })?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object" || Array.isArray(fieldErrors)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) {
      out[key] = value;
    }
  }
  return out;
}

type SocialContentCreateResponse = {
  jobId: string;
};

export interface SocialContentNewJobScreenProps {
  embedded?: boolean;
}

export interface SocialContentNewJobScreenContentProps extends SocialContentNewJobScreenProps {
  router: {
    push: (href: string) => void;
  };
}

export function SocialContentNewJobScreenContent(props: SocialContentNewJobScreenContentProps) {
  const router = props.router;

  const [websiteUrl, setWebsiteUrl] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState("");

  const [weeklyGoal, setWeeklyGoal] = useState("");
  const [offerOrCta, setOfferOrCta] = useState("");
  const [audience, setAudience] = useState("");

  const [brandVoice, setBrandVoice] = useState("");
  const [visualStyle, setVisualStyle] = useState("");
  const [visualReferences, setVisualReferences] = useState("");
  const [brandAssets, setBrandAssets] = useState<File[]>([]);

  const [competitorUrl, setCompetitorUrl] = useState("");
  const [facebookPageUrl, setFacebookPageUrl] = useState("");
  const [adLibraryUrl, setAdLibraryUrl] = useState("");

  const [mustUseCopy, setMustUseCopy] = useState("");
  const [mustAvoidAesthetics, setMustAvoidAesthetics] = useState("");
  const [forbiddenVisualPatterns, setForbiddenVisualPatterns] = useState(
    DEFAULT_FORBIDDEN_VISUAL_PATTERNS.join("\n"),
  );

  const [staticPostCount, setStaticPostCount] = useState(7);
  // Image-story posts to publish alongside feed posts. Default 1 (ON); 0 = OFF.
  const [storyCount, setStoryCount] = useState(1);
  const [imageCreativeCount, setImageCreativeCount] = useState(6);
  const [videoScriptCount, setVideoScriptCount] = useState(1);
  const [renderVideoAfterApproval, setRenderVideoAfterApproval] = useState(false);
  // Per-job reel audio override. "" = use the account default set in Settings;
  // an explicit value overrides it for this job only.
  const [reelAudioMode, setReelAudioMode] = useState("");
  const [postWindowDays, setCampaignWindowDays] = useState(7);
  const [platforms, setPlatforms] = useState<string[]>([...DEFAULT_PLATFORMS]);

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Per-field errors (client validation or server fieldErrors) rendered as a
  // red box + one-line message under the input that needs attention (AA-131).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Bumped per submit attempt so the scroll-to-first-error effect re-runs even
  // when the same field fails twice in a row.
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Scroll+focus the first errored field at most ONCE per submit attempt —
  // when its errors first appear (synchronously for client validation, after
  // the response for server fieldErrors). Without the attempt guard,
  // dismiss-on-edit would shrink fieldErrorCount and re-fire this effect,
  // stealing focus to the next errored field while the operator is typing.
  const fieldErrorCount = Object.keys(fieldErrors).length;
  const lastScrolledAttempt = useRef(0);
  useEffect(() => {
    if (fieldErrorCount === 0 || lastScrolledAttempt.current === submitAttempt) {
      return;
    }
    const firstInvalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!firstInvalid) {
      return;
    }
    lastScrolledAttempt.current = submitAttempt;
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    firstInvalid.focus({ preventScroll: true });
  }, [submitAttempt, fieldErrorCount]);

  const dismissFieldError = (key: string) => {
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const wrapperClassName = props.embedded
    ? "space-y-6"
    : "min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10";
  const contentClassName = props.embedded ? "grid gap-6" : "max-w-5xl mx-auto grid gap-6";

  function togglePlatform(slug: string) {
    setPlatforms((current) => {
      if (current.includes(slug)) {
        return current.filter((entry) => entry !== slug);
      }
      return [...current, slug];
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);
    setSubmitAttempt((current) => current + 1);

    // Aggregate every failing field so each missing input gets its own inline
    // red box + one-line message instead of one top-level alert at a time.
    const errors: Record<string, string> = {};
    const normalizedWebsiteUrl = normalizeWebsiteUrlInput(websiteUrl);
    if (!normalizedWebsiteUrl) {
      errors.websiteUrl = "Website URL is required.";
    } else if (!isValidWebsiteUrl(normalizedWebsiteUrl)) {
      errors.websiteUrl = "Website URL must look like https://example.com.";
    }
    if (!businessType.trim()) {
      errors.businessType = "Business type is required.";
    }
    if (!weeklyGoal.trim()) {
      errors.weeklyGoal = "Weekly goal is required.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const formData = new FormData();
    formData.set("jobType", "weekly_social_content");
    formData.set("brandUrl", normalizedWebsiteUrl);
    formData.set("websiteUrl", normalizedWebsiteUrl);
    formData.set("businessName", businessName.trim());
    formData.set("businessType", businessType.trim());
    formData.set("primaryGoal", weeklyGoal.trim());
    formData.set("goal", weeklyGoal.trim());
    formData.set("offer", offerOrCta.trim());
    formData.set("audience", audience.trim());

    formData.set("brandVoice", brandVoice.trim());
    formData.set("styleVibe", visualStyle.trim());
    for (const reference of splitLines(visualReferences)) {
      formData.append("visualReferences", reference);
    }
    for (const asset of brandAssets) {
      formData.append("brandAssets", asset);
    }

    formData.set("competitorUrl", competitorUrl.trim());
    formData.set("facebookPageUrl", facebookPageUrl.trim());
    formData.set("adLibraryUrl", adLibraryUrl.trim());

    formData.set("mustUseCopy", mustUseCopy.trim());
    formData.set("mustAvoidAesthetics", mustAvoidAesthetics.trim());
    for (const pattern of splitLines(forbiddenVisualPatterns)) {
      formData.append("forbiddenVisualPatterns", pattern);
    }

    const boundedWindowDays = Math.min(14, Math.max(1, postWindowDays || 7));
    formData.set("postWindowDays", String(boundedWindowDays));
    formData.set("staticPostCount", String(Math.max(0, staticPostCount)));
    formData.set("storyCount", String(Math.max(0, storyCount)));
    formData.set("imageCreativeCount", String(Math.max(0, imageCreativeCount)));
    formData.set("videoScriptCount", String(Math.max(0, videoScriptCount)));
    formData.set("videoRenderCount", renderVideoAfterApproval ? "1" : "0");
    formData.set("renderVideoAfterApproval", renderVideoAfterApproval ? "true" : "false");
    // Only send an override when the operator picked one; otherwise the
    // per-tenant Settings default applies at reel ingest time.
    if (renderVideoAfterApproval && reelAudioMode) {
      formData.set("reelAudioMode", reelAudioMode);
    }
    for (const platform of platforms) {
      formData.append("channels", platform);
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/social-content/jobs", {
        method: "POST",
        body: formData,
      });

      let body: unknown = null;
      try {
        body = (await response.json()) as unknown;
      } catch {}

      if (!response.ok) {
        // Structured fieldErrors from the jobs handler pin the failure to the
        // exact input (red box + one-line message); the alert only carries
        // copy for fields this form does not render, or unmapped failures.
        const serverFieldErrors = readServerFieldErrors(body);
        const rendered = Object.entries(serverFieldErrors).filter(([key]) => RENDERED_FIELD_KEYS.has(key));
        const unrendered = Object.entries(serverFieldErrors).filter(([key]) => !RENDERED_FIELD_KEYS.has(key));
        if (rendered.length > 0) {
          setFieldErrors(Object.fromEntries(rendered));
        }
        if (unrendered.length > 0) {
          setErrorText([...new Set(unrendered.map(([, copy]) => copy))].join(" "));
        } else if (rendered.length === 0) {
          const message =
            typeof (body as { message?: unknown })?.message === "string"
              ? (body as { message: string }).message
              : typeof (body as { error?: unknown })?.error === "string"
                ? (body as { error: string }).error
                : "Failed to create weekly social posts.";
          setErrorText(humanizeMarketingCreateMessage(message));
        }
        return;
      }

      const data = body as SocialContentCreateResponse | null;
      const jobId = data?.jobId;
      if (!jobId) {
        throw new Error("Missing job id in response.");
      }

      router.push(`/social-content/status?jobId=${encodeURIComponent(jobId)}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to create weekly social posts.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={wrapperClassName}>
      <div className={contentClassName}>
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="mb-3 text-xs uppercase tracking-[0.3em] text-violet-300">Weekly social content</p>
          <h1 className="mb-3 text-4xl font-bold">Create my weekly social posts</h1>
          <p className="text-white/60">
            Share a few details and Aries will prepare your weekly social content plan.
          </p>
        </div>

        <div className="glass rounded-[2.5rem] p-8">
          <form ref={formRef} onSubmit={onSubmit} className="space-y-8">
            <Section title="Brand">
              <Field label="Website URL" required>
                <input
                  value={websiteUrl}
                  onChange={(event) => {
                    setWebsiteUrl(event.target.value);
                    dismissFieldError("websiteUrl");
                  }}
                  onBlur={() => setWebsiteUrl(normalizeWebsiteUrlInput(websiteUrl))}
                  placeholder="https://yourbusiness.com"
                  aria-invalid={fieldErrors.websiteUrl ? true : undefined}
                  aria-describedby={fieldErrors.websiteUrl ? "website-url-error" : undefined}
                  className={inputClassName(!!fieldErrors.websiteUrl)}
                />
                {fieldErrors.websiteUrl ? (
                  <p id="website-url-error" className="mt-2 text-sm text-red-300">{fieldErrors.websiteUrl}</p>
                ) : null}
              </Field>
              <Field label="Business name">
                <input
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder="Acme Studio"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Business type" required>
                <input
                  value={businessType}
                  onChange={(event) => {
                    setBusinessType(event.target.value);
                    dismissFieldError("businessType");
                  }}
                  placeholder="Fitness studio, SaaS, local service..."
                  aria-invalid={fieldErrors.businessType ? true : undefined}
                  aria-describedby={fieldErrors.businessType ? "business-type-error" : undefined}
                  className={inputClassName(!!fieldErrors.businessType)}
                />
                {fieldErrors.businessType ? (
                  <p id="business-type-error" className="mt-2 text-sm text-red-300">{fieldErrors.businessType}</p>
                ) : null}
              </Field>
            </Section>

            <Section title="Weekly goal">
              <Field label="What should this week’s posts help with?" required>
                <textarea
                  value={weeklyGoal}
                  onChange={(event) => {
                    setWeeklyGoal(event.target.value);
                    dismissFieldError("weeklyGoal");
                  }}
                  rows={3}
                  placeholder="Get more consultation calls, promote a launch, book demos..."
                  aria-invalid={fieldErrors.weeklyGoal ? true : undefined}
                  aria-describedby={fieldErrors.weeklyGoal ? "weekly-goal-error" : undefined}
                  className={inputClassName(!!fieldErrors.weeklyGoal)}
                />
                {fieldErrors.weeklyGoal ? (
                  <p id="weekly-goal-error" className="mt-2 text-sm text-red-300">{fieldErrors.weeklyGoal}</p>
                ) : null}
              </Field>
              <Field label="Offer or CTA">
                <input
                  value={offerOrCta}
                  onChange={(event) => setOfferOrCta(event.target.value)}
                  placeholder="Book a demo, claim free audit, join waitlist..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Audience">
                <input
                  value={audience}
                  onChange={(event) => setAudience(event.target.value)}
                  placeholder="Who should these posts resonate with?"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
            </Section>

            <Section title="Style">
              <Field label="Brand voice">
                <textarea
                  value={brandVoice}
                  onChange={(event) => setBrandVoice(event.target.value)}
                  rows={3}
                  placeholder="Friendly, direct, premium, playful..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Visual style">
                <textarea
                  value={visualStyle}
                  onChange={(event) => setVisualStyle(event.target.value)}
                  rows={3}
                  placeholder="Color mood, composition style, photo look..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Visual references">
                <textarea
                  value={visualReferences}
                  onChange={(event) => setVisualReferences(event.target.value)}
                  rows={4}
                  placeholder="Paste one URL or note per line"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Upload brand assets">
                <input
                  type="file"
                  multiple
                  onChange={(event) => setBrandAssets(Array.from(event.target.files || []))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-white"
                />
              </Field>
            </Section>

            <Section title="Competitor inspiration">
              <Field label="Competitor URL">
                <input
                  value={competitorUrl}
                  onChange={(event) => {
                    setCompetitorUrl(event.target.value);
                    dismissFieldError("competitorUrl");
                  }}
                  placeholder="https://competitor.com"
                  aria-invalid={fieldErrors.competitorUrl ? true : undefined}
                  aria-describedby={fieldErrors.competitorUrl ? "competitor-url-error" : undefined}
                  className={inputClassName(!!fieldErrors.competitorUrl)}
                />
                {fieldErrors.competitorUrl ? (
                  <p id="competitor-url-error" className="mt-2 text-sm text-red-300">{fieldErrors.competitorUrl}</p>
                ) : null}
              </Field>
              <Field label="Facebook page URL">
                <input
                  value={facebookPageUrl}
                  onChange={(event) => setFacebookPageUrl(event.target.value)}
                  placeholder="https://www.facebook.com/yourcompetitor"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Ad Library URL">
                <input
                  value={adLibraryUrl}
                  onChange={(event) => setAdLibraryUrl(event.target.value)}
                  placeholder="https://www.facebook.com/ads/library/..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
            </Section>

            <Section title="Guardrails">
              <Field label="Must-use copy">
                <textarea
                  value={mustUseCopy}
                  onChange={(event) => setMustUseCopy(event.target.value)}
                  rows={3}
                  placeholder="Phrases, legal disclaimers, words we need to include..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Must-avoid aesthetics">
                <textarea
                  value={mustAvoidAesthetics}
                  onChange={(event) => setMustAvoidAesthetics(event.target.value)}
                  rows={3}
                  placeholder="Looks and vibes to avoid..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Forbidden visual patterns">
                <textarea
                  value={forbiddenVisualPatterns}
                  onChange={(event) => setForbiddenVisualPatterns(event.target.value)}
                  rows={8}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
            </Section>

            <Section title="Output scope">
              <Field label="Planning window days (1-14)">
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={postWindowDays}
                  onChange={(event) => setCampaignWindowDays(Number(event.target.value || 7))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Static posts">
                <input
                  type="number"
                  min={0}
                  value={staticPostCount}
                  onChange={(event) => setStaticPostCount(Number(event.target.value || 0))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Image stories">
                <input
                  type="number"
                  min={0}
                  value={storyCount}
                  onChange={(event) => setStoryCount(Number(event.target.value || 0))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Image creatives">
                <input
                  type="number"
                  min={0}
                  value={imageCreativeCount}
                  onChange={(event) => setImageCreativeCount(Number(event.target.value || 0))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Video scripts">
                <input
                  type="number"
                  min={0}
                  value={videoScriptCount}
                  onChange={(event) => setVideoScriptCount(Number(event.target.value || 0))}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                />
              </Field>
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-[0.22em] text-white/70">Render video after approval</p>
                <label className="flex items-center gap-3 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={renderVideoAfterApproval}
                    onChange={(event) => setRenderVideoAfterApproval(event.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Enable rendered video output
                </label>
                {renderVideoAfterApproval ? (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs uppercase tracking-[0.22em] text-white/70">Reel audio</p>
                    <select
                      value={reelAudioMode}
                      onChange={(event) => setReelAudioMode(event.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="">Use account default</option>
                      <option value="music">Music only</option>
                      <option value="voiceover">Voiceover only</option>
                      <option value="both">Voiceover + music</option>
                    </select>
                    <p className="text-xs text-white/40">
                      Overrides your Settings default for this job only. Voiceover needs the
                      account voiceover capability turned on; otherwise it falls back to music.
                    </p>
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-[0.22em] text-white/70">Platforms</p>
                <label className="flex items-center gap-3 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={platforms.includes("meta")}
                    onChange={() => togglePlatform("meta")}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Meta
                </label>
                <label className="flex items-center gap-3 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={platforms.includes("instagram")}
                    onChange={() => togglePlatform("instagram")}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Instagram
                </label>
              </div>
            </Section>

            {errorText ? (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100"
              >
                {errorText}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-full bg-gradient-to-r from-primary to-secondary px-6 py-4 text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating weekly posts..." : "Create my weekly social posts"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function SocialContentNewJobScreen(props: SocialContentNewJobScreenProps) {
  const router = useRouter();
  return <SocialContentNewJobScreenContent {...props} router={router} />;
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
      <h2 className="text-lg font-semibold text-white">{props.title}</h2>
      <div className="space-y-4">{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs uppercase tracking-[0.22em] text-white/70">
        {props.label}
        {props.required ? " *" : ""}
      </span>
      {props.children}
    </label>
  );
}
