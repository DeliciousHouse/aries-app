'use client';

import { Check } from 'lucide-react';
import { KeyboardEvent, ReactNode } from 'react';

export interface SelectionOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

interface SelectionCardGroupProps {
  options: SelectionOption[];
  selected: string | string[];
  onChange: (value: string | string[]) => void;
  multi?: boolean;
  ariaLabel?: string;
}

export default function SelectionCardGroup({
  options,
  selected,
  onChange,
  multi = false,
  ariaLabel,
}: SelectionCardGroupProps) {
  const isSelected = (value: string) => {
    if (multi) return Array.isArray(selected) && selected.includes(value);
    return selected === value;
  };

  const handleClick = (value: string) => {
    if (multi) {
      const arr = Array.isArray(selected) ? selected : [];
      if (arr.includes(value)) {
        onChange(arr.filter((v) => v !== value));
      } else {
        onChange([...arr, value]);
      }
    } else {
      onChange(value);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick(value);
    }
  };

  const groupRole = multi ? 'group' : 'radiogroup';
  const itemRole = multi ? 'checkbox' : 'radio';

  return (
    <div className="grid gap-3" role={groupRole} aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = isSelected(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            role={itemRole}
            aria-checked={active}
            tabIndex={0}
            onClick={() => handleClick(opt.value)}
            onKeyDown={(event) => handleKeyDown(event, opt.value)}
            className={`
              w-full text-left flex items-center gap-4 p-4 rounded-xl border transition-all duration-200
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aries-crimson focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]
              ${active
                ? 'border-aries-crimson bg-aries-crimson/8 shadow-md shadow-aries-crimson/10'
                : 'border-[#1e1e2e] bg-[#111118] hover:border-[#2a2a3e] hover:bg-[#13131a]'
              }
            `}
          >
            {/* Icon */}
            {opt.icon && (
              <div
                className={`
                  flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-lg
                  ${active ? 'bg-aries-crimson/15 text-aries-crimson' : 'bg-[#1a1a24] text-[#666]'}
                `}
              >
                {opt.icon}
              </div>
            )}

            {/* Text */}
            <div className="flex-1 min-w-0">
              <p className={`font-semibold text-sm ${active ? 'text-white' : 'text-[#ccc]'}`}>
                {opt.label}
              </p>
              {opt.description && (
                <p className={`text-xs mt-0.5 ${active ? 'text-[#aaa]' : 'text-[#555]'}`}>
                  {opt.description}
                </p>
              )}
            </div>

            {/* Check indicator */}
            <div
              className={`
                flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-200
                ${active ? 'bg-aries-crimson border-aries-crimson' : 'border-[#333]'}
              `}
            >
              {active && <Check className="w-3 h-3 text-white" aria-hidden />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
