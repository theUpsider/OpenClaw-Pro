// Lobster test API exposes the decision-bridge surface that repo-level integration suites drive.
// Keeps those suites on a public extension surface instead of private `src/` paths.
export {
  createLobsterRegistry,
  type DecisionEvaluator,
  type LobsterRegistry,
} from "./src/decision-bridge.js";
