"use client";

import { useEffect, useMemo, useState } from 'react';
import MetaPlatformCard from './meta-platform-card';
import { createMetaClient } from '../api/client/meta';
import type { MetaError, MetaStatusRecord, meta_provider } from '../types/meta';

const LOCAL_CALLBACK = 'http://localhost:3000/api/integrations/meta/callback';
const PROD_CALLBACK = 'https://aries.sugarandleather.com/api/integrations/meta/callback';

export interface MetaIntegrationsProps {
  tenantId: string;
  baseUrl?: string;
  preferProductionRedirect?: boolean;
}

export default function MetaIntegrations({ tenantId, baseUrl = '', preferProductionRedirect = false }: MetaIntegrationsProps): JSX.Element {
  const client = useMemo(() => createMetaClient({ baseUrl }), [baseUrl]);
  const [records, setRecords] = useState<MetaStatusRecord[]>([
    { provider: 'facebook', connection_state: 'not_connected' },
    { provider: 'instagram', connection_state: 'not_connected' }
  ]);
  const [busyProvider, setBusyProvider] = useState<meta_provider | null>(null);
  const [error, setError] = useState<MetaError | null>(null);

  async function refresh(): Promise<void> {
    const res = await client.status({ tenant_id: tenantId });
    if (res.status === 'error') {
      setError(res);
      return;
    }
    setError(null);
    setRecords(res.providers);
  }

  useEffect(() => {
    refresh().catch((e) => setError({ status: 'error', reason: 'internal_error', message: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function connect(provider: meta_provider): Promise<void> {
    setBusyProvider(provider);
    const redirect_uri = preferProductionRedirect ? PROD_CALLBACK : LOCAL_CALLBACK;
    const res = await client.connect({ tenant_id: tenantId, provider, redirect_uri });
    if (res.status === 'error') {
      setError(res);
      setBusyProvider(null);
      return;
    }
    // For local scaffold, we simulate moving user to auth URL.
    window.location.href = res.authorization_url;
  }

  async function disconnect(provider: meta_provider): Promise<void> {
    setBusyProvider(provider);
    const res = await client.disconnect({ tenant_id: tenantId, provider });
    if (res.status === 'error') setError(res);
    await refresh();
    setBusyProvider(null);
  }

  return (
    <section>
      <h2>Meta Integrations</h2>
      <p>One Meta app powers both Facebook and Instagram connection lanes.</p>
      <p>Callback URIs: local `{LOCAL_CALLBACK}` / production `{PROD_CALLBACK}`</p>

      {error ? <div role="alert">{error.reason}{error.message ? `: ${error.message}` : ''}</div> : null}

      {records.map((record) => (
        <MetaPlatformCard
          key={record.provider}
          record={record}
          busy={busyProvider === record.provider}
          onConnect={connect}
          onDisconnect={disconnect}
        />
      ))}

      <button type="button" onClick={() => refresh()} disabled={!!busyProvider}>Refresh status</button>
    </section>
  );
}
