// A confirmed RPC transaction can precede Horizon's account projection.
// Only accept balances whose sequence includes the final lifecycle swap.
export async function waitForHorizonAccount(
  horizonUrl,
  accountId,
  txHash,
  { fetch = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {},
) {
  const deadline = now() + 60_000;
  let sequence;
  while (now() < deadline) {
    const url = sequence === undefined
      ? `${horizonUrl}/transactions/${txHash}`
      : `${horizonUrl}/accounts/${accountId}`;
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
    });
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Horizon verification failed: HTTP ${response.status}`);
      const record = await response.json();
      if (sequence === undefined) {
        if (record.successful !== true || record.source_account !== accountId) {
          throw new Error("Final transaction does not match the successful lifecycle swap");
        }
        sequence = BigInt(record.source_account_sequence);
        continue;
      }
      if (BigInt(record.sequence) >= sequence) return record;
    }
    await sleep(Math.min(2000, Math.max(0, deadline - now())));
  }
  throw new Error("Horizon did not ingest the final transaction within 60 seconds");
}
