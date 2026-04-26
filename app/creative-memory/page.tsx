'use client';

import { useMemo, useState } from 'react';

const lifecycle = ['Observed', 'Analyzed', 'Suggested', 'Approved for generation', 'Archived'];
const labels = ['useful', 'not_useful', 'needs_changes', 'approved', 'rejected', 'used_in_campaign', 'winner', 'loser'];

const defaultBrief = {
  objective: 'lead magnet signups',
  platform: 'instagram',
  placement: 'feed',
  aspectRatio: '4:5',
  funnelStage: 'TOFU',
  offer: 'Free AI workflow checklist',
  audience: 'operations managers at small teams',
  creativeType: 'native educational image',
  cta: 'Get the free checklist',
  imageText: ['Your AI tools aren’t the problem.', 'Your workflows are.', 'Get the free checklist'],
  mustAvoidAesthetics: ['robots', 'purple gradients', 'fake dashboards'],
};

type ApiState = 'idle' | 'loading' | 'ready' | 'error';
type GeneratedCandidate = { id: string; variantKind: 'baseline' | 'memory_assisted'; promptText: string; learningLifecycle: string; reviewStatus: string; creativeAssetId?: string | null };

type PromptRecipeState = {
  canGenerate?: boolean;
  blockingReason?: string;
  baselinePrompt?: string;
  compiledPrompt?: string;
  negativePrompt?: string;
  tokenEstimate?: number;
  excludedCandidateCount?: number;
  contextPack?: {
    status?: 'ready' | 'competitor_only' | 'insufficient_memory';
    selectedStyleCards?: Array<{ id: string; name: string; selectionReason: string; confidenceScore?: number }>;
    selectedExamples?: Array<{ id?: string; selectionReason: string; sourceType?: string; permissionScope?: string; servedAssetRef?: string | null }>;
    marketPatternNotes?: Array<{ id: string; pattern: string; allowedUse?: string; sourceLabel?: string }>;
    excludedCandidates?: Array<{ reason: string; id?: string }>;
  };
};

async function requestJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json.status !== 'ok') {
    throw new Error(json.message ?? json.reason ?? 'Creative Memory request failed.');
  }
  return json.data as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> { return requestJson<T>(url, 'POST', body); }
async function patchJson<T>(url: string, body: unknown): Promise<T> { return requestJson<T>(url, 'PATCH', body); }

