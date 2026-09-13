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
    const body = (await request.json()) as { question?: unknown; summary?: unknown };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const summary = body.summary === true;

    if (!question && !summary) {
      return Response.json({ error: 'Enter a question about the optimisation result.' }, { status: 400 });
    }

    const assistant = getService();
    const result = summary ? { answer: await assistant.explainDefault() } : await assistant.answer(question);
    return Response.json({ answer: result.answer, scenario: result.scenario_result ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The decision assistant is unavailable.';
    return Response.json({ error: `The decision assistant is unavailable in this web runtime: ${message}` }, { status: 503 });
  }
}
