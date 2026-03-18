import type { TextareaHTMLAttributes } from 'react';

export type TextareaInputProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextareaInput({ className, ...props }: TextareaInputProps): JSX.Element {
  return <textarea className={['rd-textarea', className].filter(Boolean).join(' ')} {...props} />;
}
