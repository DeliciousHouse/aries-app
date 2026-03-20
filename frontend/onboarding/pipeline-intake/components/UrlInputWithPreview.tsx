'use client';

import { useState, useEffect, useRef } from 'react';
import { Globe, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { UrlPreviewData } from '../types';

interface UrlInputWithPreviewProps {
  value: string;
  onChange: (val: string) => void;
  onPreviewLoaded?: (preview: UrlPreviewData | null) => void;
  label: string;
  placeholder?: string;
  excludeUrl?: string;
}

const IP_REGEX = /^https?:\/\/(\d{1,3}\.){3}\d{1,3}/;
const BLOCKLIST = ['localhost', '127.0.0.1', 'example.com', '0.0.0.0', '[::]', '[::1]'];

function validateUrl(url: string, excludeUrl?: string): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a valid URL (e.g. https://yourbrand.com)';
  }

  if (parsed.protocol !== 'https:') {
    return 'URL must use HTTPS';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKLIST.some((b) => hostname === b || hostname.endsWith('.' + b))) {
    return 'This domain is not allowed';
  }

  if (IP_REGEX.test(url)) {
    return 'IP addresses are not allowed — enter a domain name';
  }

  if (excludeUrl) {
    try {
      const excluded = new URL(excludeUrl);
      if (excluded.hostname.toLowerCase() === hostname) {
        return 'This URL must be different from the other one entered';
      }
    } catch {
      // ignore invalid excludeUrl
    }
  }

  return null;
}

export default function UrlInputWithPreview({
  value,
  onChange,
  onPreviewLoaded,
  label,
  placeholder = 'https://yourbrand.com',
  excludeUrl,
}: UrlInputWithPreviewProps) {
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<UrlPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validationError = touched ? validateUrl(value, excludeUrl) : null;
  const isValidUrl = !validateUrl(value, excludeUrl) && value.length > 0;

  useEffect(() => {
    if (!isValidUrl) {
      setPreview(null);
      setPreviewError(null);
      onPreviewLoaded?.(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch(`/api/pipeline/url-preview?url=${encodeURIComponent(value)}`);
        if (!res.ok) throw new Error('Could not fetch preview');
        const data: UrlPreviewData = await res.json();
        setPreview(data);
        onPreviewLoaded?.(data);
      } catch {
        setPreviewError('Could not load site preview');
        setPreview(null);
        onPreviewLoaded?.(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, isValidUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const error = validationError || (touched && isValidUrl && previewError ? previewError : null);
  const showPreview = preview && isValidUrl;

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs uppercase tracking-[0.22em] text-[#888] font-medium">{label}</span>
        <div className="relative mt-2">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#444]">
            <Globe className="w-4 h-4" />
          </div>
          <input
            type="url"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              if (!touched) setTouched(true);
            }}
            onBlur={() => setTouched(true)}
            placeholder={placeholder}
            spellCheck={false}
            className={`
              w-full pl-10 pr-10 py-3.5 rounded-xl border bg-[#111118] text-white font-mono text-sm
              placeholder:text-[#333] focus:outline-none transition-all duration-200
              ${error
                ? 'border-red-500/60 focus:border-red-500'
                : isValidUrl && preview
                  ? 'border-emerald-500/40 focus:border-emerald-500/60'
                  : 'border-[#1e1e2e] focus:border-aries-crimson/60'
              }
            `}
          />
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            {previewLoading && <Loader2 className="w-4 h-4 text-[#555] animate-spin" />}
            {!previewLoading && error && <AlertCircle className="w-4 h-4 text-red-400" />}
            {!previewLoading && !error && showPreview && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
          </div>
        </div>
      </label>

      {/* Validation error */}
      {error && (
        <p className="text-sm text-red-400 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </p>
      )}

      {/* Preview card */}
      {showPreview && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
          {preview.favicon ? (
            <img
              src={preview.favicon}
              alt=""
              className="w-6 h-6 rounded object-contain flex-shrink-0 mt-0.5"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <Globe className="w-5 h-5 text-[#555] flex-shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{preview.title || preview.domain}</p>
            <p className="text-xs text-[#888] font-mono mt-0.5">{preview.domain}</p>
            {preview.description && (
              <p className="text-xs text-[#666] mt-1 line-clamp-2">{preview.description}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
