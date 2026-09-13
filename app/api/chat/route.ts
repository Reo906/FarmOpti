import { ExplanationService } from '@/lib/optimizer/chatbot/explanationService';

// A dynamic import() of a local module here does not resolve in this web
// runtime (Cloudflare Workers via vinext), so this stays a static import.
// ExplanationService itself defers loading the LP solver (and its WASM
// loader) until a scenario is actually requested, so this is still cheap
// for plain explain-mode questions.
let service: ExplanationService | undefined;

function getService() {
  service ??= new ExplanationService();
  return service;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { question?: unknown; summary?: unknown; proposal?: unknown };
    const assistant = getService();

    // A proposal round-tripped back from a previous response means the user
    // clicked "Yes" on a pending config-update confirmation -- apply it and
    // re-run the pipeline. This Workers sandbox can't write real files or
    // load the HiGHS WASM solver itself, so that work is delegated to a
    // local sidecar (lib/optimizer/server.ts, run via `npm run
    // optimizer:server`) over plain HTTP, which the sandbox can do freely.
    if (body.proposal && typeof body.proposal === 'object') {
      const port = process.env.OPTIMIZER_SERVER_PORT ?? '4790';
      try {
        const sidecarResponse = await fetch(`http://localhost:${port}/confirm-config-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposal: body.proposal }),
        });
        const outcome = (await sidecarResponse.json()) as {
          answer?: string;
          error?: string;
          summary?: unknown;
          scheduleCsv?: string;
          changeSummary?: unknown;
        };
        if (!sidecarResponse.ok) {
          return Response.json({ error: outcome.error ?? 'Could not apply that change.' }, { status: sidecarResponse.status });
        }
        return Response.json({
          answer: outcome.answer,
          applied: true,
          summary: outcome.summary,
          scheduleCsv: outcome.scheduleCsv,
          changeSummary: outcome.changeSummary,
        });
      } catch {
        return Response.json(
          {
            error:
              "Applying a lasting change needs a local helper this web runtime can't run itself. Start it with `npm run optimizer:server` (alongside `npm run dev`) and try again.",
          },
          { status: 503 },
        );
      }
    }

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const summary = body.summary === true;

    if (!question && !summary) {
      return Response.json({ error: 'Enter a question about the optimisation result.' }, { status: 400 });
    }

    const result: { answer: string; scenario_result?: unknown; needs_confirmation?: boolean; pending_proposal?: unknown } = summary
      ? { answer: await assistant.explainDefault() }
      : await assistant.answer(question);

    return Response.json({
      answer: result.answer,
      scenario: result.scenario_result ?? null,
      needsConfirmation: result.needs_confirmation ?? false,
      proposal: result.pending_proposal ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The decision assistant is unavailable.';
    return Response.json({ error: `The decision assistant is unavailable in this web runtime: ${message}` }, { status: 503 });
  }
}
