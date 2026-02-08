import type { Handler } from "../../protocol/methods";

export const handleHeartbeatTrigger: Handler<"heartbeat.trigger"> = async (
  gw,
  params,
) => {
  const agentId = params?.agentId ?? "main";
  return await gw.triggerHeartbeat(agentId);
};

export const handleHeartbeatStatus: Handler<"heartbeat.status"> = async (gw) => {
  const status = await gw.getHeartbeatStatus();
  return { agents: status };
};

export const handleHeartbeatStart: Handler<"heartbeat.start"> = async (gw) => {
  await gw.scheduleHeartbeat();
  const status = await gw.getHeartbeatStatus();
  return {
    message: "Heartbeat scheduler started",
    agents: status,
  };
};
