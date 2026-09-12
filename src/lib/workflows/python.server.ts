import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { WorkflowError } from "./policy";
import type { ExecutionContext } from "./types";

/** A new isolated session for each invocation. Never use the chat module's global session. */
export async function runIsolatedPython(code: string, ctx: ExecutionContext) {
  const identifier = process.env.SW_WORKFLOWS_PYTHON_INTERPRETER_ID;
  if (!identifier)
    throw new WorkflowError(
      503,
      "An isolated workflow Python interpreter has not been configured.",
    );
  if (!code.trim() || code.length > 20000)
    throw new WorkflowError(400, "Supply Python code of 1–20,000 characters.");
  const client = new BedrockAgentCoreClient({ region: process.env.BEDROCK_REGION || "us-east-1" });
  let sessionId: string | undefined;
  try {
    const session = await client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: identifier,
        name: `workflow-${crypto.randomUUID()}`,
        sessionTimeoutSeconds: 900,
      }),
      { abortSignal: ctx.signal },
    );
    sessionId = session.sessionId;
    if (!sessionId) throw new Error("Session not created.");
    async function invoke(name: "writeFiles" | "executeCode", args: Record<string, unknown>) {
      const result = await client.send(
        new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: identifier!,
          sessionId: sessionId!,
          name,
          arguments: args,
        }),
        { abortSignal: ctx.signal },
      );
      let text = "",
        gotResult = false;
      for await (const event of result.stream || []) {
        const data = (event as { result?: { isError?: boolean; content?: { text?: string }[] } })
          .result;
        if (!data) {
          if (Object.keys(event).some((k) => /exception/i.test(k)))
            throw new Error("Interpreter stream failed.");
          continue;
        }
        gotResult = true;
        if (data.isError)
          throw new WorkflowError(
            422,
            "Python reported an error. Review the code and source inputs.",
          );
        text += (data.content || []).map((c) => c.text || "").join("\n");
        if (text.length > 500000)
          throw new WorkflowError(
            413,
            "Python output exceeds 500,000 characters. Write a smaller result.",
          );
      }
      if (!gotResult) throw new Error("Interpreter returned no result.");
      return text;
    }
    await invoke("writeFiles", {
      content: [
        {
          path: "workflow_inputs.json",
          text: JSON.stringify({ inputs: ctx.inputs, values: ctx.values }),
        },
      ],
    });
    const text = await invoke("executeCode", { code, language: "python", clearContext: true });
    return { text, execution: "isolated-python", inputFile: "workflow_inputs.json" };
  } finally {
    if (sessionId) {
      try {
        await client.send(
          new StopCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: identifier,
            sessionId,
          }),
        );
      } catch {
        console.error("Workflow interpreter cleanup failed", { sessionId });
      }
    }
    client.destroy();
  }
}
