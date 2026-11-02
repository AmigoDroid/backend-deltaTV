/** Latência só mede desempenho: falha HTTP é diferente de servidor lento. */
export function healthTransition(previous, result) {
  const good = result.good === true;
  const failures = good ? 0 : Math.min(100, Number(previous?.failures || 0) + 1);
  const successes = good ? Math.min(100, Number(previous?.successes || 0) + 1) : 0;
  const state = failures >= 2 ? "down" : successes >= 2 ? (result.slow ? "slow" : "healthy")
    : good ? "checking" : "suspect";
  return { state, failures, successes };
}
