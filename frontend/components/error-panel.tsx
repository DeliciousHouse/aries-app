import type { BackendError } from '../types/errors';

export interface ErrorPanelProps {
  error: BackendError;
}

export function ErrorPanel({ error }: ErrorPanelProps): JSX.Element {
  return (
    <section role="alert" data-error-kind={error.kind} data-error-status={error.status}>
      <h3>{error.code}</h3>
      <p>{error.message}</p>

      {error.kind === 'validation_error' ? (
        <ul>
          {error.field_errors.map((fieldError) => (
            <li key={`${fieldError.field}:${fieldError.reason}`}>
              {fieldError.field}: {fieldError.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {error.kind === 'repair_error' ? (
        <p>
          stage: {error.stage} ({error.attempt}/{error.max_attempts})
        </p>
      ) : null}

      {error.kind === 'hard_failure' ? <p>failure_class: {error.failure_class}</p> : null}

      {error.trace_id ? <p>trace_id: {error.trace_id}</p> : null}
      {error.job_id ? <p>job_id: {error.job_id}</p> : null}
      {error.tenant_id ? <p>tenant_id: {error.tenant_id}</p> : null}
      {error.at ? <p>at: {error.at}</p> : null}
    </section>
  );
}

export default ErrorPanel;
