import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ConstraintScenario {
  mode: string;
  description?: string;
  changes: unknown[];
}

export interface ConstraintProposal {
  proposalId: string;
  sessionId: string;
  sourceText: string;
  scenario: ConstraintScenario;
  resolvedChanges: unknown[];
  comparison: Record<string, unknown>;
  summary: Record<string, unknown>;
  schedule: Record<string, unknown>[];
  status: "pending_confirmation" | "confirmed" | "rejected";
  createdAt: string;
  confirmedAt?: string;
}

const MAX_CONFIRMED = 100;

let instance: ConstraintStore | null = null;

export function getConstraintStore(): ConstraintStore {
  instance ??= new ConstraintStore(
    process.env.FARMOPTI_CONSTRAINT_STORE_PATH ??
      "runtime/confirmed_constraints.json",
  );
  return instance;
}

export class ConstraintStore {
  private storePath: string | null;
  private pending = new Map<string, ConstraintProposal>();
  private confirmedList: ConstraintProposal[] = [];

  constructor(storePath?: string | null) {
    this.storePath = storePath ?? null;
    this.load();
  }

  private load(): void {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const payload = JSON.parse(raw) as { confirmed?: ConstraintProposal[] };
      this.confirmedList = Array.isArray(payload?.confirmed)
        ? payload.confirmed
        : [];
    } catch (exc: any) {
      throw new Error(
        `Could not load confirmed constraints from ${this.storePath}: ${exc.message ?? exc}`,
      );
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    const resolved = path.resolve(this.storePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const payload =
      JSON.stringify({ version: 1, confirmed: this.confirmedList }, null, 2) +
      "\n";
    const tmpPath = path.join(
      path.dirname(resolved),
      `.tmp-${crypto.randomUUID()}.json`,
    );
    try {
      fs.writeFileSync(tmpPath, payload, "utf-8");
      fs.renameSync(tmpPath, resolved);
    } catch (exc) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw exc;
    }
  }

  propose(
    sessionId: string,
    sourceText: string,
    evaluation: {
      scenario: ConstraintScenario;
      resolvedChanges?: unknown[];
      comparison?: Record<string, unknown>;
      summary?: Record<string, unknown>;
      schedule?: Record<string, unknown>[];
    },
  ): ConstraintProposal {
    if (!evaluation.scenario?.changes?.length) {
      throw new Error("FarmOpti did not return a validated constraint change.");
    }
    const proposal: ConstraintProposal = {
      proposalId: crypto.randomUUID(),
      sessionId,
      sourceText,
      scenario: structuredClone(evaluation.scenario),
      resolvedChanges: structuredClone(evaluation.resolvedChanges ?? []),
      comparison: structuredClone(evaluation.comparison ?? {}),
      summary: structuredClone(evaluation.summary ?? {}),
      schedule: structuredClone(evaluation.schedule ?? []),
      status: "pending_confirmation",
      createdAt: new Date().toISOString(),
    };
    this.pending.set(sessionId, proposal);
    return proposal;
  }

  getPending(sessionId: string): ConstraintProposal | undefined {
    return this.pending.get(sessionId);
  }

  confirm(sessionId: string, proposalId?: string): ConstraintProposal {
    const proposal = this.pending.get(sessionId);
    if (!proposal) throw new Error("No pending constraint change in this session.");
    if (proposalId && proposal.proposalId !== proposalId)
      throw new Error("Proposal ID does not match.");
    const confirmed: ConstraintProposal = {
      ...proposal,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    };
    this.confirmedList.push(confirmed);
    if (this.confirmedList.length > MAX_CONFIRMED)
      this.confirmedList = this.confirmedList.slice(-MAX_CONFIRMED);
    this.pending.delete(sessionId);
    this.persist();
    return confirmed;
  }

  reject(sessionId: string, proposalId?: string): ConstraintProposal {
    const proposal = this.pending.get(sessionId);
    if (!proposal) throw new Error("No pending constraint change in this session.");
    if (proposalId && proposal.proposalId !== proposalId)
      throw new Error("Proposal ID does not match.");
    const rejected: ConstraintProposal = { ...proposal, status: "rejected" };
    this.pending.delete(sessionId);
    return rejected;
  }

  clearPending(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  getConfirmed(): ConstraintProposal[] {
    return [...this.confirmedList];
  }

  activeScenario(): {
    mode: "scenario";
    description: string;
    changes: unknown[];
  } | null {
    const changes = this.confirmedList.flatMap((p) =>
      structuredClone(p.scenario.changes ?? []),
    );
    if (changes.length === 0) return null;
    return {
      mode: "scenario",
      description: "Confirmed farmer constraints",
      changes,
    };
  }
}
