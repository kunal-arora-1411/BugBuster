import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BugBusterEventSchema,
  EnvelopeItemSchema,
  IssueSchema,
  LogEntrySchema,
  SampleDirectiveSchema,
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
} from "@bugbusterhq/types";

/**
 * The OpenAPI 3.1 description of every HTTP route this backend serves — what `GET /openapi.json`
 * returns and what Swagger UI at `GET /docs` renders. docs/openapi.json is a committed copy
 * (regenerate with `pnpm --filter @bugbusterhq/backend openapi`).
 *
 * The data shapes are GENERATED from the same zod schemas the backend validates and serves with
 * (@bugbusterhq/types), so the documented Issue / Event / LogEntry can't drift from the real ones.
 * The paths are written by hand; test/unit/openapi.test.ts fails if a registered route is missing
 * from them, or if the committed copy is stale.
 */

/** zod → JSON Schema (2020-12-compatible, which is what OpenAPI 3.1 uses), inlined, no `$schema`. */
function schemaOf(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errorResponse = (description: string, example: string) => ({
  description,
  content: { "application/json": { schema: ref("Error"), example: { error: example } } },
});

const unauthorized = errorResponse("Missing or unknown API key.", "invalid api key");

const cursorParam = {
  name: "cursor",
  in: "query",
  required: false,
  description:
    "Opaque token from a previous response's `nextCursor`. Omit for the first page. Never " +
    "construct or parse it client-side.",
  schema: { type: "string" },
};

const fingerprintParam = {
  name: "fingerprint",
  in: "path",
  required: true,
  description: "The issue's fingerprint, as returned in `GET /issues`.",
  schema: { type: "string" },
};

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "BugBuster API",
      version: "1",
      description:
        "Ingest and Query API of the BugBuster backend.\n\n" +
        "Every route except `/openapi.json`, `/docs` and the admin routes needs your " +
        "organization's API key as `Authorization: Bearer <apiKey>`. The key decides which " +
        "organization's database a request reads or writes — there is no way to address another " +
        "organization's data. Admin routes take the backend's `BUGBUSTER_ADMIN_TOKEN` instead.\n\n" +
        "You normally never call `POST /ingest` yourself: the SDK (`@bugbusterhq/sdk-node`) or the " +
        "Agent does. The `GET` routes are what the dashboard uses, and are safe to script against.",
    },
    // Only a local default here: every deployment is someone's own. The copy a backend serves at
    // /openapi.json additionally lists itself ("/") first.
    servers: [{ url: "http://localhost:8080", description: "Local development" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Issues", description: "Folded errors: one issue per fingerprint." },
      { name: "Logs", description: "Application log lines, stored one by one." },
      { name: "Ingest", description: "Where the SDK and Agent send data." },
      { name: "Admin", description: "Operator-only: needs the backend's admin token." },
      { name: "Meta", description: "This API description." },
    ],
    paths: {
      "/issues": {
        get: {
          tags: ["Issues"],
          operationId: "listIssues",
          summary: "List issues, most recently seen first",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Issues per page. Values above 200 are capped at 200.",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
            cursorParam,
          ],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["issues"],
                properties: {
                  issues: { type: "array", items: ref("Issue") },
                  nextCursor: {
                    type: "string",
                    description: "Present only when more issues remain.",
                  },
                },
              },
              "A page of issues.",
            ),
            "400": errorResponse("The cursor is not valid.", "invalid cursor"),
            "401": unauthorized,
          },
        },
      },
      "/issues/{fingerprint}": {
        get: {
          tags: ["Issues"],
          operationId: "getIssue",
          summary: "Get one issue",
          parameters: [fingerprintParam],
          responses: {
            "200": json(ref("Issue"), "The issue."),
            "401": unauthorized,
            "404": errorResponse(
              "No such fingerprint in your organization (also returned when it exists only in " +
                "another organization).",
              "not found",
            ),
          },
        },
      },
      "/issues/{fingerprint}/exemplars": {
        get: {
          tags: ["Issues"],
          operationId: "getIssueExemplars",
          summary: "Get an issue's full example events",
          description:
            "The handful of complete events kept for an issue (first, last, slowest, one per " +
            "release, one novel stack), in the order of the issue's `exemplarRefs`.",
          parameters: [fingerprintParam],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["exemplars"],
                properties: { exemplars: { type: "array", items: ref("Event") } },
              },
              "The example events.",
            ),
            "401": unauthorized,
            "404": errorResponse("No such fingerprint in your organization.", "not found"),
          },
        },
      },
      "/logs": {
        get: {
          tags: ["Logs"],
          operationId: "queryLogs",
          summary: "Search log lines, newest first",
          description:
            "All filters are optional and combine with AND. Paginate by passing `nextCursor` back " +
            "as `cursor` with the same filters.",
          parameters: [
            {
              name: "level",
              in: "query",
              required: false,
              description: "Comma-separated levels to include, e.g. `warn,error`.",
              schema: { type: "string", example: "warn,error" },
            },
            {
              name: "q",
              in: "query",
              required: false,
              description: "Case-insensitive substring of the message (first 200 characters used).",
              schema: { type: "string" },
            },
            {
              name: "service",
              in: "query",
              required: false,
              description: "Exact service name (`service.name`).",
              schema: { type: "string" },
            },
            {
              name: "environment",
              in: "query",
              required: false,
              description: "Exact environment (`service.environment`).",
              schema: { type: "string" },
            },
            {
              name: "traceId",
              in: "query",
              required: false,
              description: "Only lines from this trace — everything one request logged.",
              schema: { type: "string" },
            },
            {
              name: "from",
              in: "query",
              required: false,
              description: "Earliest timestamp, inclusive (ISO 8601).",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "to",
              in: "query",
              required: false,
              description: "Latest timestamp, inclusive (ISO 8601). Must not be before `from`.",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Lines per page. Values above 500 are capped at 500.",
              schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            },
            cursorParam,
          ],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["logs"],
                properties: {
                  logs: { type: "array", items: ref("LogEntry") },
                  nextCursor: {
                    type: "string",
                    description: "Present only when more lines remain.",
                  },
                },
              },
              "A page of log lines.",
            ),
            "400": errorResponse(
              "A filter is malformed (unknown level, unparseable date, `from` after `to`, bad cursor).",
              "invalid level: fatal",
            ),
            "401": unauthorized,
          },
        },
      },
      "/logs/facets": {
        get: {
          tags: ["Logs"],
          operationId: "getLogFacets",
          summary: "Distinct services and environments",
          description:
            "For filter dropdowns. Cached per organization for up to 60 seconds, so a brand-new " +
            "service can take a minute to appear.",
          responses: {
            "200": json(
              {
                type: "object",
                required: ["services", "environments"],
                properties: {
                  services: { type: "array", items: { type: "string" } },
                  environments: { type: "array", items: { type: "string" } },
                },
              },
              "Sorted distinct values.",
            ),
            "401": unauthorized,
          },
        },
      },
      "/ingest": {
        post: {
          tags: ["Ingest"],
          operationId: "ingest",
          summary: "Send a batch of telemetry (used by the SDK and Agent)",
          description:
            "The body is NDJSON: one `EnvelopeItem` JSON object per line. Items of type `fold` and " +
            "`exemplar` become issues, `log` items are stored as log lines (invalid ones are " +
            "dropped individually), and `meta` items carry drop counters. Re-sending a batch is " +
            "safe for logs (deduplicated by `logId`).\n\n" +
            "The response headers are backpressure directives the sender should obey.",
          parameters: [
            {
              name: "Content-Encoding",
              in: "header",
              required: false,
              description: "`zstd` when the body is zstd-compressed (the Agent always compresses).",
              schema: { type: "string", enum: ["zstd"] },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/x-ndjson": {
                schema: { type: "string", description: "One `EnvelopeItem` per line." },
                example:
                  '{"type":"log","priority":1,"payload":{"logId":"01J9Z0000000000000000000AB",' +
                  '"timestamp":"2026-10-30T09:00:00.000Z","level":"info","message":"order placed",' +
                  '"fields":{"orderId":"o_1042"},"service":{"name":"orders-api","version":"1.4.2",' +
                  '"environment":"production"}}}\n',
              },
            },
          },
          responses: {
            "202": {
              description: "Accepted.",
              headers: {
                [HEADER_SAMPLE_DIRECTIVE]: {
                  description: "Sample rates (0–1) the sender should apply per data type.",
                  schema: { type: "string", contentMediaType: "application/json" },
                  example: '{"error":1,"log":1,"span":1}',
                },
                [HEADER_SUPPRESS_FINGERPRINTS]: {
                  description: "JSON array of fingerprints to send counts for but no examples.",
                  schema: { type: "string", contentMediaType: "application/json" },
                  example: "[]",
                },
                [HEADER_CONFIG_VERSION]: {
                  description: "Changes whenever the directives change.",
                  schema: { type: "string" },
                },
                [HEADER_RETRY_AFTER]: {
                  description: "Seconds to wait before sending again. Only present when set.",
                  schema: { type: "string" },
                },
              },
            },
            "401": unauthorized,
            "413": {
              description: "The body is larger than the backend's limit (2 MB by default).",
            },
          },
        },
      },
      "/admin/orgs": {
        post: {
          tags: ["Admin"],
          operationId: "createOrg",
          summary: "Create an organization and its API key",
          description:
            "Creates the organization (its data goes to its own database, " +
            "`bugbuster_org_<orgId>`) and returns its new API key. **The key is shown only in " +
            "this response**: only a hash is stored, so it can't be retrieved later.\n\n" +
            "Needs the backend's `BUGBUSTER_ADMIN_TOKEN` as the bearer token. When the backend " +
            "has no admin token configured, this route answers `404`.",
          security: [{ adminToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["orgId", "name"],
                  properties: {
                    orgId: {
                      type: "string",
                      pattern: "^[a-z0-9][a-z0-9_-]{0,39}$",
                      description: "Permanent id; also names the org's database.",
                    },
                    name: { type: "string", minLength: 1, maxLength: 200 },
                  },
                },
                example: { orgId: "acme", name: "Acme Corp" },
              },
            },
          },
          responses: {
            "201": json(
              {
                type: "object",
                required: ["orgId", "name", "dbName", "apiKey"],
                properties: {
                  orgId: { type: "string" },
                  name: { type: "string" },
                  dbName: { type: "string" },
                  apiKey: {
                    type: "string",
                    description: "Give this to the organization. It is not shown again.",
                  },
                },
              },
              "Created.",
            ),
            "400": errorResponse("`orgId` or `name` is invalid.", "name must be 1-200 characters"),
            "401": errorResponse("Missing or wrong admin token.", "invalid admin token"),
            "404": errorResponse(
              "Admin routes are disabled (no admin token configured).",
              "not found",
            ),
            "409": errorResponse(
              "The orgId, or its database name, is already taken.",
              "an org with this id or database already exists",
            ),
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["Meta"],
          operationId: "getOpenApi",
          summary: "This API description (OpenAPI 3.1)",
          security: [],
          responses: { "200": json({ type: "object" }, "The OpenAPI document.") },
        },
      },
      "/docs": {
        get: {
          tags: ["Meta"],
          operationId: "getDocs",
          summary: "Interactive API docs (Swagger UI)",
          security: [],
          responses: {
            "200": {
              description: "An HTML page.",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        adminToken: {
          type: "http",
          scheme: "bearer",
          description: "The backend's BUGBUSTER_ADMIN_TOKEN. Only for admin routes.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Your organization's API key.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        Issue: {
          description:
            "One folded error. `fidelity.isExact` is false when sampling was applied, i.e. " +
            "`count` is a weighted estimate rather than an exact count.",
          allOf: [
            schemaOf(IssueSchema),
            {
              type: "object",
              required: ["fidelity"],
              properties: {
                fidelity: {
                  type: "object",
                  required: ["isExact", "adjustedCount"],
                  properties: {
                    isExact: { type: "boolean" },
                    adjustedCount: { type: "number" },
                  },
                },
              },
            },
          ],
        },
        Event: {
          description: "One complete example event (exemplar) kept for an issue.",
          ...schemaOf(BugBusterEventSchema),
        },
        LogEntry: { description: "One application log line.", ...schemaOf(LogEntrySchema) },
        EnvelopeItem: {
          description: "One line of an ingest body.",
          ...schemaOf(EnvelopeItemSchema),
        },
        SampleDirective: schemaOf(SampleDirectiveSchema),
      },
    },
  };
}

/** Swagger UI, loaded from a pinned CDN build, pointed at this server's own /openapi.json. */
export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BugBuster API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "./openapi.json",
      dom_id: "#swagger-ui",
      persistAuthorization: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>
`;
