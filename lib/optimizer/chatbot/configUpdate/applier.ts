import fs from "node:fs";
import { CONFIG_PATH, EXTERNAL_DIR } from "../../paths";
import { formatYamlScalar, setYamlScalarByPath } from "./yamlEditor";
import { applyMachineChange } from "./machineSchema";
import { addRule, removeRule } from "../../rules/store";
import type { ConfigChangeProposal } from "./parser";

export function applyConfigChangeProposal(proposal: ConfigChangeProposal, externalVariablesDir: string = EXTERNAL_DIR): void {
  if (proposal.kind === "unsupported") {
    throw new Error(`Cannot apply an unsupported proposal: ${proposal.reason}`);
  }

  if (proposal.kind === "config_update") {
    const text = fs.readFileSync(CONFIG_PATH, "utf-8");
    const literal = formatYamlScalar(proposal.new_value);
    const updated = setYamlScalarByPath(text, proposal.path.split("."), literal);
    fs.writeFileSync(CONFIG_PATH, updated);
    return;
  }

  if (proposal.kind === "rule_change") {
    if (proposal.action === "add") addRule(proposal.rule);
    else removeRule(proposal.rule.id);
    return;
  }

  applyMachineChange(proposal.change, externalVariablesDir);
}
