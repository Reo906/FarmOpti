// Reading data/farm_rules.json (and the field/machine reference lists) needs
// real filesystem access this Workers sandbox doesn't have, same reason the
// chat route proxies config-update confirmations to the sidecar. See
// lib/optimizer/server.ts and app/api/chat/route.ts.
export async function GET() {
  const port = process.env.OPTIMIZER_SERVER_PORT ?? '4790';
  try {
    const sidecarResponse = await fetch(`http://localhost:${port}/rules`);
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
