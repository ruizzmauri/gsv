// base error shape used in responses
export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

// generic request frame with method and params
export type RequestFrame<Method extends string = string, Params = unknown> = {
  type: "req";
  id: string;
  method: Method;
  params?: Params;
};

// successful response frame with result
export type ResponseOkFrame<Payload = unknown> = {
  type: "res";
  id: string;
  ok: true;
  payload?: Payload;
};

// error response frame with error details
export type ResponseErrFrame = {
  type: "res";
  id: string;
  ok: false;
  error: ErrorShape;
};

// union response frames
export type ResponseFrame<Payload = unknown> =
  | ResponseOkFrame<Payload>
  | ResponseErrFrame;

// generic event frame with event name and payload
export type EventFrame<Payload = unknown> = {
  type: "evt";
  event: string;
  payload?: Payload;
  seq?: number;
};

// union frame type
export type Frame = RequestFrame | ResponseFrame | EventFrame;
