import type { SelectHTMLAttributes } from 'react';

export type SelectInputProps = SelectHTMLAttributes<HTMLSelectElement>;

export function SelectInput({ className, ...props }: SelectInputProps): JSX.Element {
  return <select className={['rd-select', className].filter(Boolean).join(' ')} {...props} />;
}
