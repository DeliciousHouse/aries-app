"use client";

import type { MetaStatusRecord, meta_provider } from '../types/meta';

export interface MetaPlatformCardProps {
  record: MetaStatusRecord;
  busy?: boolean;
  onConnect: (provider: meta_provider) => void;
  onDisconnect: (provider: meta_provider) => void;
}

export default function MetaPlatformCard({ record, busy = false, onConnect, onDisconnect }: MetaPlatformCardProps): JSX.Element {
  const canConnect = record.connection_state === 'not_connected' || record.connection_state === 'error' || record.connection_state === 'reauthorization_required';
  const canDisconnect = record.connection_state === 'connected';

  return (
    <article style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h3>{record.provider === 'facebook' ? 'Facebook' : 'Instagram'}</h3>
      <p>state: <strong>{record.connection_state}</strong></p>
      {record.account_label ? <p>account: {record.account_label}</p> : null}
      {record.connected_at ? <p>connected_at: {record.connected_at}</p> : null}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={!canConnect || busy} onClick={() => onConnect(record.provider)}>
          {busy ? 'Working…' : 'Connect'}
        </button>
        <button type="button" disabled={!canDisconnect || busy} onClick={() => onDisconnect(record.provider)}>
          Disconnect
        </button>
      </div>
    </article>
  );
}
