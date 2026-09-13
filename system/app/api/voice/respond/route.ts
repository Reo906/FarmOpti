import type { ExplanationService } from "@/lib/optimizer/chatbot/explanationService";
import { getConstraintStore } from "@/lib/voice/constraintStore";

let service: ExplanationService | undefined;

async function getService() {
  const { ExplanationService: Service } = await import(
    "@/lib/optimizer/chatbot/explanationService"
  );
  service ??= new Service();
  return service;
}

const CONFIRM_RE = /^\s*confirm\s+change\s*$/i;
const CANCEL_RE = /^\s*cancel\s+change\s*$/i;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId?: unknown;
      text?: unknown;
    };
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!text) {
      return Response.json(
        { error: "Provide a non-empty text field." },
        { status: 400 },
      );
    }
    if (!sessionId) {
      return Response.json(
        { error: "Provide a sessionId field." },
        { status: 400 },
      );
    }

    const store = getConstraintStore();

    // Handle confirm / cancel commands.
    if (CONFIRM_RE.test(text)) {
      const pending = store.getPending(sessionId);
      if (!pending) {
        return Response.json({
          answer: "There is no pending constraint change to confirm.",
          mode: "explain",
          metadata: {},
        });
      }
      const confirmed = store.confirm(sessionId);
      return Response.json({
        answer: `Constraint confirmed and saved: "${confirmed.sourceText}"`,
        mode: "confirm",
        metadata: { confirmedProposal: confirmed },
      });
    }

    if (CANCEL_RE.test(text)) {
      const pending = store.getPending(sessionId);
      if (!pending) {
        return Response.json({
          answer: "There is no pending constraint change to cancel.",
          mode: "explain",
          metadata: {},
        });
      }
      store.reject(sessionId);
      return Response.json({
        answer: "Constraint change discarded.",
        mode: "cancel",
        metadata: {},
      });
    }

    // Regular question — forward to the optimizer.
    const assistant = await getService();
    const overlay = store.activeScenario();
    const result = await assistant.answer(text, { scenarioOverlay: overlay });

    const scenarioResult = result.scenario_result as
      | (Record<string, unknown> & { requestedScenario?: unknown })
      | undefined;

    let pendingProposal = null;
    if (scenarioResult && !result.scenario_error) {
      const requestedScenario = scenarioResult.requestedScenario as
        | { mode: string; changes: unknown[] }
        | undefined;
      if (requestedScenario?.changes?.length) {
        pendingProposal = store.propose(sessionId, text, {
          scenario: requestedScenario,
          resolvedChanges: scenarioResult.resolved_changes as unknown[],
          comparison: scenarioResult.comparison as Record<string, unknown>,
          summary: scenarioResult.summary as Record<string, unknown>,
          schedule: scenarioResult.schedule as Record<string, unknown>[],
        });
      }
    }

    const answer = pendingProposal
      ? `${result.answer}\n\nSay "confirm change" to activate this rule, or "cancel change" to discard it.`
      : result.answer;

    return Response.json({
      answer,
      mode: result.scenario_result ? "scenario" : "explain",
      metadata: {
        scenarioError: Boolean(result.scenario_error),
        objectiveChangeAud: (scenarioResult?.comparison as any)
          ?.objective_change_aud,
        actionsAdded: (
          (scenarioResult?.comparison as any)?.actions_added ?? []
        ).length,
        actionsRemoved: (
          (scenarioResult?.comparison as any)?.actions_removed ?? []
        ).length,
        actionsRescheduled: (
          (scenarioResult?.comparison as any)?.actions_rescheduled ?? []
        ).length,
      },
      pendingProposal,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The decision assistant is unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
