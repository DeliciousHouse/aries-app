#!/usr/bin/env bash
# Rename campaign → social content / post (v0.1.13.0 cut 2a)
# Idempotent - safe to run multiple times.
# Run from repo root.

set -uo pipefail

WD="${1:-$(pwd)}"
DIRS="$WD/app $WD/backend $WD/lib $WD/frontend $WD/components $WD/hooks"

echo "Working directory: $WD"

# Find TS/TSX files containing pattern, then sed in-place
sub() {
  local pattern="$1"
  local replacement="$2"
  local files
  files=$(find $DIRS \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | xargs grep -l "$pattern" 2>/dev/null || true)
  if [ -n "$files" ]; then
    echo "$files" | while read -r f; do
      sed -i "s|$pattern|$replacement|g" "$f"
    done
  fi
}

# === PASS 1: MarketingJob* type renames ===
echo "Pass 1: MarketingJob* type renames..."
sub 'MarketingJobRuntimeDocument' 'SocialContentJobRuntimeDocument'
sub 'MarketingJobStatusResponse' 'SocialContentJobStatusResponse'
sub 'MarketingJobCancelledError' 'SocialContentJobCancelledError'
sub 'StartMarketingJobRequest' 'StartSocialContentJobRequest'
sub 'StartMarketingJobResponse' 'StartSocialContentJobResponse'
sub 'ApproveMarketingJobRequest' 'ApproveSocialContentJobRequest'
sub 'ApproveMarketingJobResponse' 'ApproveSocialContentJobResponse'
sub 'DenyMarketingJobRequest' 'DenySocialContentJobRequest'

# === PASS 2: MarketingCampaign* type renames (longer first to avoid partial match) ===
echo "Pass 2: MarketingCampaign* type renames..."
sub 'MarketingDashboardCampaignCompatibilityStatus' 'MarketingDashboardPostCompatibilityStatus'
sub 'MarketingDashboardCampaignContent' 'MarketingDashboardPostContent'
sub 'MarketingDashboardCampaign' 'MarketingDashboardPost'
sub 'MarketingCampaignWindow' 'SocialContentWindow'
sub 'MarketingCampaignBriefAsset' 'SocialContentBriefAsset'
sub 'MarketingCampaignBrief' 'SocialContentBrief'
sub 'MarketingCampaignStatusHistoryEntry' 'SocialContentStatusHistoryEntry'
sub 'MarketingCampaignWorkflowState' 'SocialContentWorkflowState'

# === PASS 3: Campaign* standalone type renames ===
echo "Pass 3: Campaign* standalone type renames..."
sub 'CampaignWorkflowSnapshot' 'SocialContentWorkflowSnapshot'
sub 'CampaignWorkflowResolution' 'SocialContentWorkflowResolution'
sub 'CampaignWorkspaceAssetUpload' 'SocialContentWorkspaceAssetUpload'
sub 'CampaignWorkspaceRecord' 'SocialContentWorkspaceRecord'
sub 'CampaignWorkspaceView' 'SocialContentWorkspaceView'
sub 'CampaignStageReviewEvidenceKind' 'SocialContentStageReviewEvidenceKind'
sub 'CampaignStageReviewState' 'SocialContentStageReviewState'
sub 'CampaignCreativeAssetReviewState' 'SocialContentCreativeAssetReviewState'
sub 'CampaignStatusHistoryEntry' 'SocialContentStatusHistoryEntry'
sub 'CampaignBriefAssetRecord' 'SocialContentBriefAssetRecord'
sub 'CampaignBriefRecord' 'SocialContentBriefRecord'
sub 'CreateCampaignWorkspaceInput' 'CreateSocialContentWorkspaceInput'
sub 'CampaignListPage' 'SocialContentListPage'
sub 'CampaignListResponse' 'SocialContentListResponse'
sub 'CampaignListPresenterProps' 'SocialContentListPresenterProps'
sub 'CampaignListViewModel' 'SocialContentListViewModel'
sub 'CampaignBuildContext' 'SocialContentBuildContext'

# === PASS 4: Runtime* and Aries* type renames ===
echo "Pass 4: Runtime* and Aries* type renames..."
sub 'RuntimeCampaignExecutionState' 'RuntimePostExecutionState'
sub 'RuntimeCampaignListItem' 'RuntimePostListItem'
sub 'RuntimeCampaignDashboard' 'RuntimePostDashboard'
sub 'RuntimeCampaignStatus' 'RuntimePostStatus'
sub 'AriesCampaignStatus' 'AriesPostStatus'
sub 'AriesDashboardCampaignContent' 'AriesDashboardPostContent'
sub 'AriesCampaign' 'AriesPost'

