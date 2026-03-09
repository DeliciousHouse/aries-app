import type { BackendError } from '../types/errors';

export interface ErrorPanelProps {
  error: BackendError;
}

const titleByKind: Record<BackendError['kind'], string> = {
  validation_error: 'Validation error',
  repair_error: 'Repair needed',
  hard_failure: 'Hard failure'
};

function retryHint(error: BackendError): string | null {
  if (error.kind === 'repair_error') {
    if (error.attempt < error.max_attempts) {
      return `Retry available (${error.attempt + 1} of ${error.max_attempts}).`;
    }

    return `Retries exhausted (${error.attempt} of ${error.max_attempts}).`;
  }

  if (error.kind === 'hard_failure') {
    return 'Retry is not automatic. Review failure class and investigate before rerunning.';
  }

  return null;
}

export function ErrorPanel({ error }: ErrorPanelProps): JSX.Element {
  const hint = retryHint(error);

  return (
    <section role="alert" aria-live="assertive" data-error-kind={error.kind} data-error-status={error.status}>
      <h3>{titleByKind[error.kind]}</h3>
      <p>
        <strong>{error.code}</strong>: {error.message}
      </p>

      {error.kind === 'validation_error' ? (
        <>
          <p data-error-empty={error.field_errors.length === 0}>Fix the fields below and try again.</p>
          {error.field_errors.length > 0 ? (
            <ul>
              {error.field_errors.map((fieldError) => (
                <li key={`${fieldError.field}:${fieldError.reason}`}>
                  {fieldError.field}: {fieldError.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {error.kind === 'repair_error' ? (
        <p>
          stage: {error.stage} ({error.attempt}/{error.max_attempts})
        </p>
      ) : null}

      {error.kind === 'hard_failure' ? <p>failure_class: {error.failure_class}</p> : null}
      {hint ? <p data-retry-state={error.kind === 'repair_error' ? 'repairable' : 'blocked'}>{hint}</p> : null}

      {error.trace_id ? <p>trace_id: {error.trace_id}</p> : null}
      {error.job_id ? <p>job_id: {error.job_id}</p> : null}
      {error.tenant_id ? <p>tenant_id: {error.tenant_id}</p> : null}
      {error.at ? <p>at: {error.at}</p> : null}
    </section>
  );
}

export default ErrorPanel;
