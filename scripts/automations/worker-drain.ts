/** Process-local drain only; a drained cycle is NOT external-outcome reconciliation. */
export function createDrainingWorker(cycle: () => Promise<void>, close: () => Promise<void>) {
  let active: Promise<void> | null = null;
  let stopping = false;
  let failed = false;
  let shutdownResult: Promise<boolean> | null = null;

  async function run(): Promise<void> {
    if (stopping || active) return;
    const current = Promise.resolve().then(() => stopping ? undefined : cycle());
    active = current;
    try {
      await current;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (active === current) active = null;
    }
  }

  function shutdown(timeoutMs = 350_000): Promise<boolean> {
    stopping = true;
    if (shutdownResult) return shutdownResult;
    shutdownResult = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        return await Promise.race([
          (async () => {
            await active?.catch(() => {});
            if (expired) return false;
            await close();
            return !failed;
          })(),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => { expired = true; resolve(false); }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return shutdownResult;
  }

  return { run, shutdown, shouldStop: () => stopping };
}
