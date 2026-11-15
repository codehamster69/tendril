import { planSubmission } from './chunks';
import type { PlanningRequest, PlanningReply } from './chunk-planner';

self.onmessage = (event: MessageEvent<PlanningRequest>) => {
  const { id, farm, logs, endTick } = event.data;
  let reply: PlanningReply;
  try { reply = { id, plan: planSubmission(farm, logs, endTick) }; }
  catch (error) { reply = { id, error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(reply);
};
