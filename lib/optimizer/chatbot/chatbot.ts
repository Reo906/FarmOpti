import readline from "node:readline";
import path from "node:path";
import { ExplanationService } from "./explanationService";
import type { RetrievedRecord } from "./retrieveDecisions";

function printEvidence(records: RetrievedRecord[]): void {
  if (records.length === 0) {
    console.log("\nNo evidence retrieved.");
    return;
  }

  console.log("\nRetrieved evidence:");
  records.forEach((record, i) => {
    console.log(`[${i + 1}] ${record.decision_id} | ${record.type} | score=${record.retrieval_score ?? "-"}`);
    console.log(record.text ?? "");
  });
}

async function interactiveChat(service: ExplanationService): Promise<void> {
  console.log(
    "\nFarmOpti Decision Chatbot\n\n" +
      "Commands:\n" +
      "  /summary            Explain key decisions\n" +
      "  /evidence <query>   Show raw retrieved evidence\n" +
      "  /quit               Exit\n",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const question = (await ask("You: ")).trim();
      if (!question) continue;

      if (["/quit", "/exit", "quit", "exit"].includes(question.toLowerCase())) break;

      if (question === "/summary") {
        const answer = await service.explainDefault();
        console.log(`\nFarmOpti: ${answer}\n`);
        continue;
      }

      if (question.startsWith("/evidence ")) {
        const query = question.slice("/evidence ".length).trim();
        const records = service.retriever.retrieve(query);
        printEvidence(records);
        console.log();
        continue;
      }

      const result = await service.answer(question);
      console.log(`\nFarmOpti: ${result.answer}\n`);

      if (result.needs_confirmation && result.pending_proposal) {
        const confirmation = (await ask("Apply this change? (yes/no): ")).trim().toLowerCase();
        if (["yes", "y"].includes(confirmation)) {
          console.log("\nApplying and re-optimising...");
          const outcome = await service.confirmConfigUpdate(result.pending_proposal);
          console.log(`\nFarmOpti: ${outcome.answer}\n`);
        } else {
          console.log("\nDiscarded -- no changes made.\n");
        }
      }
    }
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): { question?: string; summary: boolean; showEvidence: boolean; confirm: boolean } {
  let question: string | undefined;
  let summary = false;
  let showEvidence = false;
  let confirm = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--question") {
      question = argv[++i];
    } else if (argv[i] === "--summary") {
      summary = true;
    } else if (argv[i] === "--show-evidence") {
      showEvidence = true;
    } else if (argv[i] === "--confirm") {
      confirm = true;
    }
  }

  return { question, summary, showEvidence, confirm };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const service = new ExplanationService();

  if (args.summary) {
    const answer = await service.explainDefault();
    console.log(`\nFarmOpti: ${answer}`);
    return;
  }

  if (args.question) {
    const result = await service.answer(args.question, args.showEvidence);
    console.log(`\nFarmOpti: ${result.answer}`);
    if (args.showEvidence) printEvidence(result.evidence ?? []);

    if (result.needs_confirmation && result.pending_proposal) {
      if (args.confirm) {
        console.log("\nApplying and re-optimising (--confirm passed)...");
        const outcome = await service.confirmConfigUpdate(result.pending_proposal);
        console.log(`\nFarmOpti: ${outcome.answer}`);
      } else {
        console.log("\n(Not applied. Re-run with --confirm to apply this exact change, or use the interactive chatbot to review it first.)");
      }
    }
    return;
  }

  await interactiveChat(service);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
