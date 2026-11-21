import { Type } from "typebox";
import {
  isGoalVerificationEnabled,
  resolveGoalCompletionGate,
} from "../../config/sessions/goal-verification-gate.js";
import { SessionGoalTransitionError } from "../../config/sessions/goals-transitions.js";
import {
  createSessionGoal,
  getSessionGoal,
  MODEL_UPDATABLE_SESSION_GOAL_STATUSES,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";

type GoalToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
};

const GetGoalToolSchema = Type.Object({});

/**
 * The `create_goal` schema, including the verification opt-in. The parameter is
 * offered only while the global verification switch is on, so with the gate off
 * the tool surface advertises no inert parameter. Both variants are built once
 * and reused, so tool construction stays schema-identical across turns.
 */
let createGoalSchemaWithVerification: ReturnType<typeof Type.Object> | undefined;
let createGoalSchemaWithoutVerification: ReturnType<typeof Type.Object> | undefined;

function resolveCreateGoalToolSchema(verificationEnabled: boolean) {
  if (verificationEnabled) {
    createGoalSchemaWithVerification ??= Type.Object({
      objective: Type.String({
        description: "Concrete objective; explicit request only.",
      }),
      token_budget: Type.Optional(
        Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
          description: "Positive token budget. Omit or pass null unless explicitly requested.",
        }),
      ),
      verify_completion: Type.Optional(
        Type.Union([Type.Boolean(), Type.Null()], {
          description:
            "Opt this goal into adversarial completion verification when the operator asks for it. Omit otherwise.",
        }),
      ),
    });
    return createGoalSchemaWithVerification;
  }
  createGoalSchemaWithoutVerification ??= Type.Object({
    objective: Type.String({
      description: "Concrete objective; explicit request only.",
    }),
    token_budget: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
        description: "Positive token budget. Omit or pass null unless explicitly requested.",
      }),
    ),
  });
  return createGoalSchemaWithoutVerification;
}

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(MODEL_UPDATABLE_SESSION_GOAL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
});

function resolveGoalSessionScope(options: GoalToolOptions) {
  const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const parsedSessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const parsedAgentSessionAgentId = parseAgentSessionKey(options.agentSessionKey)?.agentId;
  // Prefer the run session's agent id; fall back to the agent session for legacy tool contexts.
  const agentId = normalizeAgentId(
    parsedSessionAgentId ?? parsedAgentSessionAgentId ?? options.sessionAgentId,
  );
  return {
    sessionKey,
    agentId,
    storePath: resolveSessionStorePathCore(options.config?.session?.store, {
      agentId,
    }),
  };
}

export function createGetGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Get Goal",
    name: "get_goal",
    displaySummary: "Get the current thread goal",
    description:
      "Get the current session goal, including its full objective, status, token usage, and optional budget.",
    parameters: GetGoalToolSchema,
    execute: async () => {
      const snapshot = await getSessionGoal({
        ...resolveGoalSessionScope(options),
        persist: false,
      });
      return jsonResult(snapshot);
    },
  };
}

export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  const verificationEnabled = options.config ? isGoalVerificationEnabled(options.config) : false;
  return {
    label: "Create Goal",
    name: "create_goal",
    displaySummary: "Create a thread goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. Set a positive token_budget only when a budget is explicitly requested; otherwise omit it or pass null. Fails if a goal already exists; the user must clear it before starting another.",
    parameters: resolveCreateGoalToolSchema(verificationEnabled),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const objective = readToolStringParam(params, "objective", { required: true });
      const tokenBudget = readPositiveIntegerParam(params, "token_budget", {
        message: "token_budget must be a positive integer",
      });
      const scope = resolveGoalSessionScope(options);
      const goal = await createSessionGoal({
        ...scope,
        actor: { type: "agent", id: scope.sessionKey },
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        // Only a literal true opts in; the flag is captured at creation and is
        // never widened by a later global switch.
        ...(params.verify_completion === true ? { verifyCompletion: true } : {}),
      });
      return jsonResult({ status: "created", goal });
    },
  };
}

export function createUpdateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Update Goal",
    name: "update_goal",
    displaySummary: "Complete or block a thread goal",
    description:
      "Mark the session goal complete only when the full objective is verified and no required work remains. Mark it blocked only when the same blocker has recurred for at least three consecutive goal turns and no meaningful progress is possible without user input or an external change. After the user resumes a blocked goal, count those turns from the resume. Difficulty, incomplete work, or a nearly exhausted budget do not justify completion or blocking. Updating a goal does not reply to the user; provide the requested final response afterward.",
    parameters: UpdateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const requestedStatus = readToolStringParam(params, "status", { required: true });
      const status = MODEL_UPDATABLE_SESSION_GOAL_STATUSES.find(
        (candidate) => candidate === requestedStatus,
      );
      if (status === undefined) {
        throw new ToolInputError(
          `status must be one of ${MODEL_UPDATABLE_SESSION_GOAL_STATUSES.join(", ")}`,
        );
      }
      const note = readToolStringParam(params, "note");
      const scope = resolveGoalSessionScope(options);
      try {
        // The global switch is checked before the read: with the gate off this
        // path performs no I/O at all, so the default-off behavior is unchanged.
        if (status === "complete" && options.config && isGoalVerificationEnabled(options.config)) {
          // Adversarial completion verification (opt-in): completion is refused
          // unless a passing verdict exists for the goal's current state.
          const snapshot = await getSessionGoal({ ...scope, persist: false });
          const gate = resolveGoalCompletionGate({
            cfg: options.config,
            goal: snapshot.goal,
          });
          if (gate.refusal) {
            return jsonResult({
              status: "refused",
              reason: gate.refusal.outcome,
              missingPoints: gate.refusal.missingPoints,
              error: gate.refusal.message,
              nextAction:
                "The goal stays active and incomplete. Do not retry update_goal; address the listed points or keep working, and state completion again when the verifier can pass.",
            });
          }
        }
        const goal = await updateSessionGoalStatus({
          ...scope,
          actor: { type: "agent", id: scope.sessionKey },
          status,
          ...(note ? { note } : {}),
        });
        return jsonResult({
          status: "updated",
          goal,
          nextAction:
            "Goal status was updated, but no reply was sent to the user. Continue this turn and provide the requested visible final response.",
        });
      } catch (err) {
        if (err instanceof SessionGoalTransitionError) {
          return jsonResult({
            status: "error",
            error: err.message,
            nextAction:
              "Do not retry update_goal. No active goal requires a status change — continue this turn and provide your response to the user.",
          });
        }
        throw err;
      }
    },
  };
}
