import type {
  MetaCallbackSuccess,
  MetaConnectRequest,
  MetaConnectSuccess,
  MetaDisconnectSuccess,
  MetaError,
  MetaStatusSuccess,
  meta_provider
} from '../../types/meta';

export type MetaConnectBody = MetaConnectRequest;
export type MetaConnectResponse = MetaConnectSuccess | MetaError;

export type MetaCallbackQuery = {
  tenant_id: string;
  provider: meta_provider;
  state: string;
  code?: string;
  error?: string;
  error_description?: string;
};
export type MetaCallbackResponse = MetaCallbackSuccess | MetaError;

export type MetaStatusQuery = { tenant_id: string };
export type MetaStatusResponse = MetaStatusSuccess | MetaError;

export type MetaDisconnectBody = {
  tenant_id: string;
  provider: meta_provider;
};
export type MetaDisconnectResponse = MetaDisconnectSuccess | MetaError;
