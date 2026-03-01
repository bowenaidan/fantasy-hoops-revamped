import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const API_KEY = Deno.env.get("ODDS_API_KEY")!;
const FORMAT = "american";
const SPORT = "basketball_ncaab";
const REGIONS = "us";
const MARKETS = "h2h";
const ENDPOINT = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=${FORMAT}`;

/**
 * Fetch odds data from the-odds-api
 */
export async function fetchOdds() {
  try {
    const response = await fetch(ENDPOINT);
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log("Odds fetched successfully");
    console.log(`Games available: ${data.length}`);
    
    return data;
  } catch (error) {
    console.error("Error fetching odds:", error);
    throw error;
  }
}

// CLI entrypoint for testing
if (require.main === module) {
  (async () => {
    const odds = await fetchOdds();
    console.log(JSON.stringify(odds.slice(0, 1), null, 2));
  })();
}
