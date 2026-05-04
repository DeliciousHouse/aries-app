'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterBusinessTypes, topGhostSuffix } from '../business-types';

interface Props {
  value: string;
  onChange: (next: string) => void;
  suggestions?: readonly string[];
  required?: boolean;
  label?: string;
  placeholder?: string;
  id?: string;
}

export default function BusinessTypeCombobox({
  value,
  onChange,
  suggestions,
  required,
  label = 'Business Type',
  placeholder = 'e.g. Ecommerce / DTC brand',
  id: idProp,
}: Props) {
  const reactId = useId();
  const inputId = idProp ?? `business-type-${reactId}`;
  const listboxId = `${inputId}-listbox`;

  const [isOpen, setIsOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () => filterBusinessTypes(value, suggestions),
    [value, suggestions],
  );
  const ghostSuffix = useMemo(
    () => topGhostSuffix(value, suggestions),
    [value, suggestions],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isOpen]);

  useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(0);
    }
  }, [filtered.length, highlight]);

  const commit = (next: string) => {
    onChange(next);
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      if (isOpen && filtered[highlight]) {
        event.preventDefault();
        commit(filtered[highlight]);
      }
      return;
    }
    if (event.key === 'Escape') {
      setIsOpen(false);
      return;
    }
    if ((event.key === 'Tab' || event.key === 'ArrowRight') && ghostSuffix) {
      event.preventDefault();
      commit(value + ghostSuffix);
    }
  };

  const activeDescendantId =
    isOpen && filtered[highlight] ? `${inputId}-option-${highlight}` : undefined;

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-[#888] mb-1.5">
        {label}{required ? ' *' : ''}
      </label>
      <div className="relative">
        {ghostSuffix && isOpen && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 px-3 py-2 text-sm whitespace-pre"
            style={{ color: 'transparent' }}
          >
            <span style={{ color: 'transparent' }}>{value}</span>
            <span style={{ color: '#555' }}>{ghostSuffix}</span>
          </div>
        )}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendantId}
          aria-required={required}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
            setHighlight(0);
          }}
          onKeyDown={handleKeyDown}
          className="relative w-full rounded-lg bg-[#0f0f14] border border-[#222] px-3 py-2 text-sm text-white placeholder-[#555] focus:outline-none focus:border-aries-crimson"
        />
      </div>

      {isOpen && filtered.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-[#222] bg-[#0f0f14] py-1 shadow-lg"
        >
          {filtered.map((entry, idx) => {
            const optionId = `${inputId}-option-${idx}`;
            const isActive = idx === highlight;
            return (
              <li
                id={optionId}
                key={entry}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(entry);
                }}
                className={`px-3 py-1.5 text-sm cursor-pointer ${isActive ? 'bg-[#1a1a22] text-white' : 'text-[#bbb]'}`}
              >
                {entry}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
