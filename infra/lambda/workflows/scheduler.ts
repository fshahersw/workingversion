import { scheduledTick } from "../../../src/lib/workflows/repository.server";
export async function handler() {
  await scheduledTick();
}
