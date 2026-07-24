import type { ActionDefinition, ActionExecutor, ActionManifest, SchemaAdapter } from "../types.js";
import { defineAction } from "../index.js";

export interface TypeScriptActionInput<TInput, TOutput> extends ActionExecutor<TInput, TOutput> {
  manifest: ActionManifest;
  input?: SchemaAdapter<TInput>;
  output?: SchemaAdapter<TOutput>;
}

export function createTypeScriptAction<TInput = unknown, TOutput = unknown>(
  input: TypeScriptActionInput<TInput, TOutput>,
): ActionDefinition<TInput, TOutput> {
  return defineAction({
    manifest: input.manifest,
    input: input.input,
    output: input.output,
    executor: {
      plan: input.plan,
      preview: input.preview,
      execute: input.execute,
      rollback: input.rollback,
    },
  });
}

