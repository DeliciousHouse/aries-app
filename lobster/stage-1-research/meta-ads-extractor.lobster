name: meta-ads-extractor
args:
  competitor:
    default: ""
  competitor_facebook_url:
    default: ""
  research_model:
    default: "gemini/gemini-2.5-flash"
steps:
  - id: run
    command: >-
      ./bin/meta-ads-extractor --json
      --competitor "${competitor}"
      --competitor-facebook-url "${competitor_facebook_url}"
      --research-model "${research_model}"
