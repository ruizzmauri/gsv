export type LogsGetParams = {
  nodeId?: string;
  lines?: number;
};

export type LogsGetEventPayload = {
  callId: string;
  lines: number;
};

export type LogsResultParams = {
  callId: string;
  lines?: string[];
  truncated?: boolean;
  error?: string;
};

export type LogsGetResult = {
  nodeId: string;
  lines: string[];
  count: number;
  truncated: boolean;
};
