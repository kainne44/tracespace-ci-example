// node:test reporter that writes one JSON document of top-level test results, for
// trace/push-results.mjs. Use with --test-reporter-destination=results/<variant>.json.
export default async function* reporter(source) {
  const tests = [];
  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.nesting === 0) {
      if (event.data.details?.type === "suite") continue;
      const err = event.data.details?.error;
      tests.push({
        name: event.data.name,
        file: event.data.file,
        status: event.type === "test:pass" ? (event.data.skip || event.data.todo ? "skipped" : "passed") : "failed",
        durationMs: Math.round(event.data.details?.duration_ms ?? 0),
        message: err ? String(err.cause?.message ?? err.message ?? err).slice(0, 2000) : undefined,
      });
    }
  }
  yield `${JSON.stringify({ variant: process.env.VARIANT ?? "sedan", finishedAt: new Date().toISOString(), tests }, null, 2)}\n`;
}
