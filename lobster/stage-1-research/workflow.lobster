name: stage-1-research
args:
  competitor:
    default: ""
  competitor_facebook_url:
    default: ""
  research_model:
    default: "gemini/gemini-2.5-flash"
  strict_mode:
    default: true
steps:
  - id: meta_ads_extractor
    command: >-
      ./bin/meta-ads-extractor --json
      --competitor "${competitor}"
      --competitor-facebook-url "${competitor_facebook_url}"
      --research-model "${research_model}"
      --strict-mode "${strict_mode}"
  - id: meta_ads_analyser
    command: ./bin/meta-ads-analyser --json
    stdin: $meta_ads_extractor.stdout
  - id: ad_creative_analysis
    command: ./bin/ad-creative-analysis --json
    stdin: $meta_ads_analyser.stdout
  - id: ads_analyst_compile
    command: ./bin/ads-analyst --json --mode compile
    stdin: $ad_creative_analysis.stdout
