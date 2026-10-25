-- A separate tenant-owned Meta user grant; organic Facebook Page rows are unchanged.
ALTER TABLE oauth_connections DROP CONSTRAINT IF EXISTS oauth_connections_provider_check;
ALTER TABLE oauth_connections ADD CONSTRAINT oauth_connections_provider_check
  CHECK (provider IN ('facebook','instagram','linkedin','x','youtube','tiktok','reddit','slack','meta_ads'));
