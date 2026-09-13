import { getConstraintStore } from "@/lib/voice/constraintStore";

export async function GET() {
  try {
    const store = getConstraintStore();
    return Response.json({ confirmed: store.getConfirmed() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Constraints unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
