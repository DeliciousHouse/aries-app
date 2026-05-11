import { validateHonchoConfig } from '@/backend/memory/honcho-env';

export async function register() {
  // Fail fast on startup when HONCHO_ENABLED=true but required config is absent.
  validateHonchoConfig(process.env);
}
