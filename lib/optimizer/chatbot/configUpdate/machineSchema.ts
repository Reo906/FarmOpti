import path from "node:path";
import { CANDIDATE_CONFIG } from "../../config";
import { readCsv, writeRawCsv } from "../../csv";
import { EXTERNAL_DIR } from "../../paths";

export class MachineValidationError extends Error {}

export interface MachineChangeInput {
  mode: "add" | "update";
  machine_id: string;
  machine_type?: string;
  cost_per_hour_aud?: number;
  current_field?: string;
  available_from?: string;
  available_to?: string;
}

export interface MachineChange {
  mode: "add" | "update";
  machine_id: string;
  machine_type: string;
  cost_per_hour_aud: number;
  current_field: string;
  available_from: string;
  available_to: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function describeMachinesForLlm(externalVariablesDir: string = EXTERNAL_DIR): Record<string, unknown> {
  const machines = readCsv(path.join(externalVariablesDir, "machines.csv"));
  const machineTypes = [...new Set(machines.map((m) => m.machine_type))].sort();

  return {
    purpose: "The equipment roster (machines.csv) and its daily availability (machine_availability_daily.csv). Use mode='add' for genuinely new equipment, mode='update' to change an existing machine's type/cost/field. Adding a machine also generates its availability rows across the whole existing planning horizon.",
    existing_machines: machines.map((m) => ({
      machine_id: m.machine_id,
      machine_type: m.machine_type,
      cost_per_hour_aud: Number(m.cost_per_hour_aud),
      current_field: m.current_field,
    })),
    known_machine_types: machineTypes,
    default_availability_hours: {
      from: `${pad2(Number(CANDIDATE_CONFIG.workday_start_hour))}:00`,
      to: `${pad2(Number(CANDIDATE_CONFIG.workday_end_hour))}:00`,
    },
  };
}

export function validateMachineChange(input: MachineChangeInput, externalVariablesDir: string = EXTERNAL_DIR): MachineChange {
  const machines = readCsv(path.join(externalVariablesDir, "machines.csv"));
  const existing = machines.find((m) => m.machine_id === input.machine_id);

  if (input.mode === "add" && existing) {
    throw new MachineValidationError(`Machine ${input.machine_id} already exists; use mode="update" instead`);
  }
  if (input.mode === "update" && !existing) {
    throw new MachineValidationError(`Unknown machine ${input.machine_id}; use mode="add" for new equipment`);
  }

  const machineType = input.machine_type ?? existing?.machine_type;
  if (!machineType) throw new MachineValidationError("machine_type is required");

  const cost = input.cost_per_hour_aud ?? (existing ? Number(existing.cost_per_hour_aud) : undefined);
  if (cost === undefined || Number.isNaN(cost)) throw new MachineValidationError("cost_per_hour_aud must be a number");
  if (cost <= 0) throw new MachineValidationError("cost_per_hour_aud must be positive");

  const defaultFrom = `${pad2(Number(CANDIDATE_CONFIG.workday_start_hour))}:00`;
  const defaultTo = `${pad2(Number(CANDIDATE_CONFIG.workday_end_hour))}:00`;

  return {
    mode: input.mode,
    machine_id: input.machine_id,
    machine_type: machineType,
    cost_per_hour_aud: cost,
    current_field: input.current_field ?? existing?.current_field ?? "",
    available_from: input.available_from ?? defaultFrom,
    available_to: input.available_to ?? defaultTo,
  };
}

export function applyMachineChange(change: MachineChange, externalVariablesDir: string = EXTERNAL_DIR): void {
  const machinesPath = path.join(externalVariablesDir, "machines.csv");
  const machines = readCsv(machinesPath);

  if (change.mode === "add") {
    machines.push({
      machine_id: change.machine_id,
      machine_type: change.machine_type,
      cost_per_hour_aud: String(change.cost_per_hour_aud),
      current_field: change.current_field,
    });
  } else {
    const row = machines.find((m) => m.machine_id === change.machine_id);
    if (!row) throw new MachineValidationError(`Unknown machine ${change.machine_id}`);
    row.machine_type = change.machine_type;
    row.cost_per_hour_aud = String(change.cost_per_hour_aud);
    row.current_field = change.current_field;
  }

  writeRawCsv(machinesPath, machines);

  if (change.mode === "add") {
    const availabilityPath = path.join(externalVariablesDir, "machine_availability_daily.csv");
    const availability = readCsv(availabilityPath);
    const dates = [...new Set(availability.map((r) => r.date))].sort();

    for (const date of dates) {
      availability.push({
        date,
        machine_id: change.machine_id,
        available: "1",
        available_from: change.available_from,
        available_to: change.available_to,
      });
    }

    availability.sort((a, b) => (a.date === b.date ? (a.machine_id < b.machine_id ? -1 : 1) : a.date < b.date ? -1 : 1));
    writeRawCsv(availabilityPath, availability);
  }
}

/** Convenience for the LLM prompt: what dates availability rows will be generated for. */
export function getAvailabilityHorizon(externalVariablesDir: string = EXTERNAL_DIR): string[] {
  const availability = readCsv(path.join(externalVariablesDir, "machine_availability_daily.csv"));
  return [...new Set(availability.map((r) => r.date))].sort();
}
