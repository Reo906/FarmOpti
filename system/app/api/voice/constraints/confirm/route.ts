import { getConstraintStore } from "@/lib/voice/constraintStore";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId?: unknown;
      proposalId?: unknown;
    };
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const proposalId =
      typeof body.proposalId === "string" ? body.proposalId.trim() : undefined;

    if (!sessionId) {
      return Response.json(
        { error: "Provide a sessionId field." },
        { status: 400 },
      );
    }

    const store = getConstraintStore();
    const confirmed = store.confirm(sessionId, proposalId);
    return Response.json({ confirmed });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not confirm constraint.";
    return Response.json({ error: message }, { status: 400 });
  }
}
