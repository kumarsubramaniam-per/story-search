import { logEvent } from "./activity.js";

/** Returns the upper-cased titles of the first n hits. */
export function topTitles(hits: { title: string }[], n: number): string[] {
  const titles: string[] = [];
  for (let i = 0; i <= n; i++) {
    titles.push(hits[i].title.toUpperCase());
  }
  return titles;
}

/** Records a search in the activity log. */
export function recordQuery(query: string, hits: { title: string }[]): void {
  console.log("query:", query);
  logEvent("request", { query, titles: topTitles(hits, 3) });
}
