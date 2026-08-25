/**
 * Runs independent reads with a fixed worker pool and returns them in source
 * order. Board hydration and pull-request refresh both fan out over a list
 * whose length the user controls — a Project's threads, a policy's
 * repositories — so both need a ceiling on how many reads are in flight, and
 * both need the source order back for deterministic sorting and reconciliation.
 */
export async function mapConcurrentOrdered<TItem, TResult>(
  items: ReadonlyArray<TItem>,
  concurrency: number,
  run: (item: TItem, index: number) => Promise<TResult>,
): Promise<ReadonlyArray<TResult>> {
  const results: Array<{ readonly value: TResult } | undefined> = Array.from({
    length: items.length,
  });
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = { value: await run(item, index) };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Concurrent read ${String(index)} did not produce a result.`);
    }
    return result.value;
  });
}
