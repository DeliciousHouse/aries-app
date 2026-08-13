#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecognizedWeekday } from '../../backend/marketing/auto-schedule';
import { readWeeklySchedule } from '../../backend/marketing/hermes-callbacks';
import { resolveDataRoot } from '../../lib/runtime-paths';

type UnparseableWeekday = { document: string; index: number; value: string };

export type ScheduleCorpusCensus = {
  corpusPath: string;
  documents: number;
  invalidDocuments: string[];
  documentsWithAnyScheduleKey: string[];
  documentsWithAnyWeekdayKey: string[];
  readableScheduleDocuments: string[];
  readableEntries: number;
  recommendedDayOnlyEntries: number;
  dayOnlyEntries: number;
  bothWeekdayFieldsEntries: number;
  noWeekdayFieldEntries: number;
  recognizedWeekdayEntries: number;
  unparseableWeekdayEntries: UnparseableWeekday[];
};

function hasKey(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKey(entry, keys));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => keys.has(key) || hasKey(entry, keys));
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function censusScheduleCorpus(dataRoot = resolveDataRoot()): Promise<ScheduleCorpusCensus> {
  const corpusPath = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  const documents = (await readdir(corpusPath)).filter((name) => name.endsWith('.json')).sort();
  const census: ScheduleCorpusCensus = {
    corpusPath,
    documents: documents.length,
    invalidDocuments: [],
    documentsWithAnyScheduleKey: [],
    documentsWithAnyWeekdayKey: [],
    readableScheduleDocuments: [],
    readableEntries: 0,
    recommendedDayOnlyEntries: 0,
    dayOnlyEntries: 0,
    bothWeekdayFieldsEntries: 0,
    noWeekdayFieldEntries: 0,
    recognizedWeekdayEntries: 0,
    unparseableWeekdayEntries: [],
  };

  for (const document of documents) {
    const contents = await readFile(path.join(corpusPath, document), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      census.invalidDocuments.push(document);
      continue;
    }

    if (hasKey(parsed, new Set(['schedule', 'weekly_schedule']))) {
      census.documentsWithAnyScheduleKey.push(document);
    }
    if (hasKey(parsed, new Set(['recommended_day', 'day']))) {
      census.documentsWithAnyWeekdayKey.push(document);
    }

    const schedule = readWeeklySchedule(parsed as Parameters<typeof readWeeklySchedule>[0]);
    if (schedule.length === 0) continue;
    census.readableScheduleDocuments.push(document);
    census.readableEntries += schedule.length;

    schedule.forEach((entry, index) => {
      const recommendedDay = nonBlankString(entry.recommended_day);
      const day = nonBlankString(entry.day);
      if (recommendedDay && !day) census.recommendedDayOnlyEntries += 1;
      if (day && !recommendedDay) census.dayOnlyEntries += 1;
      if (recommendedDay && day) census.bothWeekdayFieldsEntries += 1;
      if (!recommendedDay && !day) census.noWeekdayFieldEntries += 1;

      const resolved = recommendedDay ?? day;
      if (!resolved) return;
      if (isRecognizedWeekday(resolved)) {
        census.recognizedWeekdayEntries += 1;
      } else {
        census.unparseableWeekdayEntries.push({ document, index, value: resolved });
      }
    });
  }

  return census;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const dataRoot = process.argv[2] ? path.resolve(process.argv[2]) : resolveDataRoot();
  censusScheduleCorpus(dataRoot)
    .then((census) => console.log(JSON.stringify(census, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
