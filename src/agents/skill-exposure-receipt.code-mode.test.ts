import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { serializeModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState, runUntilCompleted } from "./code-mode.test-support.js";
import { createSkillExposureReceiptCollector } from "./skill-exposure-receipt.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

afterEach(resetCodeModeTestState);

it("excludes a real nested Code Mode read/discard from outer-reply inclusion evidence", async () => {
  const name = "skill-exposure-discard";
  const collector = createSkillExposureReceiptCollector(`run-code-mode-${name}`);
  const owner = createSubscribedCodeModeHarness({
    name,
    onAgentToolResult: collector.onAgentToolResult,
  });
  let reads = 0;
  const native = createInstalledSkillTools(
    [
      {
        name: "guide",
        description: "Guide",
        location: "skill://guide",
        source: { filePath: "/synthetic/SKILL.md" },
        reader: async () => {
          reads++;
          return "Complete instructions that the guest will discard.";
        },
      },
    ],
    owner.runId,
  );
  applyCodeModeCatalog({ ...owner, tools: [...owner.tools, ...native] });
  try {
    const result = await runUntilCompleted({
      execTool: expectDefined(owner.tools[0], "exec tool"),
      waitTool: expectDefined(owner.tools[1], "wait tool"),
      code: 'await skills.read("guide"); return "done";',
    });
    await owner.subscription.waitForPendingEvents();
    expect(reads).toBe(1);
    expect(result).toMatchObject({ status: "completed", value: "done" });
    const encoded = serializeModelRequestBody({
      messages: [{ role: "tool", tool_call_id: "code-call-1", content: JSON.stringify(result) }],
    });
    collector.beginRequest(owner.runId, { api: "openai-completions" })?.(encoded.body);
    expect(collector.finish()).toMatchObject({
      loadedSkills: [],
      skillExposure: { status: "available" },
    });
  } finally {
    owner.dispose();
  }
});
