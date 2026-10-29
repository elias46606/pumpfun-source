import type { FastifyInstance } from "fastify";
import type { operations } from "./generated/developer-api.js";
import type { ModerationStore } from "./moderation-store.js";

type BanResponse =
  operations["get_moderation_ban_address_by_address"]["responses"][200]["content"]["application/json"];
export const MODERATION_NATIVE_ROUTES = new Set([
  "GET /moderation/ban/address/{address}",
]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerModerationRoutes(
  app: FastifyInstance,
  store: ModerationStore,
): void {
  app.get<{ Params: { address: string } }>(
    "/v1/moderation/ban/address/:address",
    async (request, reply) => {
      const separator = request.url.indexOf("?");
      // The operation declares no query parameters; do not guess their meaning.
      if (separator >= 0 && request.url.length > separator + 1) {
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "MODERATION_QUERY_UNSUPPORTED",
        });
      }
      const banned: BanResponse = store.isBanned(request.params.address);
      // A verdict within this supplied local list, never a production ban decision.
      // The body is a bare JSON boolean, which Fastify will not serialize itself.
      return reply
        .type("application/json")
        .header("Cache-Control", "no-store")
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(JSON.stringify(banned));
    },
  );
}
