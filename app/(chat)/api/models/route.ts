import { getAllCapabilities } from "@/lib/ai/available-models";

/**
 * Capabilities for the single automatic TheStudent AI route. Provider and
 * underlying model identities remain server-side.
 */
export function GET() {
  return Response.json(
    { capabilities: getAllCapabilities(), extraModels: [] },
    {
      headers: {
        "Cache-Control":
          "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      },
    }
  );
}
