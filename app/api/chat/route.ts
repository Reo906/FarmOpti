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
    // re-run the pipeline, rather than treating it as a new question.
    if (body.proposal && typeof body.proposal === 'object') {
      try {
        const outcome = await assistant.confirmConfigUpdate(body.proposal as Parameters<typeof assistant.confirmConfigUpdate>[0]);
        return Response.json({ answer: outcome.answer, applied: true });
      } catch (error) {
        // Persisting a config change needs to write real files (config.yaml,
        // the external_variables CSVs) and then re-run the whole-farm solver
        // (HiGHS's WASM loader) -- neither works in this sandboxed Workers
        // runtime, and a real Cloudflare Workers deployment has no
        // persistent local filesystem at all, so this isn't fixable here.
        const message = String((error as Error)?.message ?? error);
        const runtimeUnavailable = /wasm|readAll|writeAll|file: URL|no such file or directory|ENOENT/i.test(message);
        return Response.json(
          {
            error: runtimeUnavailable
              ? "Applying a lasting change needs to write to the farm's data files and re-run the whole-farm solver, and this web deployment's runtime can't do either. Run FarmOpti's CLI chatbot (npm run optimizer:chatbot) to apply this change instead."
              : `Could not apply that change: ${message}`,
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
