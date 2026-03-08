# Marketing Skills Pipeline

A complete AI-powered marketing workflow from competitor research to campaign launch.

## The Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MARKETING SKILLS PIPELINE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STAGE 1: RESEARCH                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  /ads_analyst                                                        │    │
│  │  Orchestrates competitive research                                   │    │
│  │  ├── /meta_ads_extractor    → Download competitor ad creatives      │    │
│  │  ├── /meta_ads_analyser     → Generate strategy report              │    │
│  │  ├── /ad_creative_analysis  → Deep-dive individual ads              │    │
│  │  └── /landing_page_analysis → Analyze destination pages             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      ↓                                       │
│  STAGE 2: STRATEGY                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  /head_of_marketing                                                  │    │
│  │  Orchestrates brand analysis + campaign planning                     │    │
│  │  ├── /website_brand_analysis → Brand bible + design system          │    │
│  │  └── /campaign_planner       → Funnel strategy + creative briefs    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      ↓                                       │
│  STAGE 3: PRODUCTION                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  /creative_director                                                  │    │
│  │  Orchestrates asset creation                                         │    │
│  │  ├── /ad_designer    → Generate image ad creatives                  │    │
│  │  ├── /scriptwriter   → Write video ad scripts                       │    │
│  │  └── /page_designer  → Build landing pages                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      ↓                                       │
│  STAGE 4: PUBLISH & OPTIMIZE                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  /performance_marketer                                               │    │
│  │  Orchestrates publishing and optimization                            │    │
│  │  └── /meta_ads_publisher → Create campaigns (PAUSED for review)     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

**Full pipeline (recommended):**
```
/ads_analyst {competitor}
```
This starts the complete flow. After research, it prompts you to continue with your brand.

**Individual stages:**
```
/ads_analyst {competitor}           # Just competitor research
/head_of_marketing {your-site}      # Brand + campaign (needs competitor context)
/creative_director                   # Build assets (needs approved proposal)
```

## Orchestrators vs Sub-Skills

### Orchestrators (run these)
| Skill | Purpose | Triggers |
|-------|---------|----------|
| `/ads_analyst` | Competitor research | Entry point for full pipeline |
| `/head_of_marketing` | Brand + campaign | Called by ads_analyst |
| `/creative_director` | Asset production | Called by head_of_marketing |
| `/performance_marketer` | Publish + optimize | Called by creative_director |

### Sub-Skills (called by orchestrators)
| Skill | Purpose | Called By |
|-------|---------|-----------|
| `/meta_ads_extractor` | Extract ad creatives | ads_analyst |
| `/meta_ads_analyser` | Strategy report | ads_analyst |
| `/ad_creative_analysis` | Individual ad breakdown | ads_analyst |
| `/landing_page_analysis` | Landing page analysis | ads_analyst |
| `/website_brand_analysis` | Brand bible | head_of_marketing |
| `/campaign_planner` | Campaign proposal | head_of_marketing |
| `/ad_designer` | Image ads | creative_director |
| `/scriptwriter` | Video scripts | creative_director |
| `/page_designer` | Landing pages | creative_director |
| `/meta_ads_publisher` | Publish to Meta | Final stage |

## Output Structure

```
output/
├── meta-ads/{competitor}/           # From ads_analyst
│   ├── assets/
│   ├── deep-dives/
│   ├── landing-pages/
│   ├── {competitor}-analysis.html
│   └── MASTER-REPORT.md
│
├── {brand}-brand-bible.md           # From head_of_marketing
├── {brand}-design-system.css        # From head_of_marketing
├── {brand}-campaign-proposal.md     # From head_of_marketing
├── {brand}-campaign-proposal.html   # From head_of_marketing
│
└── {brand}-campaign/                # From creative_director
    ├── landing-pages/
    ├── ad-images/
    ├── scripts/
    └── CAMPAIGN-ASSETS.md
```

## Checkpoints & Approvals

The pipeline has built-in checkpoints:

1. **After ads_analyst** — Review competitor intel, decide to continue
2. **After brand analysis** — Confirm all pages analyzed
3. **After campaign proposal** — Approve strategy before production
4. **After each asset** — Creative director reviews before showing you
5. **Before publishing** — Final review of all ads (PAUSED in Meta)

## Running Individual Skills

You can run sub-skills directly if needed:

```
/meta_ads_extractor {advertiser}      # Just download creatives
/website_brand_analysis {url}         # Just create brand bible
/ad_creative_analysis {video/image}   # Analyze single ad
/landing_page_analysis {url}          # Analyze single page
```

But for complete workflows, start with `/ads_analyst`.
