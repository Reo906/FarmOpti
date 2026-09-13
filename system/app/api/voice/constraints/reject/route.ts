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
    const rejected = store.reject(sessionId, proposalId);
    return Response.json({ rejected });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not reject constraint.";
    return Response.json({ error: message }, { status: 400 });
  }
}
