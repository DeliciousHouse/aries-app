export interface LoadingStateProps {
  label?: string;
}

export function LoadingState({
  label = 'Loading…',
}: LoadingStateProps): JSX.Element {
  return (
    <div className="rd-loading">
      <div className="rd-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}
