import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleConfigGet: Handler<"config.get"> = ({ gw, params }) => {
  if (params?.path) {
    // Get specific path
    const value = gw.getConfigPath(params.path);
    return { path: params.path, value };
  } else {
    // Get full config masking API keys and tokens
    const safeConfig = gw.getSafeConfig();
    return { config: safeConfig };
  }
};

export const handleConfigSet: Handler<"config.set"> = ({ gw, params }) => {
  if (!params?.path) {
    throw new RpcError(400, "path required");
  }

  gw.setConfigPath(params.path, params.value);
  return { ok: true, path: params.path };
};
