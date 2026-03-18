import type { InputHTMLAttributes } from 'react';

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className, ...props }: TextInputProps): JSX.Element {
  return <input className={['rd-input', className].filter(Boolean).join(' ')} {...props} />;
}
