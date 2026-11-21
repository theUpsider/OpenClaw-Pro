import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/components/config-form.analyze.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

/**
 * The settings editor is schema-driven, so a new config section only becomes editable when it
 * survives the Control UI's schema projection. A record-of-records such as `byModel` is the shape
 * most likely to be dropped, which is why the assertion names it explicitly.
 */
describe("tools.pathScopes in the Control UI schema", () => {
  it("projects the section and its nested rule shape as editable", () => {
    const response = computeBaseConfigSchemaResponse({});
    const schema = response.schema as Record<string, unknown>;
    const tools = (schema.properties as Record<string, unknown>).tools as Record<string, unknown>;
    const toolProps = tools.properties as Record<string, unknown>;
    const pathScopes = toolProps.pathScopes as Record<string, unknown>;
    expect(pathScopes).toBeDefined();

    const scopesProps = pathScopes.properties as Record<string, unknown>;
    expect(scopesProps.allowExecWithEntries).toBeDefined();
    const byModel = scopesProps.byModel as Record<string, unknown>;
    expect(byModel).toBeDefined();
    // The map value carries the entry list a user edits; losing it would leave the section read-only.
    const valueSchema = (byModel.additionalProperties ?? byModel.items) as Record<string, unknown>;
    expect(valueSchema).toBeDefined();
    expect((valueSchema.properties as Record<string, unknown>).entries).toBeDefined();

    const analysis = analyzeConfigSchema(response.schema as never);
    const unsupportedHere = analysis.unsupportedPaths.filter((path) =>
      path.startsWith("tools.pathScopes"),
    );
    expect(unsupportedHere).toEqual([]);
  });

  it("carries the same section for the per-agent override", () => {
    const response = computeBaseConfigSchemaResponse({});
    const schema = response.schema as Record<string, unknown>;
    const agents = (schema.properties as Record<string, unknown>).agents as Record<string, unknown>;
    const entries = (agents.properties as Record<string, unknown>).entries as Record<
      string,
      unknown
    >;
    const entrySchema = (entries.additionalProperties ?? entries.items) as Record<string, unknown>;
    const agentTools = (entrySchema.properties as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    expect((agentTools.properties as Record<string, unknown>).pathScopes).toBeDefined();
  });
});
