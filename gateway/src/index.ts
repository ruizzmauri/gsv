import { isWebSocketRequest } from "./utils";

export { Gateway } from "./gateway";
export { Session } from "./session";
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const stub = env.GATEWAY.get(env.GATEWAY.idFromName("singleton"));
      return stub.fetch(request);
    }

    // Serve media files from R2
    // /media/{uuid}.{ext}
    const mediaMatch = url.pathname.match(/^\/media\/([a-f0-9-]+\.[a-z0-9]+)$/i);
    if (mediaMatch && request.method === "GET") {
      const key = `media/${mediaMatch[1]}`;
      const object = await env.STORAGE.get(key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      // Check if expired
      const expiresAt = object.customMetadata?.expiresAt;
      if (expiresAt && parseInt(expiresAt, 10) < Date.now()) {
        // Clean up expired file
        await env.STORAGE.delete(key);
        return new Response("Expired", { status: 410 });
      }

      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
      headers.set("Cache-Control", "private, max-age=3600");
      // Allow cross-origin for LLM APIs
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(object.body, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