export default function CreativeMemoryPage() {
  const [apiState, setApiState] = useState<ApiState>('idle');
  const [brief, setBrief] = useState(defaultBrief);
  const [recipe, setRecipe] = useState<PromptRecipeState | null>(null);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);
  const [generatedCandidates, setGeneratedCandidates] = useState<GeneratedCandidate[]>([]);
  const [selectedGeneratedAssetId, setSelectedGeneratedAssetId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState('approved');
  const [message, setMessage] = useState<string>('Ready to inspect retrieved context.');

  const textPreview = useMemo(() => brief.imageText.join(' · '), [brief.imageText]);
  const canGenerate = recipe?.canGenerate === true && recipe?.contextPack?.status === 'ready';
  function updateBrief(field: keyof typeof defaultBrief, value: string) {
    setBrief((current) => ({ ...current, [field]: value }));
    setRecipe(null);
    setSavedRecipeId(null);
    setGeneratedCandidates([]);
    setSelectedGeneratedAssetId(null);
  }

  async function previewPrompt() {
    setApiState('loading');
    setMessage('Compiling baseline vs memory-assisted prompt preview…');
    try {
      const data = await postJson<{ promptRecipe: PromptRecipeState }>('/api/creative-memory/prompt-recipes/preview', { brief });
      setRecipe(data.promptRecipe);
      setApiState('ready');
      setMessage(data.promptRecipe.canGenerate ? 'Prompt Preview ready. Inspect evidence, exclusions, and token budget before generation.' : (data.promptRecipe.blockingReason ?? 'Creative Memory is not ready for generation yet.'));
    } catch (error) {
      setApiState('error');
      setMessage(error instanceof Error ? error.message : 'Prompt preview failed.');
    }
  }

  async function saveRecipe() {
    setApiState('loading');
    setMessage('Saving prompt recipe with relational provenance…');
    try {
      const data = await postJson<{ promptRecipe: { id: string; preview: PromptRecipeState } }>('/api/creative-memory/prompt-recipes', { brief });
      setSavedRecipeId(data.promptRecipe.id);
      setRecipe(data.promptRecipe.preview);
      setApiState('ready');
      setGeneratedCandidates([]);
      setSelectedGeneratedAssetId(null);
      setMessage(`Saved prompt recipe ${data.promptRecipe.id}. Generate baseline and memory candidates next.`);
    } catch (error) {
      setApiState('error');
      setMessage(error instanceof Error ? error.message : 'Saving prompt recipe failed.');
    }
  }

  async function generateCandidates() {
    if (!savedRecipeId) { setApiState('error'); setMessage('Save a prompt recipe before generating candidates.'); return; }
    setApiState('loading');
    setMessage('Creating baseline and memory-assisted generated candidates…');
    try {
      const data = await postJson<{ generatedAssets: GeneratedCandidate[] }>('/api/creative-memory/generated-assets', { promptRecipeId: savedRecipeId });
      setGeneratedCandidates(data.generatedAssets);
      setSelectedGeneratedAssetId(data.generatedAssets.find((candidate) => candidate.variantKind === 'memory_assisted')?.id ?? data.generatedAssets[0]?.id ?? null);
      setApiState('ready');
      setMessage('Generated candidate loop ready. Review baseline vs memory-assisted, then approve or label the winner.');
    } catch (error) {
      setApiState('error');
      setMessage(error instanceof Error ? error.message : 'Candidate generation failed.');
    }
  }

  async function reviewCandidate(candidate: GeneratedCandidate, reviewStatus: 'approved' | 'rejected' | 'changes_requested') {
    setApiState('loading');
    setSelectedGeneratedAssetId(candidate.id);
    setMessage(`Saving ${candidate.variantKind} review decision…`);
    try {
      const data = await patchJson<{ review: { id: string; reviewStatus: string; learningLifecycle: string } }>('/api/creative-memory/generated-assets', { generatedAssetId: candidate.id, reviewStatus, note: `Operator marked ${candidate.variantKind} as ${reviewStatus}` });
      setGeneratedCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, reviewStatus: data.review.reviewStatus, learningLifecycle: data.review.learningLifecycle } : item));
      setApiState('ready');
      setMessage(`${candidate.variantKind} candidate review saved: ${reviewStatus}.`);
    } catch (error) {
      setApiState('error');
      setMessage(error instanceof Error ? error.message : 'Candidate review failed.');
    }
  }

  async function submitLabel() {
    setApiState('loading');
    setMessage('Writing manual outcome label…');
    try {
      const labelTargetId = selectedGeneratedAssetId ?? savedRecipeId;
      if (!labelTargetId) throw new Error('Save a recipe or select a generated candidate before labeling.');
      await postJson<{ label: { id: string } }>('/api/creative-memory/outcome-labels', {
        idempotencyKey: `creative-memory-ui-${selectedGeneratedAssetId ? 'generated' : 'recipe'}-${labelTargetId}-${selectedLabel}`,
        label: selectedLabel,
        promptRecipeId: selectedGeneratedAssetId ? undefined : savedRecipeId ?? undefined,
        generatedAssetId: selectedGeneratedAssetId ?? undefined,
        source: 'creative_memory_operator_ui',
      });
      setApiState('ready');
      setMessage(`Learning label saved: ${selectedLabel}.`);
    } catch (error) {
      setApiState('error');
      setMessage(error instanceof Error ? error.message : 'Outcome label failed.');
    }
  }

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
        <div className="rounded-[2rem] border border-cyan-400/20 bg-slate-950/80 p-8 shadow-2xl shadow-cyan-950/30">
          <p className="text-xs font-semibold uppercase tracking-[0.4em] text-cyan-300">Creative Memory</p>
          <div className="mt-4 grid gap-6 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
            <div>
              <h1 className="text-4xl font-semibold tracking-tight text-white md:text-6xl">Campaign Learning</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-300">
                Prove each campaign gets sharper: inspect retrieved memory, compare baseline vs memory-assisted prompts, approve the selected pattern, review results, and write outcome labels back into Aries.
              </p>
            </div>
            <div className="rounded-3xl border border-slate-700 bg-slate-900/80 p-5" aria-label="Memory trust lifecycle">
              <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Trust lifecycle</h2>
              <ol className="mt-4 space-y-2 text-sm text-slate-200">
                {lifecycle.map((step, index) => (
                  <li key={step} className="flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-300/10 text-xs text-cyan-200">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>

        <div className={`rounded-2xl border p-4 text-sm ${apiState === 'error' ? 'border-red-400/40 bg-red-950/40 text-red-100' : 'border-cyan-400/20 bg-cyan-400/10 text-cyan-100'}`} role="status" aria-live="polite">
          {message}
        </div>

        <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]" aria-label="Golden path">
          <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6">
            <h2 className="text-2xl font-semibold">Campaign brief</h2>
            <p className="mt-2 text-sm text-slate-400">Select a campaign, choose a brief, then let Aries retrieve only the memory that matters.</p>
            <div className="mt-5 grid gap-4">
              {[
                ['Objective', brief.objective],
                ['Platform / placement', `${brief.platform} ${brief.placement} · ${brief.aspectRatio}`],
                ['Audience', brief.audience],
                ['Offer', brief.offer],
                ['Exact image text', textPreview],
              ].map(([label, value]) => (
                <label key={label} className="block rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                  <span className="text-xs uppercase tracking-[0.22em] text-slate-500">{label}</span>
                  <input value={String(value)} onChange={(event) => {
                    const key = label === 'Objective' ? 'objective' : label === 'Audience' ? 'audience' : label === 'Offer' ? 'offer' : undefined;
                    if (key) updateBrief(key as keyof typeof defaultBrief, event.target.value);
                  }} readOnly={!['Objective','Audience','Offer'].includes(label)} className="mt-1 block w-full bg-transparent text-base text-white outline-none read-only:cursor-default" />
                </label>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button onClick={previewPrompt} className="rounded-full bg-cyan-300 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-100" disabled={apiState === 'loading'}>Preview Prompt</button>
              <button onClick={saveRecipe} className="rounded-full border border-cyan-300/40 px-5 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-cyan-100" disabled={apiState === 'loading' || (recipe ? !canGenerate : false)}>Approve & Save Recipe</button>
            </div>
          </div>

          <div className="rounded-3xl border border-cyan-500/20 bg-slate-950 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">Prompt Preview</h2>
                <p className="mt-2 text-sm text-slate-400">Baseline vs memory-assisted output before generation. No black-box context stuffing.</p>
              </div>
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">{recipe ? (canGenerate ? 'Ready to generate' : `Blocked: ${recipe.contextPack?.status ?? 'not ready'}`) : 'Ready to compile'}</span>
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <h3 className="font-semibold text-slate-200">Baseline prompt</h3>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-400">{recipe?.baselinePrompt ?? 'Brand colors + offer + audience + ad concept. Useful, but generic.'}</pre>
              </article>
              <article className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-4">
                <h3 className="font-semibold text-cyan-100">Memory-assisted prompt</h3>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-sm leading-6 text-cyan-50/80">{recipe?.compiledPrompt ?? 'Brand rules + approved pattern + selected examples + exclusions + exact image text.'}</pre>
              </article>
            </div>
            <div className="mt-5 rounded-2xl border border-slate-800 bg-black/30 p-4 text-sm text-slate-300">
              <p className="font-semibold text-white">Context status: {recipe?.contextPack?.status ?? 'not compiled'} · Selected pattern: {recipe?.contextPack?.selectedStyleCards?.[0]?.name ?? 'Native educational operator note'}</p>
              {recipe?.blockingReason ? <p className="mt-2 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-100">{recipe.blockingReason}</p> : null}
              <p className="mt-2">Excluded candidates: {recipe?.excludedCandidateCount ?? recipe?.contextPack?.excludedCandidates?.length ?? 'competitor direct examples, archived cards, unsafe permissions, and stale rejected outputs'}.</p>
              <p className="mt-2">Token budget: {recipe?.tokenEstimate ? `${recipe.tokenEstimate} estimated tokens` : '1,500–3,500 target'} · competitor notes abstract-only · provenance attached.</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div><p className="font-semibold text-slate-100">Selected examples</p><ul className="mt-2 space-y-1 text-xs text-slate-400">{(recipe?.contextPack?.selectedExamples ?? []).map((example) => <li key={example.id ?? example.selectionReason}>{example.sourceType} · {example.permissionScope} · {example.selectionReason}</li>)}</ul></div>
                <div><p className="font-semibold text-slate-100">Abstract market notes</p><ul className="mt-2 space-y-1 text-xs text-slate-400">{(recipe?.contextPack?.marketPatternNotes ?? []).map((note) => <li key={note.id}>{note.sourceLabel ?? 'market'} · {note.allowedUse ?? 'abstract_only'} · {note.pattern}</li>)}</ul></div>
              </div>
              <p className="mt-2 text-slate-400">Negative prompt: {recipe?.negativePrompt ?? 'NO competitor logos. NO direct visual imitation. NO extra text.'}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-3" aria-label="Review loop">
          {[
            ['Inspect retrieved context', 'View selected pattern, examples, excluded candidates, permissions, and why each signal was chosen.'],
            ['Generate two variants', 'Create baseline and memory-assisted variants for the same brief so improvement is visible.'],
            ['Review and label outcome', 'Approve, reject, regenerate, mark used in campaign, or label winner/loser for learning.'],
          ].map(([title, body]) => (
            <article key={title} className="rounded-3xl border border-slate-800 bg-slate-950 p-6">
              <h2 className="text-xl font-semibold">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">{body}</p>
            </article>
          ))}
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-950 p-6" aria-label="Generated candidate loop">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Generated candidates: baseline vs memory-assisted</h2>
              <p className="mt-2 text-sm text-slate-400">Both candidates use the same saved recipe provenance, so the comparison is about memory quality, not a changed brief.</p>
            </div>
            <button onClick={generateCandidates} className="rounded-full bg-violet-300 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-violet-200 focus:outline-none focus:ring-2 focus:ring-violet-100" disabled={apiState === 'loading' || !savedRecipeId || !canGenerate}>Generate baseline + memory candidates</button>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {generatedCandidates.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">Save a recipe, then generate two candidate records before image handoff.</p>
            ) : generatedCandidates.map((candidate) => (
              <article key={candidate.id} className={`rounded-2xl border p-4 ${candidate.variantKind === 'memory_assisted' ? 'border-cyan-400/40 bg-cyan-400/10' : 'border-slate-800 bg-slate-900/70'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-white">{candidate.variantKind === 'memory_assisted' ? 'Memory-assisted candidate' : 'Baseline candidate'}</h3>
                  <button onClick={() => setSelectedGeneratedAssetId(candidate.id)} className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200">{selectedGeneratedAssetId === candidate.id ? 'Selected for label' : 'Select for label'}</button>
                </div>
                <p className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-500">{candidate.reviewStatus} · {candidate.learningLifecycle} · {candidate.creativeAssetId ? 'materialized asset linked' : 'image handoff pending'}</p>
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-300">{candidate.promptText}</pre>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button onClick={() => reviewCandidate(candidate, 'approved')} disabled={!candidate.creativeAssetId} title={!candidate.creativeAssetId ? 'Approval unlocks future retrieval after image generation handoff attaches a creativeAssetId.' : undefined} className="rounded-full bg-emerald-300 px-3 py-1 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">Approve candidate</button>
                  <button onClick={() => reviewCandidate(candidate, 'changes_requested')} className="rounded-full border border-amber-300/50 px-3 py-1 text-xs font-semibold text-amber-100">Needs changes</button>
                  <button onClick={() => reviewCandidate(candidate, 'rejected')} className="rounded-full border border-red-300/50 px-3 py-1 text-xs font-semibold text-red-100">Reject</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-950 p-6" aria-label="Manual outcome labels">
          <h2 className="text-2xl font-semibold">Manual outcome labels feed learning before ad performance exists</h2>
          <p className="mt-2 text-sm text-slate-400">Current label target: {selectedGeneratedAssetId ? `generated candidate ${selectedGeneratedAssetId}` : savedRecipeId ? `prompt recipe ${savedRecipeId}` : 'save a recipe or candidate first'}.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <select value={selectedLabel} onChange={(event) => setSelectedLabel(event.target.value)} className="rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-100" aria-label="Outcome label">
              {labels.map((label) => <option key={label} value={label}>{label}</option>)}
            </select>
            <button onClick={submitLabel} className="rounded-full bg-emerald-300 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-100" disabled={apiState === 'loading'}>Save Outcome Label</button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {labels.map((label) => <span key={label} className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-sm text-slate-300">{label}</span>)}
          </div>
        </section>
      </section>
    </main>
  );
}
