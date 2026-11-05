import { Suspense } from 'react';
import { getLeagueData } from '@/lib/data';
import { League } from './League';

// Standings change every sync, so render on each request (the page refreshes itself
// every minute while open).
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let data;
  try {
    data = await getLeagueData();
  } catch (err) {
    console.error(err);
    return (
      <main className="page">
        <h1>Fantasy Hoops</h1>
        <p className="error">Couldn&apos;t load league data: {err instanceof Error ? err.message : String(err)}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page">
        <h1>Fantasy Hoops</h1>
        <p className="empty-state">No season has been set up yet.</p>
      </main>
    );
  }

  // useSearchParams() in League needs a Suspense boundary.
  return (
    <Suspense>
      <League data={data} />
    </Suspense>
  );
}
