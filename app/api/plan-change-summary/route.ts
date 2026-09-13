// Polled briefly by the frontend after a reoptimization confirms: the
// confirm response returns immediately with the fast, deterministic plan-
// change summary, while the nicer LLM-phrased version keeps generating in
// the background on the sidecar and overwrites data/outputs/plan_change_
// summary.json when ready. See lib/optimizer/server.ts and
// lib/optimizer/chatbot/explanationService.ts::confirmConfigUpdate().
export async function GET() {
  const port = process.env.OPTIMIZER_SERVER_PORT ?? '4790';
  try {
    const sidecarResponse = await fetch(`http://localhost:${port}/plan-change-summary`);
    const body = await sidecarResponse.json();
    return Response.json(body, { status: sidecarResponse.status });
  } catch {
    return Response.json(
      {
        error: "Could not reach the local optimizer helper. Start it with `npm run optimizer:server` (alongside `npm run dev`).",
      },
      { status: 503 },
    );
  }
}
