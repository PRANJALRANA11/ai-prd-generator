const DEFAULT_URL = "https://ai-prd-generator-fshh.onrender.com/health";
const url = process.env.RENDER_KEEPALIVE_URL || DEFAULT_URL;

const startedAt = Date.now();

try {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "ai-prd-generator-keepalive/1.0",
    },
  });
  const body = await response.text();
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    throw new Error(`Keepalive failed with ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  console.log(`Keepalive ping ok: ${url} (${response.status}, ${durationMs}ms)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
