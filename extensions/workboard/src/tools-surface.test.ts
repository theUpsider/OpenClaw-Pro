// Workboard tests pin the registered tool surface to the plugin's confined-name lists.
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardSessionsBoardTools } from "./tools-sessions-board.js";
import { createWorkboardTools } from "./tools.js";
import {
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./workspace-access.js";

describe("workboard tool surface names", () => {
  it("registers exactly the card tools that WORKBOARD_CARD_TOOL_NAMES confines", () => {
    const tools = createWorkboardTools({ store: createWorkboardSqliteTestStore() });

    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...WORKBOARD_CARD_TOOL_NAMES].toSorted(),
    );
  });

  it("registers exactly the Sessions board tools that its list confines", () => {
    const tools = createWorkboardSessionsBoardTools({
      store: createWorkboardSqliteTestStore(),
      caller: { assertCurrent: () => {} },
    });

    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES].toSorted(),
    );
  });
});
