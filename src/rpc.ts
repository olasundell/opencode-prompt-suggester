import { Rpc } from "@opencode/plugin/rpc"
import type { GhostAcceptKey } from "./domain/config.ts"
import type { LiveSuggestionStatus } from "./domain/suggestion.ts"

export interface SuggestionSnapshot {
  sessionID: string
  suggestion: string
  status: LiveSuggestionStatus
  enabled: boolean
  updatedAt: string
  revision: string
  ghostAcceptKeys: GhostAcceptKey[]
}

export interface SuggesterStatus {
  enabled: boolean
  suggesterModel: string
  seedReady: boolean
  suggestion: string
  status: LiveSuggestionStatus
  ghostAcceptKeys: GhostAcceptKey[]
}

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
  additionalProperties: false,
} as const
const acceptKeys = { type: "array", items: { type: "string", enum: ["space", "right"] } } as const
const status = { type: "string", enum: ["pending", "ready", "none"] } as const
const snapshotOutput = {
  type: "object",
  properties: {
    sessionID: { type: "string" }, suggestion: { type: "string" }, status,
    enabled: { type: "boolean" }, updatedAt: { type: "string" }, revision: { type: "string" }, ghostAcceptKeys: acceptKeys,
  },
  required: ["sessionID", "suggestion", "status", "enabled", "updatedAt", "revision", "ghostAcceptKeys"],
  additionalProperties: false,
} as const
const statusOutput = {
  type: "object",
  properties: {
    enabled: { type: "boolean" }, suggesterModel: { type: "string" }, seedReady: { type: "boolean" },
    suggestion: { type: "string" }, status, ghostAcceptKeys: acceptKeys,
  },
  required: ["enabled", "suggesterModel", "seedReady", "suggestion", "status", "ghostAcceptKeys"],
  additionalProperties: false,
} as const

export const PromptSuggester = Rpc.define({
  id: "prompt-suggester",
  events: {},
  methods: {
    get: { input: sessionInput, output: snapshotOutput },
    refresh: { input: sessionInput, output: snapshotOutput },
    clear: {
      input: { ...sessionInput, properties: { ...sessionInput.properties, revision: { type: "string" } } },
      output: snapshotOutput,
    },
    status: { input: sessionInput, output: statusOutput },
    configure: {
      input: {
        ...sessionInput,
        properties: { ...sessionInput.properties, enabled: { type: "boolean" } },
        required: ["sessionID", "enabled"],
      },
      output: statusOutput,
    },
    reseed: { input: sessionInput, output: statusOutput },
  },
})
