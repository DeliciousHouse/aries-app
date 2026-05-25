'use client';

import React, { useMemo, useState } from 'react';

export interface MonthDayPickerProps {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  invalid?: boolean;
  /** Override today's date — test-only. */
  _today?: Date;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function daysInMonth(year: number, month: number): number {
  // month is 1-based; new Date(year, month, 0) gives last day of that month
  return new Date(year, month, 0).getDate();
}

export function isNearYearEnd(today: Date): boolean {
  const month = today.getMonth(); // 0-based
  const day = today.getDate();
  // Within 30 days of Dec 31: month=11 (Dec), or month=10 (Nov) day >= 1 when
  // Nov 30 + 30 days would reach Dec 30. Simpler: compute days until Dec 31.
  const currentYear = today.getFullYear();
  const dec31 = new Date(currentYear, 11, 31);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilYearEnd = Math.round((dec31.getTime() - today.getTime()) / msPerDay);
  return daysUntilYearEnd <= 30;
}

function parseValue(value: string): { month: number; day: number; year: number } | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = parseInt(value.slice(0, 4), 10);
  const month = parseInt(value.slice(5, 7), 10);
  const day = parseInt(value.slice(8, 10), 10);
  if (month < 1 || month > 12 || day < 1) return null;
  return { year, month, day };
}

const selectClassName =
  'rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50';
const selectInvalidClassName =
  'rounded-2xl border border-red-500/50 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-red-500/70';

export function MonthDayPicker({ value, onChange, ariaLabel, invalid, _today }: MonthDayPickerProps) {
  const today = _today ?? new Date();
  const currentYear = today.getFullYear();
  const showYearSelector = isNearYearEnd(today);

  const parsed = useMemo(() => parseValue(value), [value]);

  const [selectedMonth, setSelectedMonth] = useState<number>(parsed?.month ?? 0);
  const [selectedDay, setSelectedDay] = useState<number>(parsed?.day ?? 0);
  const [selectedYear, setSelectedYear] = useState<number>(parsed?.year ?? currentYear);

  // Sync from incoming value prop when it changes externally
  const lastValueRef = React.useRef(value);
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    const p = parseValue(value);
    if (p) {
      if (p.month !== selectedMonth) setSelectedMonth(p.month);
      if (p.day !== selectedDay) setSelectedDay(p.day);
      if (p.year !== selectedYear) setSelectedYear(p.year);
    } else if (value === '') {
      setSelectedMonth(0);
      setSelectedDay(0);
      setSelectedYear(currentYear);
    }
  }

  const maxDay = selectedMonth > 0 ? daysInMonth(selectedYear, selectedMonth) : 31;

  function emit(month: number, day: number, year: number) {
    if (month > 0 && day > 0) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      onChange(`${year}-${mm}-${dd}`);
    } else {
      onChange('');
    }
  }

  function handleMonthChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const month = parseInt(e.target.value, 10);
    setSelectedMonth(month);
    const max = month > 0 ? daysInMonth(selectedYear, month) : 31;
    let day = selectedDay;
    if (day > max) {
      day = 0;
      setSelectedDay(0);
    }
    emit(month, day, selectedYear);
  }

  function handleDayChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const day = parseInt(e.target.value, 10);
    setSelectedDay(day);
    emit(selectedMonth, day, selectedYear);
  }

  function handleYearChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const year = parseInt(e.target.value, 10);
    setSelectedYear(year);
    const max = selectedMonth > 0 ? daysInMonth(year, selectedMonth) : 31;
    let day = selectedDay;
    if (day > max) {
      day = 0;
      setSelectedDay(0);
    }
    emit(selectedMonth, day, year);
  }

  const className = invalid ? selectInvalidClassName : selectClassName;

  return (
    <fieldset aria-label={ariaLabel} className="flex gap-2">
      <select
        aria-label="Month"
        aria-invalid={invalid}
        value={selectedMonth}
        onChange={handleMonthChange}
        className={className}
      >
        <option value={0}>Month</option>
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>{name}</option>
        ))}
      </select>

      <select
        aria-label="Day"
        aria-invalid={invalid}
        value={selectedDay}
        onChange={handleDayChange}
        className={className}
      >
        <option value={0}>Day</option>
        {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>

      {showYearSelector ? (
        <select
          aria-label="Year"
          aria-invalid={invalid}
          value={selectedYear}
          onChange={handleYearChange}
          className={className}
        >
          <option value={currentYear}>{currentYear}</option>
          <option value={currentYear + 1}>{currentYear + 1}</option>
        </select>
      ) : null}
    </fieldset>
  );
}

export default MonthDayPicker;
