export type InterpreterContentItem = {
  type?: string;
  text?: string;
  data?: string;
  source?: { data?: string };
  name?: string;
  path?: string;
};

/** A transport ending is not proof that a remote Python operation completed. */
export async function drainInterpreterStream(
  resp: unknown,
): Promise<{ content: InterpreterContentItem[]; isError: boolean }> {
  const content: InterpreterContentItem[] = [];
  let isError = false;
  let receivedResult = false;
  let taskStatus: string | undefined;
  const stream = (resp as { stream?: AsyncIterable<unknown> })?.stream;
  if (stream) {
    for await (const ev of stream) {
      if (!ev || typeof ev !== "object")
        throw new Error("Python returned an invalid stream event.");
      if (Object.keys(ev).some((key) => key.endsWith("Exception")))
        throw new Error("Python returned a service error; execution completion is unconfirmed.");
      const r = (
        ev as {
          result?: {
            content?: InterpreterContentItem[];
            isError?: boolean;
            structuredContent?: { taskStatus?: string };
          };
        }
      ).result;
      if (!r) continue;
      receivedResult = true;
      taskStatus = r.structuredContent?.taskStatus ?? taskStatus;
      if (r.isError) isError = true;
      // AWS terminal task statuses are independent of the optional isError flag.
      if (taskStatus === "failed" || taskStatus === "canceled") isError = true;
      for (const c of r.content ?? []) content.push(c);
    }
  }
  if (!receivedResult || (taskStatus && !["completed", "failed", "canceled"].includes(taskStatus)))
    throw new Error("Python execution did not return a completed result.");
  return { content, isError };
}
