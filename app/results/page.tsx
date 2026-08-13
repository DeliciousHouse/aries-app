import { redirect } from 'next/navigation';

/** AA-229/PR2b: point straight at /insights — /dashboard/results is retired
 *  (itself now just a redirect to /insights), so this avoids a double hop. */
export default function ResultsPage() {
  redirect('/insights');
}