# === PASS 5: Other named types ===
echo "Pass 5: BrandCampaignPayload, OneOffCampaignBrief, etc..."
sub 'BrandCampaignPayload' 'BrandPostPayload'
sub 'OneOffCampaignBrief' 'OneOffBrief'
sub 'GenerateThisWeekCampaignSnapshot' 'GenerateThisWeekPostSnapshot'

# === PASS 6: Function name renames ===
echo "Pass 6: Function name renames..."
sub 'createMarketingJobRuntimeDocument' 'createSocialContentJobRuntimeDocument'
sub 'loadMarketingJobRuntime' 'loadSocialContentJobRuntime'
sub 'saveMarketingJobRuntime' 'saveSocialContentJobRuntime'
sub 'listMarketingJobIdsForTenant' 'listSocialContentJobIdsForTenant'
sub 'listDeletedMarketingJobIdsForTenant' 'listDeletedSocialContentJobIdsForTenant'
sub 'makeMarketingJobId' 'makeSocialContentJobId'
sub 'createMarketingJobFacts' 'createSocialContentJobFacts'
sub 'startMarketingJob' 'startSocialContentJob'
sub 'approveMarketingJob' 'approveSocialContentJob'
sub 'denyMarketingJob' 'denySocialContentJob'
sub 'softDeleteMarketingJob' 'softDeleteSocialContentJob'
sub 'marketingExecutionPortOverrideForTests' 'socialContentExecutionPortOverrideForTests'
sub 'resolveMarketingExecutionPortForDoc' 'resolveSocialContentExecutionPortForDoc'
sub 'runMarketingPipeline' 'runSocialContentPipeline'
sub 'marketingPipelineArgs' 'socialContentPipelineArgs'
sub 'ensureMarketingJobInput' 'ensureSocialContentJobInput'
sub 'buildOneOffCampaignWindowForTests' 'buildOneOffWindowForTests'
sub 'function campaignName(' 'function postName('
sub 'function campaignObjective(' 'function postObjective('
sub 'appendCampaignHistory' 'appendSocialContentHistory'
sub 'loadCampaignWorkspaceRecord' 'loadSocialContentWorkspaceRecord'
sub 'saveCampaignWorkspaceRecord' 'saveSocialContentWorkspaceRecord'
sub 'saveCampaignWorkspaceAssets' 'saveSocialContentWorkspaceAssets'
sub 'syncCampaignWorkflowState' 'syncSocialContentWorkflowState'
sub 'resolveCampaignWorkflowState' 'resolveSocialContentWorkflowState'
sub 'normalizeCampaignBrief' 'normalizeSocialContentBrief'
sub 'createCampaignListViewModel' 'createSocialContentListViewModel'
sub 'formatCampaignStatusLabel' 'formatPostStatusLabel'
sub 'primaryOutputToCampaignPlanner' 'primaryOutputToSocialContentPlanner'
sub 'useRuntimeCampaigns' 'useRuntimePosts'

# === PASS 7: Variable/property renames (camelCase) ===
echo "Pass 7: Variable/property renames (camelCase)..."
sub 'campaignId' 'postId'
sub 'campaignWindow' 'postWindow'
sub 'campaignName' 'postName'
sub 'externalCampaignId' 'externalPostId'

# === PASS 8: Remaining property/array renames ===
echo "Pass 8: Remaining property renames..."
sub '  campaigns: ' '  posts: '
sub '  deletedCampaigns: ' '  deletedPosts: '
sub 'dashboard\.campaign' 'dashboard.post'

# === PASS 9: URL path strings ===
echo "Pass 9: URL path strings..."
sub "'/api/marketing/campaigns'" "'/api/social-content/posts'"
sub '"/api/marketing/campaigns"' '"/api/social-content/posts"'

# === PASS 10: Display strings / UI text ===
echo "Pass 10: Display strings / UI text..."
sub 'Campaign workflow failed' 'Social content workflow failed'
sub 'Campaign job ' 'Social content job '
sub "'Campaign strategy'" "'Social content strategy'"
sub "'Campaign approval'" "'Social content approval'"
sub "'Campaign review'" "'Social content review'"
sub "'Campaign in progress'" "'Social content job in progress'"
sub "'Campaign status is available for review\.'" "'Social content status is available for review.'"
sub "'Campaign outputs are ready'" "'Social content outputs are ready'"
sub 'available for the current campaign\.' 'available for the current social content job.'
sub "'Campaign needs operator attention'" "'Social content needs operator attention'"
sub "'Campaign is in progress'" "'Social content job is in progress'"
sub "'Campaign accepted'" "'Social content accepted'"
sub "'Campaign strategy is ready\.'" "'Social content strategy is ready.'"
sub "return idSuffix ? \`Campaign \${idSuffix}\` : \`Campaign \${status\.jobId}\`" "return idSuffix ? \`Social content \${idSuffix}\` : \`Social content \${status.jobId}\`"

echo "Codemod complete."
