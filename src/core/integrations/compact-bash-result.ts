import {
  getCommandName,
  getEffectiveCommandArgv,
  stripLeadingCdPrefix,
  stripLeadingEnvAssignments,
  tokenizeCommand,
  unwrapShellRunner,
} from "../command.js";
import { getInspectionCommandSkipReason, getSafeRepositoryInventorySourceArgv } from "../inventory-safety.js";
import { readNoOmissionFromEnv } from "../env.js";
import { shouldRecordStats } from "../artifacts.js";
import { buildInspectionSummary } from "../reduce-inspection-summary.js";
import { reduceExecution } from "../reduce.js";
import { getCompactionSkipReason, type RewritePolicyOptions } from "./rewrite-policy.js";

import type { CompactResult, ReduceOptions, ToolExecutionInput } from "../../types.js";
import type { InspectionCommandPolicy, InspectionCommandSkipReason } from "../inventory-safety.js";

export type CompactBashResultInput = {
  source: "claude-code" | "cline" | "codex" | "command-code" | "copilot-agent" | "copilot-cli" | "droid" | "gemini-cli" | "grok-cli" | "kimi" | "mux" | "openclaw" | "openhands" | "opencode" | "pi" | "qwen-code";
  command: string;
  cwd?: string;
  visibleText: string;
  trustedFullText?: string;
  exitCode?: number;
  maxInlineChars?: number;
  noOmit?: boolean;
  allowOmit?: boolean;
  storeRaw?: boolean;
  recordStats?: boolean;
  metadata?: Record<string, unknown>;
  inspectionPolicy?: InspectionCommandPolicy;
  /** @deprecated use inspectionPolicy instead. */
  skipInspectionCommands?: boolean;
  skipCommandNames?: readonly string[];
} & RewritePolicyOptions;

export type CompactBashResultKeepReason =
  | "empty-output"
  | InspectionCommandSkipReason
  | "configured-command"
  | "unsupported"
  | "no-compaction"
  | "low-savings-compaction"
  | "generic-compound-command"
  | "generic-weak-compaction";

export type CompactBashResultOutput =
  | {
      action: "keep";
      reason: CompactBashResultKeepReason;
      rawText: string;
      usedTrustedFullText: boolean;
      result?: CompactResult;
    }
  | {
      action: "rewrite";
      rawText: string;
      usedTrustedFullText: boolean;
      result: CompactResult;
    };

function resolveInspectionPolicy(input: CompactBashResultInput): InspectionCommandPolicy {
  if (input.inspectionPolicy) {
    return input.inspectionPolicy;
  }
  return input.skipInspectionCommands ? "skip-all" : "compact-all";
}

export function getOutputAwareInspectionSkipReason(
  policy: InspectionCommandPolicy,
  executionInput: ToolExecutionInput,
): InspectionCommandSkipReason | null {
  const command = executionInput.command ?? "";
  const rawText = executionInput.combinedText ?? "";
  const inspectionSkipReason = getInspectionCommandSkipReason(command, policy);
  if (
    inspectionSkipReason === "file-content-inspection-command"
    && buildInspectionSummary(executionInput, rawText)
  ) {
    return null;
  }
  return inspectionSkipReason;
}

export function shouldSkipCommand(command: string, skipCommandNames?: readonly string[]): boolean {
  if (!skipCommandNames?.length) {
    return false;
  }

  let candidate = command;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    candidate = stripLeadingCdPrefix(candidate);
    const effectiveArgv = getEffectiveCommandArgv({ command: candidate });
    const argv = effectiveArgv.length > 0
      ? effectiveArgv
      : stripLeadingEnvAssignments(tokenizeCommand(candidate));
    const shellBody = unwrapShellRunner({ argv, command: candidate });
    if (shellBody) {
      candidate = shellBody;
      continue;
    }
    const commandName = getCommandName(argv);
    return Boolean(commandName && skipCommandNames.includes(commandName));
  }

  return false;
}

export async function compactBashResult(input: CompactBashResultInput): Promise<CompactBashResultOutput> {
  const command = input.command.trim();
  if (!command) {
    return {
      action: "keep",
      reason: "unsupported",
      rawText: "",
      usedTrustedFullText: false,
    };
  }

  const rawText = input.trustedFullText ?? input.visibleText;
  const usedTrustedFullText = typeof input.trustedFullText === "string";
  if (!rawText.trim()) {
    return {
      action: "keep",
      reason: "empty-output",
      rawText,
      usedTrustedFullText,
    };
  }

  const safeInventoryArgv = getSafeRepositoryInventorySourceArgv(command);
  const executionInput: ToolExecutionInput = {
    toolName: "exec",
    command,
    combinedText: rawText,
    ...(safeInventoryArgv ? { argv: safeInventoryArgv } : {}),
    ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd } : {}),
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  if (shouldSkipCommand(command, input.skipCommandNames)) {
    return {
      action: "keep",
      reason: "configured-command",
      rawText,
      usedTrustedFullText,
    };
  }

  const inspectionSkipReason = getOutputAwareInspectionSkipReason(resolveInspectionPolicy(input), executionInput);
  if (inspectionSkipReason) {
    return {
      action: "keep",
      reason: inspectionSkipReason,
      rawText,
      usedTrustedFullText,
    };
  }

  const options: ReduceOptions = {
    ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd } : {}),
    ...(typeof input.maxInlineChars === "number" ? { maxInlineChars: input.maxInlineChars } : {}),
    ...(input.noOmit || (!input.allowOmit && readNoOmissionFromEnv()) ? { noOmit: true } : {}),
    recordStats: input.recordStats ?? shouldRecordStats(),
    ...(input.storeRaw ? { store: true } : {}),
  };

  const result = await reduceExecution(executionInput, options);
  const skipReason = getCompactionSkipReason(command, rawText, result, input);
  if (skipReason) {
    return {
      action: "keep",
      reason: skipReason,
      rawText,
      usedTrustedFullText,
      result,
    };
  }

  return {
    action: "rewrite",
    rawText,
    usedTrustedFullText,
    result,
  };
}
