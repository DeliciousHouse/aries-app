"use client";

import React, { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { isValidWebsiteUrl } from "@/lib/api/marketing";
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

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

  const [staticPostCount, setStaticPostCount] = useState(3);
  const [imageCreativeCount, setImageCreativeCount] = useState(2);
  const [videoScriptCount, setVideoScriptCount] = useState(1);
  const [renderVideoAfterApproval, setRenderVideoAfterApproval] = useState(false);
  const [campaignWindowDays, setCampaignWindowDays] = useState(7);
  const [platforms, setPlatforms] = useState<string[]>([...DEFAULT_PLATFORMS]);

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

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

    const normalizedWebsiteUrl = normalizeWebsiteUrlInput(websiteUrl);
    if (!normalizedWebsiteUrl) {
      setErrorText("Website URL is required.");
      return;
    }
    if (!isValidWebsiteUrl(normalizedWebsiteUrl)) {
      setErrorText("Website URL must look like https://example.com");
      return;
    }
    if (!businessType.trim()) {
      setErrorText("Business type is required.");
      return;
    }
    if (!weeklyGoal.trim()) {
      setErrorText("Weekly goal is required.");
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

    const boundedWindowDays = Math.min(14, Math.max(1, campaignWindowDays || 7));
    formData.set("campaignWindowDays", String(boundedWindowDays));
    formData.set("staticPostCount", String(Math.max(0, staticPostCount)));
    formData.set("imageCreativeCount", String(Math.max(0, imageCreativeCount)));
    formData.set("videoScriptCount", String(Math.max(0, videoScriptCount)));
    formData.set("videoRenderCount", renderVideoAfterApproval ? "1" : "0");
    formData.set("renderVideoAfterApproval", renderVideoAfterApproval ? "true" : "false");
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
        const message =
          typeof (body as { message?: unknown })?.message === "string"
            ? (body as { message: string }).message
            : typeof (body as { error?: unknown })?.error === "string"
              ? (body as { error: string }).error
              : "Failed to create weekly social posts.";
        throw new Error(message);
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
          <p className="mb-3 text-xs uppercase tracking-[0.3em] text-primary">Weekly social content</p>
          <h1 className="mb-3 text-4xl font-bold">Create my weekly social posts</h1>
          <p className="text-white/60">
            Share a few details and Aries will prepare your weekly social content plan.
          </p>
        </div>

        <div className="glass rounded-[2.5rem] p-8">
          <form onSubmit={onSubmit} className="space-y-8">
            <Section title="Brand">
              <Field label="Website URL" required>
                <input
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  onBlur={() => setWebsiteUrl(normalizeWebsiteUrlInput(websiteUrl))}
                  placeholder="https://yourbusiness.com"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
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
                  onChange={(event) => setBusinessType(event.target.value)}
                  placeholder="Fitness studio, SaaS, local service..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>
            </Section>

            <Section title="Weekly goal">
              <Field label="What should this week’s posts help with?" required>
                <textarea
                  value={weeklyGoal}
                  onChange={(event) => setWeeklyGoal(event.target.value)}
                  rows={3}
                  placeholder="Get more consultation calls, promote a launch, book demos..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
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
                  onChange={(event) => setCompetitorUrl(event.target.value)}
                  placeholder="https://competitor.com"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
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
                  value={campaignWindowDays}
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
                <p className="text-xs uppercase tracking-[0.22em] text-white/35">Render video after approval</p>
                <label className="flex items-center gap-3 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={renderVideoAfterApproval}
                    onChange={(event) => setRenderVideoAfterApproval(event.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Enable rendered video output
                </label>
              </div>
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-[0.22em] text-white/35">Platforms</p>
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
      <span className="text-xs uppercase tracking-[0.22em] text-white/35">
        {props.label}
        {props.required ? " *" : ""}
      </span>
      {props.children}
    </label>
  );
}
