type ExplanationService = import('@/lib/optimizer/chatbot/explanationService').ExplanationService;
let service: ExplanationService | undefined;

async function getService() {
  const { ExplanationService: Service } = await import('@/lib/optimizer/chatbot/explanationService');
  service ??= new Service();
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

    const assistant = await getService();
    const result = summary ? { answer: await assistant.explainDefault() } : await assistant.answer(question);
    return Response.json({ answer: result.answer, scenario: result.scenario_result ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The decision assistant is unavailable.';
    return Response.json({ error: `The decision assistant is unavailable in this web runtime: ${message}` }, { status: 503 });
  }
}
