import { getConstraintStore } from "@/lib/voice/constraintStore";

export async function GET(
  _request: Request,
  { params }: { params: { sessionId: string } },
) {
  try {
    const store = getConstraintStore();
    const proposal = store.getPending(params.sessionId);
    if (!proposal) {
      return Response.json({ proposal: null });
    }
    return Response.json({ proposal });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not retrieve proposal.";
    return Response.json({ error: message }, { status: 503 });
  }
}
