from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chatbot.explanation_service import ExplanationService


def print_evidence(records):
    if not records:
        print("\nNo evidence retrieved.", flush=True)
        return

    print("\nRetrieved evidence:", flush=True)

    for i, record in enumerate(records, start=1):
        print(
            f"[{i}] {record.get('decision_id')} | {record.get('type')} | score={record.get('retrieval_score', '-')}",
            flush=True,
        )
        print(record.get("text", ""), flush=True)


def interactive_chat(service):
    print(
        "\nFarmOpti Decision Chatbot\n\n"
        "Commands:\n"
        "  /summary            Explain key decisions\n"
        "  /evidence <query>   Show raw retrieved evidence\n"
        "  /quit               Exit\n",
        flush=True,
    )

    while True:
        try:
            question = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not question:
            continue

        if question.lower() in ("/quit", "/exit", "quit", "exit"):
            break

        if question == "/summary":
            answer = service.explain_default()
            print(f"\nFarmOpti: {answer}\n", flush=True)
            continue

        if question.startswith("/evidence "):
            query = question[len("/evidence "):].strip()
            records = service.retriever.retrieve(query)
            print_evidence(records)
            print()
            continue

        result = service.answer(question)
        print(f"\nFarmOpti: {result['answer']}\n", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", type=str, default=None, help="Ask one question and exit.")
    parser.add_argument("--summary", action="store_true", help="Explain the main optimisation decisions.")
    parser.add_argument("--show-evidence", action="store_true", help="Show retrieved evidence after the answer.")
    args = parser.parse_args()

    service = ExplanationService()

    if args.summary:
        answer = service.explain_default()
        print(f"\nFarmOpti: {answer}", flush=True)
        return

    if args.question:
        result = service.answer(args.question, return_evidence=args.show_evidence)
        print(f"\nFarmOpti: {result['answer']}", flush=True)

        if args.show_evidence:
            print_evidence(result.get("evidence", []))

        return

    interactive_chat(service)


if __name__ == "__main__":
    main()