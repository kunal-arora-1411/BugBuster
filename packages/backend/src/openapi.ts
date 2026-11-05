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
const orgDisabled = errorResponse(
  "The organization has been disabled by an operator. Nothing to retry; ask them to enable it.",
  "organization is disabled",
);

const cursorParam = {
  name: "cursor",
  in: "query",
  required: false,
  description:
    "Opaque token from a previous response's `nextCursor`. Omit for the first page. Never " +
    "construct or parse it client-side.",
  schema: { type: "string" },
};

const adminUnauthorized = errorResponse("Missing or wrong admin token.", "invalid admin token");
const adminDisabled = errorResponse(
  "Admin routes are disabled (no admin token configured).",
  "not found",
);
const orgIdParam = { name: "orgId", in: "path", required: true, schema: { type: "string" } };

const retentionDaysSchema = {
  type: "integer",
  minimum: 0,
  maximum: 3650,
  description:
    "Days to keep this organization's log lines; 0 keeps them forever. Omit for the backend's default.",
};

const collectionStorageSchema = {
  type: "object",
  required: ["documents", "dataBytes", "storageBytes", "indexBytes"],
  properties: {
    documents: { type: "integer" },
    dataBytes: { type: "integer", description: "Uncompressed size of the documents." },
    storageBytes: { type: "integer", description: "Size on disk of the documents, compressed." },
    indexBytes: { type: "integer", description: "Size on disk of the indexes." },
    compression: { type: "string", description: "zstd, snappy, zlib or none." },
  },
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
      { name: "Internal", description: "For schedulers: needs the backend's cron secret." },
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
            {
              name: "service",
              in: "query",
              required: false,
              description: "Only issues seen in this service (the SDK's `project`).",
              schema: { type: "string" },
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
            "403": orgDisabled,
          },
        },
      },
      "/issues/facets": {
        get: {
          tags: ["Issues"],
          operationId: "getIssueFacets",
          summary: "Distinct services issues were seen in",
          description: "For the Issues view's service filter.",
          responses: {
            "200": json(
              {
                type: "object",
                required: ["services"],
                properties: { services: { type: "array", items: { type: "string" } } },
              },
              "Sorted distinct service names.",
            ),
            "401": unauthorized,
            "403": orgDisabled,
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
            "403": orgDisabled,
            "404": errorResponse(
              "No such fingerprint in your organization (also returned when it exists only in " +
                "another organization).",
              "not found",
            ),
          },
        },
      },
      "/issues/{fingerprint}/causes": {
        get: {
          tags: ["Issues"],
          operationId: "getIssueCauses",
          summary: "Get an issue's causes, effects and root cause",
          description:
            "Cause and effect across services. When a service answers another traced service " +
            "with a 5xx, it names the issue it failed with (the `X-BB-Cause` response header), " +
            "and the caller's later errors in that request are counted against it. `causedBy` " +
            "lists the issues that failed first, downstream, when this one happened; `caused` " +
            "the issues this one led to upstream; both strongest first, at most 20. `share` is " +
            "how much of the effect a link explains (link count / effect count). `rootCause` " +
            "follows the strongest cause while its share is at least 0.5, and is null when this " +
            "issue is not a symptom of another.",
          parameters: [fingerprintParam],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["rootCause", "causedBy", "caused"],
                properties: {
                  rootCause: {
                    oneOf: [
                      {
                        type: "object",
                        required: ["issue", "path"],
                        properties: {
                          issue: ref("Issue"),
                          path: {
                            type: "array",
                            items: { type: "string" },
                            description: "Fingerprints walked, this issue first, the root last.",
                          },
                        },
                      },
                      { type: "null" },
                    ],
                  },
                  causedBy: { type: "array", items: ref("CauseEntry") },
                  caused: { type: "array", items: ref("CauseEntry") },
                },
              },
              "The issue's neighbourhood in the cause graph.",
            ),
            "401": unauthorized,
            "403": orgDisabled,
            "404": errorResponse("No such fingerprint in your organization.", "not found"),
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
            "403": orgDisabled,
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
            "403": orgDisabled,
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
            "403": orgDisabled,
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
            "403": orgDisabled,
            "413": {
              description: "The body is larger than the backend's limit (2 MB by default).",
            },
          },
        },
      },
      "/admin/orgs": {
        get: {
          tags: ["Admin"],
          operationId: "listOrgs",
          summary: "List organizations with their status and keys",
          description:
            "Every organization with its status, the log retention in effect, and its keys (names, " +
            "dates and last use; never the keys themselves or their hashes).",
          security: [{ adminToken: [] }],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["orgs", "emailAlerts"],
                properties: {
                  orgs: { type: "array", items: ref("AdminOrg") },
                  emailAlerts: {
                    type: "object",
                    required: ["configured"],
                    description: "Whether this backend can send alert emails, and from where.",
                    properties: {
                      configured: { type: "boolean" },
                      from: { type: "string", format: "email" },
                    },
                  },
                },
              },
              "The organizations, sorted by id.",
            ),
            "401": adminUnauthorized,
            "404": adminDisabled,
          },
        },
        post: {
          tags: ["Admin"],
          operationId: "createOrg",
          summary: "Create an organization and its first API key",
          description:
            "Creates the organization (its data goes to its own database, " +
            "`bugbuster_org_<orgId>`) and its first named key, and returns that key. **The key is " +
            "shown only in this response**: only a hash is stored, so it can't be retrieved later.\n\n" +
            "Needs the backend's `BUGBUSTER_ADMIN_TOKEN` as the bearer token. When the backend " +
            "has no admin token configured, the admin routes answer `404`.",
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
                    logRetentionDays: retentionDaysSchema,
                    keyName: {
                      type: "string",
                      minLength: 1,
                      maxLength: 100,
                      description: 'Name of the first key. Default "Default key".',
                    },
                  },
                },
                example: { orgId: "acme", name: "Acme Corp", keyName: "checkout-api production" },
              },
            },
          },
          responses: {
            "201": json(
              {
                type: "object",
                required: ["orgId", "name", "dbName", "apiKey", "keyId"],
                properties: {
                  orgId: { type: "string" },
                  name: { type: "string" },
                  dbName: { type: "string" },
                  keyId: { type: "string" },
                  apiKey: {
                    type: "string",
                    description: "Give this to the organization. It is not shown again.",
                  },
                  logRetentionDays: {
                    type: "integer",
                    description: "Present only when the org was created with its own retention.",
                  },
                },
              },
              "Created.",
            ),
            "400": errorResponse(
              "`orgId`, `name`, `logRetentionDays` or `keyName` is invalid.",
              "name must be 1-200 characters",
            ),
            "401": adminUnauthorized,
            "404": adminDisabled,
            "409": errorResponse(
              "The orgId, or its database name, is already taken.",
              "an org with this id or database already exists",
            ),
          },
        },
      },
      "/admin/orgs/{orgId}": {
        patch: {
          tags: ["Admin"],
          operationId: "updateOrg",
          summary: "Rename, change retention, or disable an organization",
          description:
            "Send any of these:\n\n" +
            "- `name`: the display name.\n" +
            "- `logRetentionDays`: days to keep log lines (`0` keeps them forever), or `null` to use " +
            "the backend's `BUGBUSTER_LOG_RETENTION_DAYS`. Applied to the organization's retention " +
            "index immediately, for every backend process.\n" +
            "- `disabled`: `true` refuses every request with the organization's keys (`403 " +
            "organization is disabled`) until it is set back to `false`. Data is kept. Takes effect " +
            "within a minute on every backend instance.",
          security: [{ adminToken: [] }],
          parameters: [orgIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  minProperties: 1,
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 200 },
                    logRetentionDays: { ...retentionDaysSchema, type: ["integer", "null"] },
                    disabled: { type: "boolean" },
                  },
                },
                example: { logRetentionDays: 30 },
              },
            },
          },
          responses: {
            "200": json(ref("AdminOrg"), "The organization now."),
            "400": errorResponse(
              "Nothing to change, or a value is invalid.",
              "logRetentionDays must be a whole number from 0 (keep forever) to 3650",
            ),
            "401": adminUnauthorized,
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
            ),
          },
        },
      },
      "/admin/orgs/{orgId}/alerts": {
        put: {
          tags: ["Admin"],
          operationId: "setOrgAlerts",
          summary: "Set an organization's email alerts",
          description:
            "Replaces the organization's alert settings. When alerts are on, each recipient gets an " +
            "email when one of the organization's services reports an error BugBuster hasn't seen " +
            "before; new errors that arrive together share one email, and at most " +
            "`BUGBUSTER_ALERTS_MAX_PER_HOUR` emails go out per hour (the rest wait and go together).\n\n" +
            "- `services` / `environments`: only issues seen in one of these. Empty = all.\n" +
            "- Switching alerts on starts from now: issues that appeared while they were off are " +
            "not emailed.\n\n" +
            "Settings can be saved before the backend is set up to send email " +
            "(`emailAlerts.configured` in `GET /admin/orgs`); they apply once it is.",
          security: [{ adminToken: [] }],
          parameters: [orgIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["enabled"],
                  properties: {
                    enabled: { type: "boolean" },
                    recipients: {
                      type: "array",
                      maxItems: 20,
                      items: { type: "string", format: "email" },
                      description: "Required (at least one) when `enabled` is true.",
                    },
                    services: { type: "array", maxItems: 50, items: { type: "string" } },
                    environments: { type: "array", maxItems: 50, items: { type: "string" } },
                    includeStack: {
                      type: "boolean",
                      default: true,
                      description: "Whether emails include the top of the stack trace.",
                    },
                  },
                },
                example: {
                  enabled: true,
                  recipients: ["dev@example.com"],
                  environments: ["production"],
                },
              },
            },
          },
          responses: {
            "200": json(ref("AdminOrg"), "The organization now."),
            "400": errorResponse(
              "A value is invalid.",
              "add at least one recipient to switch alerts on",
            ),
            "401": adminUnauthorized,
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
            ),
          },
        },
      },
      "/admin/orgs/{orgId}/alerts/test": {
        post: {
          tags: ["Admin"],
          operationId: "testOrgAlerts",
          summary: "Send a test alert email",
          description: "Sends a test email to the organization's saved recipients.",
          security: [{ adminToken: [] }],
          parameters: [orgIdParam],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["sentTo"],
                properties: { sentTo: { type: "integer", description: "Recipients emailed." } },
              },
              "Sent.",
            ),
            "400": errorResponse("No recipients saved yet.", "save at least one recipient first"),
            "401": adminUnauthorized,
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
            ),
            "409": errorResponse(
              "This backend has no email provider configured.",
              "email alerts are not set up on this backend: set BUGBUSTER_BREVO_API_KEY and BUGBUSTER_ALERTS_FROM",
            ),
            "502": errorResponse(
              "Brevo refused the email; the message says why.",
              "Brevo refused the email (HTTP 401: Key not found)",
            ),
          },
        },
      },
      "/admin/orgs/{orgId}/keys": {
        post: {
          tags: ["Admin"],
          operationId: "createKey",
          summary: "Create another API key for an organization",
          description:
            "Give each service or person its own key, so one can be revoked without affecting the " +
            "others. **The key is shown only in this response.**",
          security: [{ adminToken: [] }],
          parameters: [orgIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
                },
                example: { name: "orders-worker production" },
              },
            },
          },
          responses: {
            "201": json(
              {
                allOf: [
                  ref("ApiKeyInfo"),
                  {
                    type: "object",
                    required: ["apiKey"],
                    properties: { apiKey: { type: "string", description: "Not shown again." } },
                  },
                ],
              },
              "Created.",
            ),
            "400": errorResponse("`name` is missing or invalid.", "name must be 1-100 characters"),
            "401": adminUnauthorized,
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
            ),
          },
        },
      },
      "/admin/orgs/{orgId}/keys/{keyId}": {
        delete: {
          tags: ["Admin"],
          operationId: "revokeKey",
          summary: "Revoke one API key",
          description:
            "Requests with this key get `401 invalid api key` from now on, within a minute on every " +
            "backend instance. The organization's other keys keep working. The key stays listed, " +
            "marked revoked. Revoking twice is harmless.",
          security: [{ adminToken: [] }],
          parameters: [
            orgIdParam,
            { name: "keyId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": json(ref("ApiKeyInfo"), "The key, now revoked."),
            "401": adminUnauthorized,
            "404": errorResponse("No such key in this organization.", "no such key"),
          },
        },
      },
      "/admin/maintenance/cleanup-events": {
        post: {
          tags: ["Admin"],
          operationId: "cleanupEvents",
          summary: "Delete example events no issue uses",
          description:
            "Backends before the exemplar fix stored example events past each issue's six; they " +
            "take space and are never shown. This deletes them (events written in the last ten " +
            "minutes are left alone). `dryRun: true` only counts.",
          security: [{ adminToken: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    dryRun: { type: "boolean", default: false },
                    orgId: { type: "string", description: "One organization only." },
                  },
                },
                example: { dryRun: true },
              },
            },
          },
          responses: {
            "200": json(
              {
                type: "object",
                required: ["dryRun", "total", "orgs"],
                properties: {
                  dryRun: { type: "boolean" },
                  total: { type: "integer" },
                  orgs: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { orgId: { type: "string" }, events: { type: "integer" } },
                    },
                  },
                },
              },
              "Counted, or deleted.",
            ),
            "401": adminUnauthorized,
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
            ),
          },
        },
      },
      "/admin/events": {
        get: {
          tags: ["Admin"],
          operationId: "listAdminEvents",
          summary: "The admin change history",
          description: "Changes made through the admin routes, newest first.",
          security: [{ adminToken: [] }],
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["events"],
                properties: {
                  events: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["at", "action"],
                      properties: {
                        at: { type: "string", format: "date-time" },
                        action: {
                          type: "string",
                          example: "key.revoked",
                          description:
                            "org.created, org.renamed, org.retention_changed, org.disabled, " +
                            "org.enabled, key.created, key.revoked or events.cleaned_up.",
                        },
                        orgId: { type: "string" },
                        detail: { type: "string" },
                      },
                    },
                  },
                },
              },
              "The history.",
            ),
            "401": adminUnauthorized,
            "404": adminDisabled,
          },
        },
      },
      "/internal/alerts/run": {
        get: {
          tags: ["Internal"],
          operationId: "runAlerts",
          summary: "Send pending alert emails",
          description:
            "Sends every organization's pending alerts. Alerts normally go out right after the " +
            "ingest that created the issue; this catches any that had to wait (the hourly cap, a " +
            "failed send). For a scheduler: Vercel Cron (which calls it with `GET` and sends " +
            "`CRON_SECRET`), GitHub Actions, cron-job.org. Off (404) unless " +
            "`BUGBUSTER_CRON_SECRET` or `CRON_SECRET` is set.",
          security: [{ cronSecret: [] }],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["configured", "orgs", "emails", "alerted", "errors"],
                properties: {
                  configured: {
                    type: "boolean",
                    description: "False when this backend can't send email; nothing was sent.",
                  },
                  orgs: { type: "integer", description: "Organizations with alerts on." },
                  emails: { type: "integer" },
                  alerted: { type: "integer", description: "Issues those emails covered." },
                  errors: { type: "integer", description: "Organizations whose send failed." },
                },
              },
              "What was sent.",
            ),
            "401": errorResponse("Missing or wrong cron secret.", "invalid cron secret"),
            "404": errorResponse("No cron secret is configured.", "not found"),
          },
        },
        post: {
          tags: ["Internal"],
          operationId: "runAlertsPost",
          summary: "Send pending alert emails",
          description:
            "Sends every organization's pending alerts. Alerts normally go out right after the " +
            "ingest that created the issue; this catches any that had to wait (the hourly cap, a " +
            "failed send). For a scheduler: Vercel Cron (which calls it with `GET` and sends " +
            "`CRON_SECRET`), GitHub Actions, cron-job.org. Off (404) unless " +
            "`BUGBUSTER_CRON_SECRET` or `CRON_SECRET` is set.",
          security: [{ cronSecret: [] }],
          responses: {
            "200": json(
              {
                type: "object",
                required: ["configured", "orgs", "emails", "alerted", "errors"],
                properties: {
                  configured: {
                    type: "boolean",
                    description: "False when this backend can't send email; nothing was sent.",
                  },
                  orgs: { type: "integer", description: "Organizations with alerts on." },
                  emails: { type: "integer" },
                  alerted: { type: "integer", description: "Issues those emails covered." },
                  errors: { type: "integer", description: "Organizations whose send failed." },
                },
              },
              "What was sent.",
            ),
            "401": errorResponse("Missing or wrong cron secret.", "invalid cron secret"),
            "404": errorResponse("No cron secret is configured.", "not found"),
          },
        },
      },
      "/admin": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminPage",
          summary: "The admin page",
          description:
            "A web page to manage organizations, keys and storage, signed in with the admin " +
            "token. Answers `404` when no admin token is configured.",
          security: [],
          responses: {
            "200": {
              description: "An HTML page.",
              content: { "text/html": { schema: { type: "string" } } },
            },
            "404": adminDisabled,
          },
        },
      },
      "/admin/storage": {
        get: {
          tags: ["Admin"],
          operationId: "getStorageReport",
          summary: "How much each organization stores",
          description:
            "Per organization: documents, data size, size on disk and index size for logs, issues " +
            "and example events; the compressor each uses; log lines received per day for the last " +
            "7 days with their estimated size; and how many stored example events no issue " +
            "references (removed by `pnpm --filter @bugbusterhq/backend cleanup-events`). " +
            "Largest organization first. Read-only.",
          security: [{ adminToken: [] }],
          parameters: [
            {
              name: "orgId",
              in: "query",
              required: false,
              description: "Report on this organization only.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": json(ref("StorageReport"), "The report."),
            "401": errorResponse("Missing or wrong admin token.", "invalid admin token"),
            "404": errorResponse(
              "No such organization, or admin routes are disabled.",
              "no such org",
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
        cronSecret: {
          type: "http",
          scheme: "bearer",
          description: "The backend's BUGBUSTER_CRON_SECRET (or CRON_SECRET on Vercel).",
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
        CauseEntry: {
          type: "object",
          required: ["issue", "count", "share"],
          properties: {
            issue: ref("Issue"),
            count: { type: "integer", description: "Occurrences of the effect after the cause." },
            share: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        LogEntry: { description: "One application log line.", ...schemaOf(LogEntrySchema) },
        EnvelopeItem: {
          description: "One line of an ingest body.",
          ...schemaOf(EnvelopeItemSchema),
        },
        SampleDirective: schemaOf(SampleDirectiveSchema),
        ApiKeyInfo: {
          type: "object",
          required: ["keyId", "orgId", "name", "createdAt"],
          properties: {
            keyId: { type: "string" },
            orgId: { type: "string" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: {
              type: "string",
              format: "date-time",
              description: "Updated at most about once an hour.",
            },
            revokedAt: { type: "string", format: "date-time" },
          },
        },
        AdminOrg: {
          type: "object",
          required: [
            "orgId",
            "name",
            "dbName",
            "createdAt",
            "disabled",
            "logRetentionDays",
            "retentionOverridden",
            "keys",
            "alerts",
          ],
          properties: {
            orgId: { type: "string" },
            name: { type: "string" },
            dbName: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            disabled: { type: "boolean" },
            disabledAt: { type: "string", format: "date-time" },
            logRetentionDays: { type: "integer", description: "The retention in effect." },
            retentionOverridden: {
              type: "boolean",
              description: "False when the backend's default applies.",
            },
            keys: { type: "array", items: ref("ApiKeyInfo") },
            alerts: ref("AdminOrgAlerts"),
          },
        },
        AdminOrgAlerts: {
          type: "object",
          required: [
            "enabled",
            "recipients",
            "services",
            "environments",
            "includeStack",
            "sentLastHour",
          ],
          properties: {
            enabled: { type: "boolean" },
            recipients: { type: "array", items: { type: "string", format: "email" } },
            services: { type: "array", items: { type: "string" }, description: "Empty = all." },
            environments: {
              type: "array",
              items: { type: "string" },
              description: "Empty = all.",
            },
            includeStack: { type: "boolean" },
            since: {
              type: "string",
              format: "date-time",
              description: "When alerts were switched on; older issues never alert.",
            },
            sentLastHour: { type: "integer" },
            lastSentAt: { type: "string", format: "date-time" },
            lastError: { type: "string", description: "Why the last send failed, if it did." },
            lastErrorAt: { type: "string", format: "date-time" },
          },
        },
        StorageReport: {
          type: "object",
          required: ["generatedAt", "defaultLogRetentionDays", "totalBytes", "orgs"],
          properties: {
            generatedAt: { type: "string", format: "date-time" },
            defaultLogRetentionDays: { type: "integer" },
            totalBytes: { type: "integer", description: "Disk used by every organization listed." },
            orgs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  orgId: { type: "string" },
                  name: { type: "string" },
                  dbName: { type: "string" },
                  logRetentionDays: { type: "integer" },
                  retentionOverridden: { type: "boolean" },
                  collections: {
                    type: "object",
                    properties: {
                      logs: collectionStorageSchema,
                      issues: collectionStorageSchema,
                      events: collectionStorageSchema,
                    },
                  },
                  totalBytes: { type: "integer", description: "Disk plus index bytes." },
                  logsPerDay: {
                    type: "array",
                    description: "Last 7 UTC days, oldest first.",
                    items: {
                      type: "object",
                      properties: {
                        date: { type: "string", format: "date" },
                        lines: { type: "integer" },
                        estimatedBytes: { type: "integer" },
                      },
                    },
                  },
                  unreferencedEvents: { type: "integer" },
                },
              },
            },
          },
        },
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
