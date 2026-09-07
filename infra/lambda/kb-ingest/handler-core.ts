export type SqsRecord = {
  messageId: string;
  body: string;
};

export type SqsBatchEvent = {
  Records?: SqsRecord[];
};

export type SqsBatchResponse = {
  batchItemFailures: { itemIdentifier: string }[];
};

export function createSqsBatchHandler(
  processBody: (body: string) => Promise<void>,
): (event: SqsBatchEvent) => Promise<SqsBatchResponse> {
  return async (event) => {
    const records = Array.isArray(event.Records) ? event.Records : [];
    const outcomes = await Promise.all(
      records.map(async (record) => {
        if (!record?.messageId || typeof record.body !== "string") {
          return record?.messageId || "invalid-record";
        }
        try {
          await processBody(record.body);
          return null;
        } catch {
          return record.messageId;
        }
      }),
    );
    return {
      batchItemFailures: outcomes.flatMap((itemIdentifier) =>
        itemIdentifier ? [{ itemIdentifier }] : [],
      ),
    };
  };
}

export function createScheduledReconcilerHandler<T>(reconcile: () => Promise<T>): () => Promise<T> {
  return () => reconcile();
}
